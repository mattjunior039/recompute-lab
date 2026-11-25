// The Hub's live coordinator: talks to Nodes and Consoles over WebSocket,
// hands out work from the scheduler, runs federated-learning rounds, and
// keeps the Console's picture of the classroom up to date.

import crypto from 'node:crypto';
import type { WebSocket } from 'ws';
import type { DB } from './db';
import type { ModelStore } from './models';
import { FedSession } from './fedavg';
import { DEFAULT_QUESTIONS, labJob, RunTracker, compareOutputs } from './labs';
import { Scheduler, type Job } from '../../web/src/shared/scheduler';
import type {
  Capabilities,
  ConsoleCmd,
  ConsoleState,
  ExperimentView,
  HubToNode,
  Kernel,
  LabId,
  NodeStatus,
  NodeToHub,
  NodeView,
} from '../../web/src/shared/protocol';

type Pool = 'cpu' | 'llm';

interface NodeRec {
  id: string;
  name: string;
  ws: WebSocket | null;
  mode: 'join' | 'reborn';
  caps: Capabilities;
  status: NodeStatus;
  credits: Record<Pool, number>;
  kernels: Record<Pool, Kernel[]>;
  connectedAt: number;
  lastSeen: number;
  itemsSession: number;
  ip: string;
  host: boolean;
}

interface ConsoleConn {
  ws: WebSocket;
  canControl: boolean;
  isHost: boolean;
}

/** The Hub computer's own node (a hidden node page inside the Console on the Hub). */
export const HOST_NODE_ID = 'hubhost';

interface Experiment {
  id: string;
  lab: LabId;
  items: number;
  order: string[]; // node ids
  step: number;
  status: 'preparing' | 'running' | 'done' | 'cancelled';
  rows: ExperimentView['rows'];
  timer?: NodeJS.Timeout;
  prepUntil?: number;
}

export interface HubInfo {
  hubName: string;
  lanIp: string | null;
  addresses: string[];
  httpsPort: number;
  httpPort: number;
  caFingerprint: string;
  teacherKey: string;
  datasetCount: number;
  /** Name for the Hub computer's own node tile, e.g. "iMac 2020 (Hub)". */
  hostName?: string;
  /** Logical CPU threads on the Hub computer. */
  cpuThreads?: number;
}

const TYPE_LABEL: Record<string, string> = {
  chromebook: 'Chromebook',
  iphone: 'iPhone',
  ipad: 'iPad',
  android: 'Android',
  mac: 'Mac',
  windows: 'Windows PC',
  linux: 'Linux PC',
  other: 'Device',
};

const ROUND_TIMEOUT_MS = 45_000;
const AUTO_ROUNDS_MAX = 15;

export class Hub {
  readonly sched: Scheduler;
  readonly nodes = new Map<string, NodeRec>();
  private consoles = new Set<ConsoleConn>();
  run: RunTracker | null = null;
  lab: LabId | null = null;
  experiment: Experiment | null = null;
  fed: FedSession;
  fedAuto = false;
  private fedAutoCount = 0;
  private fedTimer: NodeJS.Timeout | null = null;
  room: string;
  demo: boolean;
  studentsCanLaunch: boolean;
  hostCompute: { on: boolean; workers: number };
  private timers: NodeJS.Timeout[] = [];
  private dirty = true;
  private consoleMsgs: { t: number; level: 'info' | 'warn'; text: string }[] = [];

  constructor(
    private db: DB,
    private models: ModelStore,
    public info: HubInfo,
    opts: { now?: () => number; rng?: () => number; tickMs?: number } = {},
  ) {
    this.sched = new Scheduler(
      { now: opts.now, rng: opts.rng, compare: compareOutputs },
      {
        onItems: (job, items, ms) => this.onItems(job, items, ms),
        onJobDone: (job) => this.onJobDone(job),
        onSpotCheck: (job, c) => {
          this.db.q.insertSpot.run(job.id, JSON.stringify(c.items), c.nodeA, c.nodeB, c.agree ? 1 : 0, c.at);
          if (!c.agree) this.say('warn', `Spot-check disagreement on ${job.kernel} items ${c.items.join(', ')} between ${this.nameOf(c.nodeA)} and ${this.nameOf(c.nodeB)}.`);
        },
        onItemFailed: (job, i, err) => this.say('warn', `Item ${i} of ${job.kernel} failed 3 times (${err}); skipped.`),
      },
    );
    this.room = db.get('room') ?? newRoom();
    db.set('room', this.room);
    this.demo = db.get('demo') === '1';
    this.studentsCanLaunch = db.get('studentsCanLaunch') !== '0';
    const hc = safeParse(db.get('hostCompute'));
    this.hostCompute = { on: hc?.on === true, workers: this.clampHostWorkers(Number(hc?.workers) || this.defaultHostWorkers()) };
    this.fed = new FedSession(db.get('fedSession') ?? `fed-${Date.now().toString(36)}`);
    db.set('fedSession', this.fed.id);
    this.restoreJobs();
    models.onChange = () => {
      this.broadcastNodes({ type: 'models', models: this.models.info() });
      this.dirty = true;
    };
    const tick = opts.tickMs ?? 500;
    this.timers.push(setInterval(() => this.tick(), tick));
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    if (this.fedTimer) clearTimeout(this.fedTimer);
    if (this.experiment?.timer) clearTimeout(this.experiment.timer);
  }

  // ---------- connections ----------

  /** Half the Hub's threads by default: the Hub and its Console need headroom to stay smooth on camera. */
  defaultHostWorkers() {
    return Math.max(1, Math.floor((this.info.cpuThreads ?? 4) / 2));
  }

  private clampHostWorkers(n: number) {
    return Math.max(1, Math.min(Math.max(1, (this.info.cpuThreads ?? 4) - 1), 16, Math.round(n)));
  }

  attachNode(ws: WebSocket, ip: string, loopback = false) {
    let nodeId: string | null = null;
    ws.on('message', (raw) => {
      let msg: NodeToHub;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === 'hello') {
        if (String(msg.room).trim() !== this.room) {
          send(ws, { type: 'error', message: 'That room code is not right. Check the 6-digit code on the Console.', fatal: true });
          ws.close(4001, 'room');
          return;
        }
        if (msg.host && !loopback) {
          send(ws, { type: 'error', message: 'Only the Hub computer itself can be the Hub node.', fatal: true });
          ws.close(4003, 'host');
          return;
        }
        nodeId = this.helloNode(ws, msg, ip);
        return;
      }
      if (!nodeId) return;
      const node = this.nodes.get(nodeId);
      if (!node || node.ws !== ws) return;
      node.lastSeen = Date.now();
      this.onNodeMsg(node, msg);
    });
    ws.on('close', () => {
      if (!nodeId) return;
      const node = this.nodes.get(nodeId);
      if (!node || node.ws !== ws) return;
      this.nodeGone(node);
    });
    ws.on('error', () => {});
  }

  private helloNode(ws: WebSocket, msg: Extract<NodeToHub, { type: 'hello' }>, ip: string): string {
    const now = Date.now();
    const host = msg.host === true;
    let id = host ? HOST_NODE_ID : typeof msg.nodeId === 'string' && /^[a-z0-9]{6,24}$/.test(msg.nodeId) && msg.nodeId !== HOST_NODE_ID ? msg.nodeId : '';
    const stored = id ? (this.db.q.nodeById.get(id) as { name: string } | undefined) : undefined;
    if (!id) id = crypto.randomBytes(6).toString('hex');
    const existing = this.nodes.get(id);
    if (existing?.ws && existing.ws !== ws) {
      // Same device opened a second tab or reconnected: the newest connection wins.
      this.sched.releaseNode(id);
      try {
        existing.ws.close(4002, 'replaced');
      } catch {}
    }
    const caps = sanitizeCaps(msg.caps);
    let name = stored?.name ?? existing?.name ?? (host ? (this.info.hostName ?? 'This computer (Hub)') : undefined);
    if (!name) {
      const label = TYPE_LABEL[caps.deviceType] ?? 'Device';
      const taken = new Set((this.db.q.allNodes.all() as { name: string }[]).map((n) => n.name));
      let k = 1;
      while (taken.has(`${label} ${k}`)) k++;
      name = `${label} ${k}`;
    }
    const node: NodeRec = {
      id,
      name,
      ws,
      mode: msg.mode === 'reborn' ? 'reborn' : 'join',
      caps,
      status: sanitizeStatus(msg.status),
      credits: { cpu: 0, llm: 0 },
      kernels: { cpu: [], llm: [] },
      connectedAt: now,
      lastSeen: now,
      itemsSession: existing?.itemsSession ?? 0,
      ip,
      host,
    };
    this.nodes.set(id, node);
    this.db.q.upsertNode.run(id, name, caps.deviceType, caps.browser, JSON.stringify(caps), now, now);
    send(ws, {
      type: 'welcome',
      nodeId: id,
      name,
      room: this.room,
      models: this.models.info(),
      dataset: { count: this.info.datasetCount },
    });
    send(ws, this.labMsg());
    if (this.fed.round > 0) send(ws, { type: 'fed:model', sessionId: this.fed.id, round: this.fed.round, weights: b64(this.fed.weights), dims: [this.fed.dims.classes, this.fed.dims.inDim] });
    this.dirty = true;
    return id;
  }

  private onNodeMsg(node: NodeRec, msg: NodeToHub) {
    switch (msg.type) {
      case 'status': {
        node.status = sanitizeStatus(msg.status);
        if (!['idle', 'working', 'preparing'].includes(node.status.state)) {
          node.credits = { cpu: 0, llm: 0 };
          this.sched.releaseNode(node.id);
        }
        this.dirty = true;
        break;
      }
      case 'want': {
        const pool: Pool = msg.pool === 'llm' ? 'llm' : 'cpu';
        node.credits[pool] = Math.max(0, Math.min(16, node.credits[pool] + Math.max(0, Math.floor(Number(msg.slots) || 0))));
        node.kernels[pool] = (Array.isArray(msg.kernels) ? msg.kernels : []).filter((k): k is Kernel => ['classify', 'pi', 'sir', 'tutor'].includes(k));
        this.pump();
        break;
      }
      case 'result': {
        if (!Array.isArray(msg.outputs)) return;
        this.sched.complete(String(msg.leaseId), node.id, msg.outputs, Number(msg.ms) || undefined);
        this.pump();
        this.dirty = true;
        break;
      }
      case 'fail':
        this.sched.fail(String(msg.leaseId), node.id, String(msg.error).slice(0, 200));
        this.pump();
        break;
      case 'release':
        this.sched.releaseNode(node.id, Array.isArray(msg.leaseIds) ? msg.leaseIds.map(String) : undefined);
        this.pump();
        break;
      case 'fed:update': {
        if (msg.sessionId !== this.fed.id) return;
        const all = this.fed.submit(node.id, msg);
        if (all) this.finishFedRound();
        break;
      }
      case 'launch':
        if (this.studentsCanLaunch || this.demo) this.startLab(msg.lab, msg.options ?? {});
        break;
      case 'ping':
        break;
    }
  }

  private nodeGone(node: NodeRec) {
    node.ws = null;
    node.credits = { cpu: 0, llm: 0 };
    this.sched.releaseNode(node.id);
    if (this.fed.dropNode(node.id)) this.finishFedRound();
    this.pump();
    this.dirty = true;
  }

  attachConsole(ws: WebSocket, canControl: boolean, isHost = false) {
    const c: ConsoleConn = { ws, canControl, isHost };
    this.consoles.add(c);
    send(ws, { type: 'state', state: this.consoleState(c) });
    ws.on('message', (raw) => {
      let msg: ConsoleCmd;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!c.canControl) {
        send(ws, { type: 'toast', level: 'warn', text: 'This screen is view-only. Open the Console link printed in the Hub window to control the lab.' });
        return;
      }
      try {
        this.onConsoleCmd(msg);
      } catch (e) {
        send(ws, { type: 'toast', level: 'warn', text: e instanceof Error ? e.message : String(e) });
      }
      this.dirty = true;
    });
    ws.on('close', () => this.consoles.delete(c));
    ws.on('error', () => {});
  }

  // ---------- dispatch ----------

  /** Give free worker slots something to do. Round-robin so every device gets a first chunk quickly. */
  pump() {
    let progress = true;
    while (progress) {
      progress = false;
      for (const node of this.nodes.values()) {
        if (!node.ws) continue;
        for (const pool of ['cpu', 'llm'] as Pool[]) {
          if (node.credits[pool] <= 0 || !node.kernels[pool].length) continue;
          const lease = this.sched.request(node.id, node.kernels[pool]);
          if (!lease) continue;
          node.credits[pool]--;
          send(node.ws, {
            type: 'lease',
            leaseId: lease.id,
            jobId: lease.jobId,
            kernel: lease.kernel as Kernel,
            params: lease.params,
            items: lease.items,
            verify: lease.verify,
          });
          progress = true;
        }
      }
    }
  }

  private tick() {
    this.sched.tick();
    this.pump();
    const now = Date.now();
    if (this.run && this.run.status === 'running') {
      const active = new Set<string>();
      for (const l of this.sched.leases.values()) if (l.jobId === this.run.jobId && !l.verify) active.add(l.nodeId);
      this.run.sample(now, active);
      this.dirty = true;
      this.progressToNodes(now);
    } else if (this.run && this.run.finishedAt && now - this.run.finishedAt < 1000) this.progressToNodes(now);
    if (this.dirty || now % 2000 < 500) this.broadcastConsoles();
  }

  private progressToNodes(now: number) {
    const r = this.run!;
    const end = r.finishedAt ?? now;
    for (const n of this.nodes.values())
      send(n.ws, {
        type: 'progress',
        jobId: r.jobId,
        title: r.def.title,
        unit: r.def.unit,
        status: r.status,
        done: r.done,
        total: r.def.total,
        elapsed: round((end - r.startedAt) / 1000, 1),
        rate: round(r.rate(now), 2),
        devices: new Set([...this.sched.leases.values()].filter((l) => l.jobId === r.jobId && !l.verify).map((l) => l.nodeId)).size,
        mine: r.perDevice.get(n.id)?.items ?? 0,
      });
  }

  private onItems(job: Job, items: { i: number; output: unknown; nodeId: string }[], ms: number) {
    const now = Date.now();
    this.db.tx(() => {
      for (const it of items) this.db.q.insertResult.run(job.id, it.i, it.nodeId, JSON.stringify(it.output), now);
      const byNode = new Map<string, number>();
      for (const it of items) byNode.set(it.nodeId, (byNode.get(it.nodeId) ?? 0) + 1);
      for (const [nid, n] of byNode) {
        this.db.q.nodeWork.run(n, Math.round(ms), now, nid);
        const node = this.nodes.get(nid);
        if (node) node.itemsSession += n;
      }
    });
    if (this.run?.jobId === job.id) this.run.record(items, (id) => this.nameOf(id), now);
  }

  private onJobDone(job: Job) {
    const now = Date.now();
    const run = this.run?.jobId === job.id ? this.run : null;
    const seconds = ((job.finishedAt ?? now) - job.createdAt) / 1000;
    const devices = new Set(job.doneBy.filter(Boolean)).size;
    this.db.q.finishJob.run(job.status, job.finishedAt ?? now, JSON.stringify({ seconds, devices, failed: job.failed.size }), job.id);
    if (run) {
      run.status = 'done';
      run.finishedAt = job.finishedAt ?? now;
      const solo = run.soloRate();
      if (solo && !this.experiment) this.db.set(`baseline:${job.kernel}`, String(solo));
      this.say('info', `${run.def.title}: finished in ${seconds.toFixed(1)} s on ${devices} device${devices === 1 ? '' : 's'}.`);
    }
    if (this.experiment?.status === 'running') this.experimentStepDone(job, seconds);
    this.dirty = true;
  }

  // ---------- labs ----------

  startLab(lab: LabId, options: Record<string, unknown>, extra: { eligible?: string[]; tag?: string } = {}) {
    if (lab === 'teach') {
      this.cancelRun();
      this.lab = 'teach';
      this.broadcastNodes(this.labMsg());
      return null;
    }
    const def = labJob(lab, options, this.info.datasetCount);
    if (lab === 'swarm-sort' && !this.models.info().find((m) => m.id === 'mobilenetv3')?.ready) {
      throw new Error('The image model is still downloading to the Hub. Wait for it to finish (see Models).');
    }
    if (lab === 'tutor') {
      const model = String(def.params.model);
      const m = this.models.info().find((x) => x.id === model);
      if (!m?.ready) throw new Error(`The ${m?.title ?? model} model is not on the Hub yet. Download it first (see Models).`);
      // Ask devices that haven't loaded the tutor yet to load it.
      for (const node of this.nodes.values()) if (node.ws && node.status.ready.tutor !== model) send(node.ws, { type: 'cmd', cmd: 'prepare', args: { tutor: model } });
    }
    this.cancelRun();
    const id = `${lab}-${Date.now().toString(36)}`;
    this.db.q.insertJob.run(id, lab, def.kernel, JSON.stringify(def.params), def.total, 'running', Date.now(), extra.tag ?? null);
    this.sched.createJob({ id, kernel: def.kernel, params: def.params, total: def.total, chunk: def.chunk, spotCheck: def.spotCheck, eligible: extra.eligible ?? null });
    this.run = new RunTracker(id, lab, def, Date.now());
    this.lab = lab;
    this.broadcastNodes(this.labMsg());
    this.pump();
    return id;
  }

  cancelRun() {
    if (this.run && this.run.status === 'running') {
      this.sched.cancelJob(this.run.jobId);
      this.run.status = 'cancelled';
      this.run.finishedAt = Date.now();
      this.db.q.finishJob.run('cancelled', Date.now(), null, this.run.jobId);
      this.broadcastNodes({ type: 'cancel', jobId: this.run.jobId });
    }
  }

  private restoreJobs() {
    for (const row of this.db.q.runningJobs.all() as { id: string; lab: LabId; kernel: string; params: string; total: number }[]) {
      try {
        const done = new Map<number, { output: unknown; nodeId: string }>();
        for (const r of this.db.q.resultsOf.all(row.id) as { item: number; node_id: string; output: string }[]) done.set(r.item, { output: JSON.parse(r.output), nodeId: r.node_id });
        const params = JSON.parse(row.params);
        const def = { ...labJob(row.lab, row.lab === 'sweep' ? { kind: row.kernel } : row.lab === 'tutor' ? { questions: params.questions, model: params.model } : { count: row.total }, this.info.datasetCount), params, total: row.total };
        this.sched.createJob({ id: row.id, kernel: row.kernel, params, total: row.total, chunk: def.chunk, spotCheck: def.spotCheck, done });
        const run = new RunTracker(row.id, row.lab, def, Date.now());
        run.done = done.size;
        this.run = run;
        this.lab = row.lab;
      } catch {
        this.db.q.finishJob.run('cancelled', Date.now(), null, row.id);
      }
    }
  }

  // ---------- federated learning ----------

  startFedRound() {
    if (this.fed.roundOpen) return;
    const participants = [...this.nodes.values()].filter((n) => n.ws && n.status.fedPhotos.reduce((a, b) => a + b, 0) > 0);
    if (!participants.length) throw new Error('No device has any photos yet. Take a few photos of each kind on a device first.');
    if (this.lab !== 'teach') this.startLab('teach', {});
    const msg = this.fed.startRound(participants.map((p) => p.id));
    for (const p of participants) send(p.ws!, msg);
    this.fedTimer = setTimeout(() => this.finishFedRound(), ROUND_TIMEOUT_MS);
    this.dirty = true;
  }

  private finishFedRound() {
    if (this.fedTimer) clearTimeout(this.fedTimer);
    this.fedTimer = null;
    const stats = this.fed.finishRound();
    if (!stats) return;
    this.db.q.insertFed.run(this.fed.id, stats.round, JSON.stringify(stats), stats.at);
    this.broadcastNodes({ type: 'fed:model', sessionId: this.fed.id, round: this.fed.round, weights: b64(this.fed.weights), dims: [this.fed.dims.classes, this.fed.dims.inDim] });
    this.dirty = true;
    if (this.fedAuto) {
      this.fedAutoCount++;
      if (this.fedAutoCount >= AUTO_ROUNDS_MAX) {
        this.fedAuto = false;
        this.say('info', `Auto rounds stopped after ${AUTO_ROUNDS_MAX} rounds.`);
      } else
        this.fedTimer = setTimeout(() => {
          try {
            this.startFedRound();
          } catch (e) {
            this.fedAuto = false;
            this.say('warn', e instanceof Error ? e.message : String(e));
          }
        }, 2500);
    }
  }

  resetFed() {
    if (this.fedTimer) clearTimeout(this.fedTimer);
    this.fedTimer = null;
    this.fedAuto = false;
    this.fed = new FedSession(`fed-${Date.now().toString(36)}`);
    this.db.set('fedSession', this.fed.id);
    this.broadcastNodes({ type: 'fed:reset' });
  }

  // ---------- speedup experiment ----------

  private startExperiment(lab: LabId, items: number, order: string[]) {
    if (this.experiment?.status === 'running' || this.experiment?.status === 'preparing') throw new Error('An experiment is already running.');
    const ids = order.filter((id) => this.nodes.get(id)?.ws);
    if (!ids.length) throw new Error('Pick at least one connected device.');
    this.experiment = { id: `exp-${Date.now().toString(36)}`, lab, items, order: ids, step: 0, status: 'running', rows: [] };
    if (lab === 'swarm-sort') {
      // Warm up first: every device loads the image model and saves the photos, so step 1 isn't
      // slowed by downloads the later steps don't have. Starts when all are ready (or after 4 min).
      this.experiment.status = 'preparing';
      this.experiment.prepUntil = Date.now() + 240_000;
      for (const id of ids) send(this.nodes.get(id)!.ws, { type: 'cmd', cmd: 'prepare', args: { mobilenet: true, images: true } });
      this.experiment.timer = setTimeout(() => this.experimentPrepCheck(), 1500);
    } else this.experimentNext();
  }

  /** Ready = image model loaded and enough photos saved on the device. */
  private experimentDeviceReady(id: string, items: number) {
    const n = this.nodes.get(id);
    if (!n?.ws) return true; // gone: don't wait for it
    const r = n.status.ready;
    return r.mobilenet && r.dataset >= Math.min(items, this.info.datasetCount) && n.status.state !== 'preparing';
  }

  private experimentPrepCheck() {
    const ex = this.experiment;
    if (!ex || ex.status !== 'preparing') return;
    const waiting = ex.order.filter((id) => !this.experimentDeviceReady(id, ex.items));
    if (waiting.length && Date.now() < (ex.prepUntil ?? 0)) {
      ex.timer = setTimeout(() => this.experimentPrepCheck(), 1000);
      return;
    }
    if (waiting.length) this.say('warn', `Starting anyway; still not ready: ${waiting.map((id) => this.nameOf(id)).join(', ')}.`);
    ex.status = 'running';
    this.dirty = true;
    this.experimentNext();
  }

  private experimentNext() {
    const ex = this.experiment!;
    ex.step++;
    const eligible = ex.order.slice(0, ex.step);
    const opts = ex.lab === 'sweep' ? { kind: 'pi', batches: ex.items } : { count: ex.items };
    this.startLab(ex.lab, opts, { eligible, tag: `${ex.id}:${ex.step}` });
  }

  private experimentStepDone(job: Job, seconds: number) {
    const ex = this.experiment!;
    if (!job.eligible) return;
    const names = ex.order.slice(0, ex.step).map((id) => this.nameOf(id));
    const t1 = ex.rows[0]?.seconds ?? seconds;
    const row = { devices: ex.step, names, seconds: round(seconds, 2), itemsPerSec: round(job.doneCount / seconds, 2), speedup: round(t1 / seconds, 2) };
    ex.rows.push(row);
    this.db.q.insertSpeedup.run(ex.id, Date.now(), job.id, ex.lab, row.devices, names.join(' + '), job.doneCount, row.seconds, row.itemsPerSec, row.speedup);
    if (ex.step >= ex.order.length) {
      ex.status = 'done';
      this.say('info', 'Speedup experiment finished. Download the CSV from the Benchmarks tab.');
    } else ex.timer = setTimeout(() => ex.status === 'running' && this.experimentNext(), 2000);
  }

  // ---------- console ----------

  private onConsoleCmd(msg: ConsoleCmd) {
    switch (msg.cmd) {
      case 'start':
        if (msg.lab === 'teach') this.startLab('teach', {});
        else this.startLab(msg.lab, msg.options ?? {});
        break;
      case 'cancel':
        this.cancelRun();
        if (this.experiment?.status === 'running' || this.experiment?.status === 'preparing') {
          if (this.experiment.timer) clearTimeout(this.experiment.timer);
          this.experiment.status = 'cancelled';
        }
        break;
      case 'reset':
        this.cancelRun();
        if (this.experiment) {
          if (this.experiment.timer) clearTimeout(this.experiment.timer);
          this.experiment = null;
        }
        this.run = null;
        this.lab = null;
        this.resetFed();
        this.consoleMsgs = [];
        this.broadcastNodes(this.labMsg());
        break;
      case 'demo':
        this.demo = !!msg.on;
        this.db.set('demo', this.demo ? '1' : '0');
        this.broadcastNodes(this.labMsg());
        break;
      case 'students-launch':
        this.studentsCanLaunch = !!msg.on;
        this.db.set('studentsCanLaunch', this.studentsCanLaunch ? '1' : '0');
        this.broadcastNodes(this.labMsg());
        break;
      case 'new-room':
        this.room = newRoom();
        this.db.set('room', this.room);
        break;
      case 'rename': {
        const name = String(msg.name).trim().slice(0, 40);
        const node = this.nodes.get(msg.nodeId);
        if (!name) return;
        this.db.q.renameNode.run(name, msg.nodeId);
        if (node) {
          node.name = name;
          if (node.ws) send(node.ws, { type: 'cmd', cmd: 'rename', args: { name } });
        }
        break;
      }
      case 'node': {
        const targets = msg.nodeId === '*' ? [...this.nodes.values()] : [this.nodes.get(msg.nodeId)].filter(Boolean);
        for (const n of targets as NodeRec[]) if (n.ws) send(n.ws, { type: 'cmd', cmd: msg.action, args: msg.args });
        break;
      }
      case 'forget-offline':
        for (const [id, n] of this.nodes) if (!n.ws) this.nodes.delete(id);
        break;
      case 'model-download':
        void this.models.download(msg.id);
        break;
      case 'fed-round':
        this.startFedRound();
        break;
      case 'fed-auto':
        this.fedAuto = !!msg.on;
        this.fedAutoCount = 0;
        if (this.fedAuto && !this.fed.roundOpen) this.startFedRound();
        break;
      case 'fed-reset':
        this.resetFed();
        break;
      case 'watts': {
        const clean = (v: unknown) => (v === null || v === '' || v === undefined ? null : Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) < 2000 ? Number(v) : NaN);
        const idle = clean(msg.idle_w);
        const busy = clean(msg.busy_w);
        if (Number.isNaN(idle) || Number.isNaN(busy)) throw new Error('Watts must be a number between 0 and 2000.');
        this.db.q.setWatts.run(String(msg.device).slice(0, 64), idle, busy, msg.note ? String(msg.note).slice(0, 200) : null, Date.now());
        break;
      }
      case 'watts-delete':
        this.db.q.delWatts.run(String(msg.device));
        break;
      case 'experiment':
        this.startExperiment(msg.lab, Math.max(10, Math.min(5000, Math.round(Number(msg.items) || 200))), (msg.order ?? []).map(String));
        break;
      case 'host-compute':
        this.hostCompute = { on: !!msg.on, workers: msg.workers === undefined ? this.hostCompute.workers : this.clampHostWorkers(Number(msg.workers) || this.defaultHostWorkers()) };
        this.db.set('hostCompute', JSON.stringify(this.hostCompute));
        if (!this.hostCompute.on) {
          const n = this.nodes.get(HOST_NODE_ID);
          if (n?.ws) {
            this.sched.releaseNode(n.id);
            try {
              n.ws.close(4004, 'host-off');
            } catch {}
          }
        }
        break;
      case 'experiment-cancel':
        if (this.experiment) {
          if (this.experiment.timer) clearTimeout(this.experiment.timer);
          this.experiment.status = 'cancelled';
          this.cancelRun();
        }
        break;
      case 'clear':
        if (msg.what === 'bench') this.db.q.clearBench.run();
        if (msg.what === 'speedup') this.db.q.clearSpeedup.run();
        if (msg.what === 'history') {
          // "Start fresh" after practice: impact counters, job history and offline devices go; measurements stay.
          this.onConsoleCmd({ cmd: 'reset' });
          const connected = new Set([...this.nodes].filter(([, n]) => n.ws).map(([id]) => id));
          this.db.tx(() => {
            this.db.q.clearJobs.run();
            this.db.q.clearResults.run();
            this.db.q.clearSpot.run();
            this.db.q.clearFed.run();
            this.db.q.zeroNodeWork.run();
            for (const n of this.db.q.allNodes.all() as { id: string }[]) if (!connected.has(n.id)) this.db.q.deleteNode.run(n.id);
          });
          for (const [id, n] of this.nodes) {
            if (!connected.has(id)) this.nodes.delete(id);
            else n.itemsSession = 0;
          }
          this.say('info', 'Practice history cleared. Counters start from zero.');
        }
        break;
    }
  }

  private say(level: 'info' | 'warn', text: string) {
    this.consoleMsgs.push({ t: Date.now(), level, text });
    if (this.consoleMsgs.length > 20) this.consoleMsgs.shift();
    for (const c of this.consoles) send(c.ws, { type: 'toast', level, text });
  }

  nameOf(id: string) {
    if (id === 'hub') return 'Hub';
    return this.nodes.get(id)?.name ?? (this.db.q.nodeById.get(id) as { name: string } | undefined)?.name ?? id;
  }

  private labMsg(): HubToNode {
    return { type: 'lab', lab: this.lab, jobId: this.run?.status === 'running' ? this.run.jobId : null, canLaunch: this.studentsCanLaunch || this.demo, demo: this.demo };
  }

  private broadcastNodes(msg: HubToNode) {
    for (const n of this.nodes.values()) if (n.ws) send(n.ws, msg);
  }

  private broadcastConsoles() {
    this.dirty = false;
    if (!this.consoles.size) return;
    const base = this.consoleState(null);
    for (const c of this.consoles) send(c.ws, { type: 'state', state: { ...base, canControl: c.canControl, isHost: c.isHost, urls: c.canControl ? base.urls : { ...base.urls, console: '' } } });
  }

  wattsMap() {
    const m = new Map<string, number>();
    for (const w of this.db.q.allWatts.all() as { device: string; busy_w: number | null }[]) if (w.busy_w !== null) m.set(w.device, w.busy_w);
    return m;
  }

  urls() {
    const host = this.info.lanIp ?? 'localhost';
    return {
      join: `https://${host}:${this.info.httpsPort}/join?room=${this.room}`,
      joinHttp: `http://${host}:${this.info.httpPort}/join?room=${this.room}`,
      trust: `http://${host}:${this.info.httpPort}/trust`,
      console: `https://${host}:${this.info.httpsPort}/console?key=${this.info.teacherKey}`,
      all: this.info.addresses,
    };
  }

  consoleState(c: ConsoleConn | null): ConsoleState {
    const now = Date.now();
    const nodes: NodeView[] = [...this.nodes.values()]
      .filter((n) => !n.host || n.ws || this.hostCompute.on)
      .map((n) => ({
        id: n.id,
        name: n.name,
        online: !!n.ws,
        mode: n.mode,
        caps: n.caps,
        status: n.status,
        leases: this.sched.leasesOf(n.id).length,
        itemsSession: n.itemsSession,
        itemsRun: this.run?.perDevice.get(n.id)?.items ?? 0,
        kernels: [...new Set([...n.kernels.cpu, ...n.kernels.llm])],
        connectedAt: n.connectedAt,
        host: n.host,
      }))
      .sort((a, b) => Number(b.online) - Number(a.online) || a.connectedAt - b.connectedAt);
    const allNodes = this.db.q.allNodes.all() as { id: string; name: string; device_type: string }[];
    const byType: Record<string, number> = {};
    for (const n of allNodes) byType[n.device_type ?? 'other'] = (byType[n.device_type ?? 'other'] ?? 0) + 1;
    const totals = this.db.q.totals.get() as { items: number; ms: number };
    const spot = this.db.q.spotTotals.get() as { n: number; ok: number | null };
    const names = new Map(allNodes.map((n) => [n.id, n.name]));
    const watts = (this.db.q.allWatts.all() as { device: string; idle_w: number | null; busy_w: number | null; note: string | null }[]).map((w) => ({
      ...w,
      name: w.device === 'hub' ? 'Hub computer' : (names.get(w.device) ?? w.device),
    }));
    const baseline = this.run ? Number(this.db.get(`baseline:${this.run.def.kernel}`)) || null : null;
    const ex = this.experiment;
    const photos = [0, 0, 0];
    for (const n of this.nodes.values()) if (n.ws) n.status.fedPhotos.forEach((v, k) => (photos[k] = (photos[k] ?? 0) + v));
    return {
      t: now,
      room: this.room,
      hubName: this.info.hubName,
      urls: this.urls(),
      caFingerprint: this.info.caFingerprint,
      canControl: c?.canControl ?? false,
      isHost: c?.isHost ?? false,
      hostCompute: { ...this.hostCompute, maxWorkers: this.clampHostWorkers(99), name: this.nodes.get(HOST_NODE_ID)?.name ?? (this.db.q.nodeById.get(HOST_NODE_ID) as { name: string } | undefined)?.name ?? this.info.hostName ?? 'This computer (Hub)' },
      demo: this.demo,
      studentsCanLaunch: this.studentsCanLaunch,
      models: this.models.info(),
      nodes,
      lab: this.lab,
      run: this.run ? this.run.view(now, this.sched.progress(this.run.jobId), (id) => this.nameOf(id), baseline, this.wattsMap()) : null,
      experiment: ex
        ? { id: ex.id, lab: ex.lab, items: ex.items, order: ex.order.map((id) => this.nameOf(id)), step: ex.step, steps: ex.order.length, status: ex.status, rows: ex.rows }
        : null,
      fed: {
        sessionId: this.fed.id,
        round: this.fed.round,
        roundOpen: this.fed.roundOpen,
        auto: this.fedAuto,
        classes: this.fed.classes,
        history: this.fed.history.map(({ at: _at, ...h }) => h),
        photosOnDevices: photos,
        photosUploaded: 0,
        weightBytesTotal: this.fed.history.reduce((s, h) => s + h.weightBytes, 0),
      },
      impact: {
        devicesEver: allNodes.length,
        byType,
        itemsTotal: totals.items,
        computeHours: round(totals.ms / 3.6e6, 3),
        spotChecks: spot.n,
        spotAgree: spot.ok ?? 0,
      },
      watts,
      history: (this.db.q.recentJobs.all(8) as { id: string; lab: string; total: number; status: string; created_at: number; summary: string | null; tag: string | null }[]).map((j) => {
        const s = j.summary ? JSON.parse(j.summary) : null;
        return { jobId: j.id, lab: j.lab, title: j.tag ? `${j.lab} (experiment step)` : j.lab, total: j.total, seconds: s?.seconds ?? null, devices: s?.devices ?? 0, status: j.status, at: j.created_at };
      }),
      datasetCount: this.info.datasetCount,
      tutorQuestions: DEFAULT_QUESTIONS,
    };
  }
}

function send(ws: WebSocket | null, msg: unknown) {
  if (!ws || ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(msg));
  } catch {}
}

function b64(a: Float32Array) {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
}

function safeParse(v: string | null | undefined): Record<string, unknown> | null {
  try {
    return v ? JSON.parse(v) : null;
  } catch {
    return null;
  }
}

function newRoom() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function round(x: number, d: number) {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}

function sanitizeCaps(c: Partial<Capabilities> | undefined): Capabilities {
  const s = (v: unknown, n = 200) => (typeof v === 'string' ? v.slice(0, n) : '');
  const types = ['chromebook', 'iphone', 'ipad', 'android', 'mac', 'windows', 'linux', 'other'];
  return {
    cores: Math.max(1, Math.min(256, Math.round(Number(c?.cores) || 1))),
    workers: Math.max(0, Math.min(64, Math.round(Number(c?.workers) || 0))),
    memoryGB: Number.isFinite(Number(c?.memoryGB)) && c?.memoryGB !== null ? Number(c?.memoryGB) : null,
    webgpu: c?.webgpu ? s(c.webgpu, 120) : null,
    isolated: !!c?.isolated,
    secure: !!c?.secure,
    ua: s(c?.ua, 300),
    deviceType: (types.includes(String(c?.deviceType)) ? c!.deviceType : 'other') as Capabilities['deviceType'],
    browser: s(c?.browser, 60),
  };
}

function sanitizeStatus(st: Partial<NodeStatus> | undefined): NodeStatus {
  const states = ['idle', 'working', 'paused-unplugged', 'stopped', 'hidden', 'preparing'];
  const batt = ['charging', 'on-battery', 'unknown'];
  return {
    state: (states.includes(String(st?.state)) ? st!.state : 'idle') as NodeStatus['state'],
    battery: (batt.includes(String(st?.battery)) ? st!.battery : 'unknown') as NodeStatus['battery'],
    throttle: Math.max(0, Math.min(10, Number(st?.throttle) || 0)),
    activeWorkers: Math.max(0, Math.min(64, Number(st?.activeWorkers) || 0)),
    rate: Math.max(0, Number(st?.rate) || 0),
    ready: {
      mobilenet: !!st?.ready?.mobilenet,
      dataset: Math.max(0, Number(st?.ready?.dataset) || 0),
      tutor: typeof st?.ready?.tutor === 'string' ? st.ready.tutor.slice(0, 40) : null,
    },
    fedPhotos: Array.isArray(st?.fedPhotos) ? st!.fedPhotos.slice(0, 3).map((v) => Math.max(0, Math.min(10000, Number(v) || 0))) : [0, 0, 0],
  };
}
