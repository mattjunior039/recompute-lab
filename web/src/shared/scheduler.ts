// Recompute scheduler: pull-based work stealing with adaptive chunk sizing,
// leases with timeout/retry, and ~5% redundant spot-checks.
//
// Pure logic (no I/O) so it can be unit-tested, used by the Hub, and reused by a
// Node in solo mode when the Hub is unreachable. Persistence hooks are events.

export interface ChunkPolicy {
  initial: number; // items per lease before we know a device's speed
  min: number;
  max: number;
  targetSec: number; // aim for leases that take about this long
  guessSecPerItem: number; // used for the first lease timeout
}

export interface JobSpec {
  id: string;
  kernel: string;
  params?: Record<string, unknown>;
  total: number;
  eligible?: string[] | null; // node ids allowed to work on this job (null = everyone)
  chunk?: Partial<ChunkPolicy>;
  spotCheck?: boolean;
  done?: Map<number, { output: unknown; nodeId: string }>; // restored results (after a Hub restart)
}

export interface Lease {
  id: string;
  jobId: string;
  nodeId: string;
  kernel: string;
  params: Record<string, unknown>;
  items: number[];
  verify: boolean;
  issuedAt: number;
  expiresAt: number;
}

export interface SpotCheck {
  items: number[];
  nodeA: string;
  nodeB: string;
  agree: boolean;
  at: number;
}

interface VerifyTask {
  items: number[];
  originNode: string;
  outputs: unknown[];
}

export class Job {
  readonly id: string;
  readonly kernel: string;
  readonly params: Record<string, unknown>;
  readonly total: number;
  readonly eligible: Set<string> | null;
  readonly chunk: ChunkPolicy;
  readonly spotCheck: boolean;
  status: 'running' | 'done' | 'cancelled' = 'running';
  pending: number[] = [];
  results: unknown[];
  doneBy: (string | undefined)[];
  doneCount = 0;
  failed = new Map<number, string>();
  attempts: Uint8Array;
  createdAt: number;
  finishedAt: number | null = null;
  verifyQueue: VerifyTask[] = [];
  spotChecks: SpotCheck[] = [];
  verifySkipped = 0;

  constructor(spec: JobSpec, now: number) {
    this.id = spec.id;
    this.kernel = spec.kernel;
    this.params = spec.params ?? {};
    this.total = spec.total;
    this.eligible = spec.eligible ? new Set(spec.eligible) : null;
    this.chunk = { initial: 2, min: 1, max: 64, targetSec: 2, guessSecPerItem: 2, ...spec.chunk };
    this.spotCheck = spec.spotCheck ?? true;
    this.results = new Array(spec.total);
    this.doneBy = new Array(spec.total);
    this.attempts = new Uint8Array(spec.total);
    this.createdAt = now;
    for (let i = 0; i < spec.total; i++) {
      const d = spec.done?.get(i);
      if (d) {
        this.results[i] = d.output;
        this.doneBy[i] = d.nodeId;
        this.doneCount++;
      } else this.pending.push(i);
    }
  }

  get finished() {
    return this.doneCount + this.failed.size >= this.total;
  }
}

export interface SchedulerOptions {
  now?: () => number;
  rng?: () => number;
  spotCheckRate?: number;
  leaseTtlMinMs?: number;
  leaseTtlFactor?: number;
  maxAttempts?: number;
  compare?: (kernel: string, a: unknown, b: unknown) => boolean;
}

export interface SchedulerEvents {
  onItems?: (job: Job, items: { i: number; output: unknown; nodeId: string }[], ms: number) => void;
  onJobDone?: (job: Job) => void;
  onSpotCheck?: (job: Job, check: SpotCheck) => void;
  onLeaseExpired?: (lease: Lease) => void;
  onItemFailed?: (job: Job, i: number, error: string) => void;
}

const EWMA = 0.35;
const LATE_RESULT_WINDOW_MS = 120_000;

export class Scheduler {
  readonly jobs = new Map<string, Job>();
  readonly leases = new Map<string, Lease>();
  private expired = new Map<string, Lease>();
  private verifyByLease = new Map<string, VerifyTask>();
  private secPerItem = new Map<string, number>(); // `${nodeId}|${kernel}` -> seconds per item per slot
  private seq = 0;
  private now: () => number;
  private rng: () => number;
  private opts: Required<Omit<SchedulerOptions, 'now' | 'rng'>>;

  constructor(opts: SchedulerOptions = {}, public events: SchedulerEvents = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.rng = opts.rng ?? Math.random;
    this.opts = {
      spotCheckRate: opts.spotCheckRate ?? 0.05,
      leaseTtlMinMs: opts.leaseTtlMinMs ?? 15_000,
      leaseTtlFactor: opts.leaseTtlFactor ?? 4,
      maxAttempts: opts.maxAttempts ?? 3,
      compare: opts.compare ?? ((_k, a, b) => JSON.stringify(a) === JSON.stringify(b)),
    };
  }

  createJob(spec: JobSpec): Job {
    if (this.jobs.has(spec.id)) throw new Error(`job ${spec.id} exists`);
    const job = new Job(spec, this.now());
    this.jobs.set(job.id, job);
    if (job.finished) this.finish(job);
    return job;
  }

  cancelJob(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'running') return;
    job.status = 'cancelled';
    job.finishedAt = this.now();
    for (const l of [...this.leases.values()]) if (l.jobId === jobId) this.leases.delete(l.id);
  }

  removeJob(jobId: string) {
    this.cancelJob(jobId);
    this.jobs.delete(jobId);
  }

  /** Measured seconds per item for one worker slot of a node (undefined until it reports). */
  speedOf(nodeId: string, kernel: string) {
    return this.secPerItem.get(`${nodeId}|${kernel}`);
  }

  /** A node has a free worker slot and asks for work. Returns one lease or null. */
  request(nodeId: string, kernels: readonly string[]): Lease | null {
    for (const job of this.jobs.values()) {
      if (job.status !== 'running' || !kernels.includes(job.kernel)) continue;
      if (job.eligible && !job.eligible.has(nodeId)) continue;
      // Spot-checks first: re-run a finished chunk on a *different* device.
      const vi = job.verifyQueue.findIndex((v) => v.originNode !== nodeId);
      if (vi >= 0) {
        const v = job.verifyQueue.splice(vi, 1)[0];
        const lease = this.issue(job, nodeId, v.items, true);
        this.verifyByLease.set(lease.id, v);
        return lease;
      }
      if (job.pending.length === 0) continue;
      const n = this.chunkSize(job, nodeId);
      return this.issue(job, nodeId, job.pending.splice(0, n), false);
    }
    return null;
  }

  chunkSize(job: Job, nodeId: string): number {
    const c = job.chunk;
    const spi = this.secPerItem.get(`${nodeId}|${job.kernel}`);
    let n = spi ? Math.round(c.targetSec / Math.max(spi, 1e-4)) : c.initial;
    n = Math.max(c.min, Math.min(c.max, n));
    // Guided tail: near the end, hand out smaller pieces so no device is left
    // finishing a big chunk while the others sit idle.
    let outstanding = 0;
    for (const l of this.leases.values()) if (l.jobId === job.id) outstanding++;
    const tailCap = Math.ceil(job.pending.length / (2 * (outstanding + 1)));
    n = Math.max(c.min, Math.min(n, tailCap));
    return Math.min(n, job.pending.length);
  }

  private issue(job: Job, nodeId: string, items: number[], verify: boolean): Lease {
    const now = this.now();
    const spi = this.secPerItem.get(`${nodeId}|${job.kernel}`) ?? job.chunk.guessSecPerItem;
    const ttl = Math.max(this.opts.leaseTtlMinMs, this.opts.leaseTtlFactor * spi * items.length * 1000 + 5000);
    const lease: Lease = {
      id: `L${++this.seq}-${now.toString(36)}`,
      jobId: job.id,
      nodeId,
      kernel: job.kernel,
      params: job.params,
      items,
      verify,
      issuedAt: now,
      expiresAt: now + ttl,
    };
    this.leases.set(lease.id, lease);
    return lease;
  }

  /** A node finished a lease. `ms` is the compute time it measured. */
  complete(leaseId: string, nodeId: string, outputs: unknown[], ms?: number) {
    let lease = this.leases.get(leaseId);
    let late = false;
    if (!lease) {
      lease = this.expired.get(leaseId);
      late = true;
    }
    if (!lease || lease.nodeId !== nodeId) return { accepted: 0, duplicates: 0, unknown: true };
    this.leases.delete(leaseId);
    this.expired.delete(leaseId);
    const job = this.jobs.get(lease.jobId);
    if (!job || outputs.length !== lease.items.length) return { accepted: 0, duplicates: 0, unknown: true };

    const elapsed = ms ?? this.now() - lease.issuedAt;
    if (lease.items.length > 0 && elapsed > 0) {
      const key = `${nodeId}|${job.kernel}`;
      const sample = elapsed / 1000 / lease.items.length;
      const prev = this.secPerItem.get(key);
      this.secPerItem.set(key, prev === undefined ? sample : prev * (1 - EWMA) + sample * EWMA);
    }

    if (lease.verify) {
      const v = this.verifyByLease.get(leaseId);
      this.verifyByLease.delete(leaseId);
      if (v) {
        const agree = v.outputs.every((o, k) => this.opts.compare(job.kernel, o, outputs[k]));
        const check: SpotCheck = { items: v.items, nodeA: v.originNode, nodeB: nodeId, agree, at: this.now() };
        job.spotChecks.push(check);
        this.events.onSpotCheck?.(job, check);
      }
      return { accepted: 0, duplicates: 0, unknown: false };
    }

    if (job.status === 'cancelled') return { accepted: 0, duplicates: lease.items.length, unknown: false };
    const accepted: { i: number; output: unknown; nodeId: string }[] = [];
    lease.items.forEach((i, k) => {
      if (job.results[i] !== undefined || job.failed.has(i)) return;
      job.results[i] = outputs[k];
      job.doneBy[i] = nodeId;
      job.doneCount++;
      accepted.push({ i, output: outputs[k], nodeId });
    });
    if (late && accepted.length) {
      const got = new Set(accepted.map((a) => a.i));
      job.pending = job.pending.filter((i) => !got.has(i));
    }
    if (accepted.length) this.events.onItems?.(job, accepted, elapsed);

    if (job.spotCheck && accepted.length && this.rng() < this.opts.spotCheckRate) {
      job.verifyQueue.push({ items: accepted.map((a) => a.i), originNode: nodeId, outputs: accepted.map((a) => a.output) });
    }
    if (job.status === 'running' && job.finished) this.finish(job);
    return { accepted: accepted.length, duplicates: lease.items.length - accepted.length, unknown: false };
  }

  /** The node reported an error running this lease: retry the items elsewhere. */
  fail(leaseId: string, nodeId: string, error: string) {
    const lease = this.leases.get(leaseId);
    if (!lease || lease.nodeId !== nodeId) return;
    this.leases.delete(leaseId);
    this.verifyByLease.delete(leaseId);
    this.returnItems(lease, true, error);
  }

  /** A node left (closed the tab, lost Wi-Fi, pressed Stop): give its work back. */
  releaseNode(nodeId: string, leaseIds?: string[]) {
    for (const l of [...this.leases.values()]) {
      if (l.nodeId !== nodeId || (leaseIds && !leaseIds.includes(l.id))) continue;
      this.leases.delete(l.id);
      this.verifyByLease.delete(l.id);
      this.returnItems(l, false, 'node left');
    }
  }

  /** Expire overdue leases. Call about once a second. */
  tick() {
    const now = this.now();
    for (const l of [...this.leases.values()]) {
      if (l.expiresAt > now) continue;
      this.leases.delete(l.id);
      this.verifyByLease.delete(l.id);
      this.expired.set(l.id, l);
      this.returnItems(l, true, 'lease timed out');
      this.events.onLeaseExpired?.(l);
    }
    for (const [id, l] of this.expired) if (now - l.expiresAt > LATE_RESULT_WINDOW_MS) this.expired.delete(id);
  }

  private returnItems(lease: Lease, countAttempt: boolean, error: string) {
    const job = this.jobs.get(lease.jobId);
    if (!job || job.status !== 'running' || lease.verify) return;
    const back: number[] = [];
    for (const i of lease.items) {
      if (job.results[i] !== undefined || job.failed.has(i)) continue;
      if (countAttempt && ++job.attempts[i] >= this.opts.maxAttempts) {
        job.failed.set(i, error);
        this.events.onItemFailed?.(job, i, error);
      } else back.push(i);
    }
    job.pending.unshift(...back);
    if (job.finished) this.finish(job);
  }

  private finish(job: Job) {
    job.status = 'done';
    job.finishedAt = this.now();
    job.verifySkipped += job.verifyQueue.length;
    job.verifyQueue = [];
    this.events.onJobDone?.(job);
  }

  progress(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    let leased = 0;
    for (const l of this.leases.values()) if (l.jobId === jobId && !l.verify) leased += l.items.length;
    const agree = job.spotChecks.filter((c) => c.agree).length;
    return {
      total: job.total,
      done: job.doneCount,
      failed: job.failed.size,
      pending: job.pending.length,
      leased,
      spotChecks: job.spotChecks.length,
      spotAgree: agree,
      spotDisagree: job.spotChecks.length - agree,
      spotItems: job.spotChecks.reduce((s, c) => s + c.items.length, 0),
      spotSkipped: job.verifySkipped + job.verifyQueue.length,
    };
  }

  leasesOf(nodeId: string) {
    return [...this.leases.values()].filter((l) => l.nodeId === nodeId);
  }
}
