// The Hub's live coordinator: talks to Nodes and Consoles over WebSocket,
// hands out work from the scheduler, runs federated-learning rounds, and
// keeps the Console's picture of the classroom up to date.

import crypto from 'node:crypto';
import path from 'node:path';
import type { WebSocket } from 'ws';
import type { DB } from './db';
import type { ModelStore } from './models';
import { FedSession } from './fedavg';
import { DEFAULT_QUESTIONS, labJob, RunTracker, compareOutputs } from './labs';
import { Scheduler, type Job } from '../../web/src/shared/scheduler';
import { RenderStore } from './render-store';
import { CaptionOrderer } from './captions';
import { DATA_DIR } from './config';
import { wallLayout } from '../../web/src/shared/wall';
import { KERNELS } from '../../web/src/shared/protocol';
import type { RenderOutput, RenderParams } from '../../web/src/shared/render';
import type {
  CaptionLine,
  CaptionOutput,
  FleetInputs,
  NightShiftView,
  RenderTilesMsg,
  ScreenInfo,
  WallMsg,
  WallScene,
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
  RenderRaceView,
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
  screen: ScreenInfo | null;
  clock: { offset: number; rtt: number } | null;
}

type NightItem = NightShiftView['queue'][number];

const LAB_TITLES: Record<string, string> = {
  'swarm-sort': 'Swarm Sort',
  sweep: 'Science Sweep',
  render: 'Swarm Render',
  tutor: 'Private Tutor',
  translate: 'Translate a document',
};

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
  race: boolean;
  options: Record<string, unknown>;
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
  readonly render: RenderStore;
  private renderReset = false;
  private renderHeaderChanged = false;
  usecase: string | null;
  wall: { scene: WallScene; at: number; gap: number; order: string[] };
  captions = {
    on: false,
    translate: true,
    orderer: new CaptionOrderer(),
    seq: 0,
    lines: [] as CaptionLine[],
    /** Timing only (no words), kept until cleared, for captions.csv. */
    timing: [] as { seq: number; audioSec: number; lagSec: number; node: string; translated: boolean }[],
    lags: [] as number[],
    heard: 0,
    devices: new Set<string>(),
    jobs: new Map<string, { seq: number }>(),
  };
  renderRace: RenderRaceView | null = null;
  night: { queue: NightItem[]; armed: boolean; allowUnknown: boolean; running: { id: string; jobId: string } | null };

  constructor(
    private db: DB,
    private models: ModelStore,
    public info: HubInfo,
    opts: { now?: () => number; rng?: () => number; tickMs?: number; dataDir?: string } = {},
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
    this.render = new RenderStore(path.join(opts.dataDir ?? DATA_DIR, 'renders'));
    this.usecase = db.get('usecase') ?? null;
    this.refreshRenderRace();
    const w = safeParse(db.get('wall'));
    this.wall = { scene: 'off', at: 0, gap: clampGap(Number(w?.gap ?? 40)), order: Array.isArray(w?.order) ? (w!.order as unknown[]).map(String).slice(0, 32) : [] };
    const ns = safeParse(db.get('nightShift'));
    this.night = {
      queue: Array.isArray(ns?.queue) ? (ns!.queue as NightItem[]).map((q) => (q.status === 'running' ? { ...q, status: 'waiting' as const } : q)) : [],
      armed: ns?.armed === true,
      allowUnknown: ns?.allowUnknown === true,
      running: null,
    };
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
      screen: existing?.screen ?? null,
      clock: null,
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
        node.kernels[pool] = (Array.isArray(msg.kernels) ? msg.kernels : []).filter((k): k is Kernel => (KERNELS as readonly string[]).includes(k));
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
      case 'clock':
        send(node.ws, { type: 'clock', id: Number(msg.id) || 0, hub: Date.now() });
        break;
      case 'screen': {
        const sc = msg.screen;
        const okNum = (v: unknown, lo: number, hi: number) => Number.isFinite(Number(v)) && Number(v) >= lo && Number(v) <= hi;
        if (sc && okNum(sc.w, 100, 10000) && okNum(sc.h, 100, 10000)) node.screen = { w: Math.round(sc.w), h: Math.round(sc.h), dpr: okNum(sc.dpr, 0.5, 8) ? Number(sc.dpr) : 1 };
        node.clock = msg.clock && okNum(msg.clock.rtt, 0, 60000) && Number.isFinite(Number(msg.clock.offset)) ? { offset: Math.round(Number(msg.clock.offset)), rtt: Math.round(Number(msg.clock.rtt)) } : node.clock;
        if (!node.host && !this.wall.order.includes(node.id)) this.wall.order.push(node.id);
        this.sendWall();
        this.dirty = true;
        break;
      }
    }
  }

  private nodeGone(node: NodeRec) {
    node.ws = null;
    node.credits = { cpu: 0, llm: 0 };
    this.sched.releaseNode(node.id);
    if (this.fed.dropNode(node.id)) this.finishFedRound();
    this.pump();
    if (this.wall.scene !== 'off') this.sendWall();
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
      if (msg?.cmd === 'render-sync') return this.renderSync(ws);
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
    this.renderToConsoles();
    if (this.captions.on || this.captions.orderer.pending) this.releaseCaptions(this.captions.orderer.release(now));
    this.nightTick();
    if (this.dirty || now % 2000 < 500) this.broadcastConsoles();
  }

  // ---------- Swarm Render ----------

  private renderToConsoles(reset = this.renderReset) {
    const tiles = this.render.takeFresh();
    if (!tiles.length && !reset && !this.renderHeaderChanged) return;
    this.renderReset = false;
    this.renderHeaderChanged = false;
    const msg: RenderTilesMsg = { type: 'render-tiles', header: this.render.header(), tiles, reset };
    for (const c of this.consoles) send(c.ws, msg);
  }

  private renderSync(ws: WebSocket) {
    const msg: RenderTilesMsg = { type: 'render-tiles', header: this.render.header(), tiles: this.render.all(), reset: true };
    send(ws, msg);
  }

  // ---------- Screen Wall ----------

  /** Devices on the wall, left to right: online, not the Hub's own hidden node, screen size known. */
  wallDevices() {
    const on = (id: string) => {
      const n = this.nodes.get(id);
      return !!(n && n.ws && !n.host && n.screen);
    };
    return this.wall.order.filter(on).map((id) => this.nodes.get(id)!);
  }

  wallImageUrl() {
    return `/api/render/wall.png?v=${this.render.finishedAt ?? 0}`;
  }

  sendWall() {
    const devs = this.wallDevices();
    const { canvas, slots } = wallLayout(
      devs.map((n) => ({ id: n.id, w: n.screen!.w, h: n.screen!.h })),
      this.wall.gap,
    );
    for (const n of this.nodes.values()) {
      if (!n.ws || n.host) continue;
      const k = devs.indexOf(n);
      const msg: WallMsg = {
        type: 'wall',
        scene: k < 0 ? 'off' : this.wall.scene,
        at: this.wall.at,
        slot: k < 0 ? null : slots.get(n.id)!,
        canvas,
        index: Math.max(0, k),
        count: devs.length,
        image: this.wallImageUrl(),
        name: n.name,
      };
      send(n.ws, msg);
    }
  }

  private saveWall() {
    this.db.set('wall', JSON.stringify({ gap: this.wall.gap, order: this.wall.order }));
  }

  // ---------- Live Captions ----------

  private captionAudio(pcmB64: string, sampleRate: number) {
    const cap = this.captions;
    if (!cap.on) return;
    if (typeof pcmB64 !== 'string' || pcmB64.length > 16000 * 2 * 8 * 1.4) throw new Error('Audio piece too long (max 8 s).');
    if (sampleRate !== 16000) throw new Error('Audio must be 16 kHz.');
    const bytes = Math.floor((pcmB64.length * 3) / 4);
    const audioSec = Math.round((bytes / 2 / 16000) * 100) / 100;
    if (audioSec < 0.2) return;
    const seq = cap.seq++;
    const now = Date.now();
    cap.orderer.add(seq, now, audioSec);
    cap.heard += audioSec;
    const id = `cap-${now.toString(36)}-${seq}`;
    cap.jobs.set(id, { seq });
    // One audio piece = one tiny job. Nothing is written to disk; the audio is dropped when the job ends.
    this.sched.createJob({ id, kernel: 'caption', params: { pcm: pcmB64, sampleRate: 16000, translate: cap.translate, seq }, total: 1, chunk: { initial: 1, min: 1, max: 1, targetSec: 4, guessSecPerItem: 6 }, spotCheck: false });
    this.pump();
    this.dirty = true;
  }

  /** Latest Swarm Render experiment with a 1-device row and a bigger row: 1 device vs the full swarm. */
  refreshRenderRace() {
    const rows = (this.db.q.allSpeedup.all() as { experiment: string; lab: string; devices: number; seconds: number }[]).filter((r) => r.lab === 'render');
    const byEx = new Map<string, { devices: number; seconds: number }[]>();
    for (const r of rows) byEx.set(r.experiment, [...(byEx.get(r.experiment) ?? []), { devices: r.devices, seconds: r.seconds }]);
    this.renderRace = null;
    for (const [experiment, rs] of byEx) {
      const one = rs.find((r) => r.devices === 1);
      const all = rs.reduce((a, b) => (b.devices > a.devices ? b : a), rs[0]);
      if (one && all.devices > 1) this.renderRace = { experiment, rows: [one, all] };
    }
    this.dirty = true;
  }

  private captionDone(job: Job) {
    const cap = this.captions;
    const meta = cap.jobs.get(job.id);
    cap.jobs.delete(job.id);
    const r = job.results[0] as CaptionOutput | undefined;
    const by = job.doneBy[0];
    this.sched.removeJob(job.id);
    if (!meta) return;
    if (r && by) cap.devices.add(this.nameOf(by));
    this.releaseCaptions(cap.orderer.complete(meta.seq, r ? { en: String(r.en ?? ''), es: r.es == null ? null : String(r.es), node: by ? this.nameOf(by) : '' } : null, Date.now()));
  }

  private releaseCaptions(lines: CaptionLine[]) {
    if (!lines.length) return;
    const cap = this.captions;
    for (const l of lines) {
      cap.lines.push(l);
      cap.lags.push(l.lagSec);
      cap.timing.push({ seq: l.seq, audioSec: l.audioSec, lagSec: l.lagSec, node: l.node, translated: l.es != null && l.es !== '' });
    }
    if (cap.timing.length > 5000) cap.timing.splice(0, cap.timing.length - 5000);
    if (cap.lines.length > 40) cap.lines.splice(0, cap.lines.length - 40);
    if (cap.lags.length > 10) cap.lags.splice(0, cap.lags.length - 10);
    this.dirty = true;
  }

  private stopCaptions() {
    const cap = this.captions;
    cap.on = false;
    for (const id of cap.jobs.keys()) {
      this.sched.cancelJob(id);
      this.sched.removeJob(id);
    }
    cap.jobs.clear();
    cap.orderer.reset();
    cap.seq = 0;
  }

  // ---------- Night Shift ----------

  /** Devices that may do Night Shift work right now. */
  nightEligible() {
    return [...this.nodes.values()]
      .filter((n) => n.ws && (n.status.state === 'idle' || n.status.state === 'working') && (n.status.battery === 'charging' || (n.status.battery === 'unknown' && this.night.allowUnknown)))
      .map((n) => n.id);
  }

  private saveNight() {
    this.db.set('nightShift', JSON.stringify({ queue: this.night.queue.slice(-50), armed: this.night.armed, allowUnknown: this.night.allowUnknown }));
  }

  private nightTick() {
    const ns = this.night;
    if (ns.running) {
      const item = ns.queue.find((q) => q.id === ns.running!.id);
      if (!this.run || this.run.jobId !== ns.running.jobId || this.run.status === 'cancelled') {
        if (item && item.status === 'running') item.status = 'cancelled';
        ns.running = null;
        this.saveNight();
        this.dirty = true;
      }
      return;
    }
    if (!ns.armed) return;
    if (this.run?.status === 'running' || this.experiment?.status === 'running' || this.experiment?.status === 'preparing' || this.captions.on) return;
    const next = ns.queue.find((q) => q.status === 'waiting');
    if (!next) return;
    const eligible = this.nightEligible().filter((id) => this.nodes.get(id)!.status.state === 'idle');
    if (!eligible.length) return;
    try {
      const jobId = this.startLab(next.lab, next.options, { eligible, tag: `night:${next.id}` });
      if (!jobId) return;
      next.status = 'running';
      ns.running = { id: next.id, jobId };
      this.say('info', `Night Shift: started "${next.title}" on ${eligible.length} charging device${eligible.length === 1 ? '' : 's'}.`);
    } catch (e) {
      next.status = 'cancelled';
      this.say('warn', `Night Shift: could not start "${next.title}": ${e instanceof Error ? e.message : String(e)}`);
    }
    this.saveNight();
    this.dirty = true;
  }

  private nightDone(job: Job, seconds: number) {
    const ns = this.night;
    if (!ns.running || ns.running.jobId !== job.id) return;
    const item = ns.queue.find((q) => q.id === ns.running!.id);
    if (item) {
      item.status = job.status === 'done' ? 'done' : 'cancelled';
      item.finishedAt = Date.now();
      item.seconds = round(seconds, 1);
    }
    ns.running = null;
    this.saveNight();
  }

  // ---------- fleet calculator inputs (measured only) ----------

  fleetInputs(): FleetInputs {
    const bench = this.db.q.allBench.all() as { test: string; value: number; unit: string; device: string; at?: number; created_at?: number }[];
    const best = new Map<string, FleetInputs['perDevice'][number]>();
    const want: Record<string, { kernel: string; label: string; unit: string }> = {
      'classify mobilenetv3': { kernel: 'classify', label: 'Image sorting', unit: 'images/s' },
      'render tiles': { kernel: 'render', label: 'Rendering', unit: 'Mrays/s' },
    };
    for (const b of bench) {
      const w = want[b.test];
      if (!w || !(b.value > 0)) continue;
      // keep the slowest measured device as the per-device rate (old devices set the honest pace)
      const cur = best.get(w.kernel);
      if (!cur || b.value < cur.rate) best.set(w.kernel, { ...w, rate: b.value, device: b.device, source: `Benchmarks: ${b.test} on ${b.device}` });
    }
    // runs measured on the Swarm Sort lab count too (1-device baseline)
    const base = Number(this.db.get('baseline:classify')) || 0;
    if (!best.has('classify') && base > 0) best.set('classify', { kernel: 'classify', label: 'Image sorting', unit: 'images/s', rate: round(base, 2), device: 'one device', source: 'Swarm Sort run on one device' });
    const sp = this.db.q.allSpeedup.all() as { experiment: string; lab: string; devices: number; speedup: number }[];
    let efficiency: FleetInputs['efficiency'] = null;
    const multi = sp.filter((r) => r.devices >= 2 && r.speedup > 0);
    if (multi.length) {
      const last = multi[multi.length - 1];
      efficiency = { value: round(Math.min(1, last.speedup / last.devices), 3), devices: last.devices, source: `Speedup experiment (${last.lab}): ${last.speedup}× on ${last.devices} devices` };
    }
    let captionRtf: FleetInputs['captionRtf'] = null;
    for (const b of bench) if (b.test === 'captions whisper-tiny-en' && b.value > 0 && (!captionRtf || b.value < captionRtf.value)) captionRtf = { value: b.value, device: b.device, source: `Benchmarks: captions speed on ${b.device}` };
    return { perDevice: [...best.values()], efficiency, captionRtf };
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
    if (job.kernel === 'caption') {
      for (const it of items) {
        const node = this.nodes.get(it.nodeId);
        if (node) node.itemsSession++;
      }
      return; // captions are never written to disk
    }
    if (job.kernel === 'render')
      for (const it of items) {
        const out = it.output as Partial<RenderOutput>;
        if (out && typeof out.rgb === 'string') {
          this.render.put(job.id, it.i, out as RenderOutput, it.nodeId, now);
          delete out.rgb; // the pixels live in the framebuffer; the database keeps who/where/checksum
        }
      }
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
    if (job.kernel === 'caption') return this.captionDone(job);
    const now = Date.now();
    if (job.kernel === 'render' && job.id === this.render.jobId) {
      void this.render.finish(job.finishedAt ?? now).then(
        () => {
          // Header-only update (finished, PNG saved). Not a reset: a reset that carries the
          // last fresh tiles would make Consoles clear the picture down to those tiles.
          this.renderHeaderChanged = true;
          if (this.wall.scene !== 'off') this.sendWall();
          this.dirty = true;
        },
        (e) => this.say('warn', `Could not save the render: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
    const run = this.run?.jobId === job.id ? this.run : null;
    const seconds = ((job.finishedAt ?? now) - job.createdAt) / 1000;
    const devices = new Set(job.doneBy.filter(Boolean)).size;
    this.db.q.finishJob.run(job.status, job.finishedAt ?? now, JSON.stringify({ seconds, devices, failed: job.failed.size }), job.id);
    if (run) {
      run.status = 'done';
      run.finishedAt = job.finishedAt ?? now;
      const solo = run.soloRate();
      if (solo && !this.experiment) this.db.set(baselineKey(job.kernel, job.params), String(solo));
      this.say('info', `${run.def.title}: finished in ${seconds.toFixed(1)} s on ${devices} device${devices === 1 ? '' : 's'}.`);
    }
    if (this.experiment?.status === 'running') this.experimentStepDone(job, seconds);
    this.nightDone(job, seconds);
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
    if (lab === 'captions') {
      this.cancelRun();
      this.lab = 'captions';
      this.setCaptions(true, options.translate === undefined ? this.captions.translate : !!options.translate);
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
    if (lab === 'translate') {
      this.requireModel('opus-mt-en-es');
      for (const node of this.nodes.values()) if (node.ws && !node.host && !node.status.ready.mt) send(node.ws, { type: 'cmd', cmd: 'prepare', args: { speech: { mt: true } } });
    }
    this.cancelRun();
    const id = `${lab}-${Date.now().toString(36)}`;
    this.db.q.insertJob.run(id, lab, def.kernel, JSON.stringify(def.params), def.total, 'running', Date.now(), extra.tag ?? null);
    this.sched.createJob({ id, kernel: def.kernel, params: def.params, total: def.total, chunk: def.chunk, spotCheck: def.spotCheck, eligible: extra.eligible ?? null });
    this.run = new RunTracker(id, lab, def, Date.now());
    this.lab = lab;
    if (def.kernel === 'render') {
      this.render.begin(id, def.params as unknown as RenderParams, Date.now());
      this.renderReset = true;
    }
    this.broadcastNodes(this.labMsg());
    this.pump();
    return id;
  }

  private requireModel(id: string) {
    const m = this.models.info().find((x) => x.id === id);
    if (!m?.ready) throw new Error(`The ${m?.title ?? id} model is not on the Hub yet. Connect the Hub to the internet once so it can download it (see Models).`);
  }

  setCaptions(on: boolean, translate: boolean) {
    if (on) {
      this.requireModel('whisper-tiny-en');
      if (translate) this.requireModel('opus-mt-en-es');
    }
    const cap = this.captions;
    if (!on) this.stopCaptions();
    else if (!cap.on) {
      cap.orderer.reset();
      cap.seq = 0;
    }
    cap.on = on;
    cap.translate = translate;
    if (on)
      for (const node of this.nodes.values())
        if (node.ws && !node.host && (!node.status.ready.asr || (translate && !node.status.ready.mt))) send(node.ws, { type: 'cmd', cmd: 'prepare', args: { speech: { asr: true, mt: translate } } });
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
      if (row.kernel === 'render' || row.kernel === 'translate') {
        // the picture / pasted text only lived in memory: start again rather than resume
        this.db.q.finishJob.run('cancelled', Date.now(), null, row.id);
        continue;
      }
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

  private startExperiment(lab: LabId, items: number, order: string[], race = false, options: Record<string, unknown> = {}) {
    if (this.experiment?.status === 'running' || this.experiment?.status === 'preparing') throw new Error('An experiment is already running.');
    const ids = order.filter((id) => this.nodes.get(id)?.ws);
    if (!ids.length) throw new Error('Pick at least one connected device.');
    if (race && ids.length < 2) throw new Error('"1 device vs all" needs at least two connected devices.');
    if (lab === 'render') items = labJob('render', options, this.info.datasetCount).total;
    this.experiment = { id: `exp-${Date.now().toString(36)}`, lab, items, order: ids, step: 0, status: 'running', rows: [], race, options };
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
    const eligible = this.experimentDevices(ex);
    const opts = ex.lab === 'sweep' ? { kind: 'pi', batches: ex.items } : ex.lab === 'render' ? { res: ex.options.res, spp: ex.options.spp } : { count: ex.items };
    this.startLab(ex.lab, opts, { eligible, tag: `${ex.id}:${ex.step}` });
  }

  private experimentStepDone(job: Job, seconds: number) {
    const ex = this.experiment!;
    if (!job.eligible) return;
    const names = this.experimentDevices(ex).map((id) => this.nameOf(id));
    const t1 = ex.rows[0]?.seconds ?? seconds;
    const row = { devices: names.length, names, seconds: round(seconds, 2), itemsPerSec: round(job.doneCount / seconds, 2), speedup: round(t1 / seconds, 2) };
    ex.rows.push(row);
    this.db.q.insertSpeedup.run(ex.id, Date.now(), job.id, ex.lab, row.devices, names.join(' + '), job.doneCount, row.seconds, row.itemsPerSec, row.speedup);
    if (ex.lab === 'render') this.refreshRenderRace();
    if (ex.step >= this.experimentSteps(ex)) {
      ex.status = 'done';
      this.say('info', 'Speedup experiment finished. Download the CSV from the Benchmarks tab.');
    } else ex.timer = setTimeout(() => ex.status === 'running' && this.experimentNext(), 2000);
  }

  private experimentDevices(ex: Experiment) {
    if (ex.race) return ex.step <= 1 ? ex.order.slice(0, 1) : ex.order;
    return ex.order.slice(0, ex.step);
  }

  private experimentSteps(ex: Experiment) {
    return ex.race ? 2 : ex.order.length;
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
        this.stopCaptions();
        this.captions.lines = [];
        this.captions.timing = [];
        this.captions.lags = [];
        this.captions.heard = 0;
        this.captions.devices.clear();
        if (this.wall.scene !== 'off') {
          this.wall.scene = 'off';
          this.sendWall();
        }
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
      case 'race': {
        const others = [...this.nodes.values()].filter((n) => n.ws && n.id !== msg.first && ['idle', 'working'].includes(n.status.state)).map((n) => n.id);
        this.startExperiment('render', 0, [String(msg.first), ...others], true, msg.options ?? {});
        break;
      }
      case 'usecase':
        this.usecase = msg.id ? String(msg.id).slice(0, 40) : null;
        this.db.set('usecase', this.usecase ?? '');
        break;
      case 'render-sync':
        break; // handled per console in attachConsole
      case 'wall': {
        if (Array.isArray(msg.order)) {
          const ids = msg.order.map(String).filter((id) => this.nodes.has(id));
          this.wall.order = [...ids, ...this.wall.order.filter((id) => !ids.includes(id))];
        }
        if (msg.gap !== undefined) this.wall.gap = clampGap(Number(msg.gap));
        if (msg.scene && ['off', 'black', 'wake', 'image', 'sweep', 'show'].includes(msg.scene)) {
          this.wall.scene = msg.scene;
          this.wall.at = Date.now() + 800; // a little lead time so every screen starts together
        }
        this.saveWall();
        this.sendWall();
        break;
      }
      case 'captions':
        if (msg.on && this.lab !== 'captions') this.startLab('captions', { translate: msg.translate });
        else this.setCaptions(!!msg.on, msg.translate === undefined ? this.captions.translate : !!msg.translate);
        break;
      case 'caption-audio':
        this.captionAudio(msg.pcm, Number(msg.sampleRate));
        break;
      case 'captions-clear':
        this.captions.lines = [];
        this.captions.timing = [];
        this.captions.lags = [];
        this.captions.heard = 0;
        this.captions.devices.clear();
        break;
      case 'night': {
        const ns = this.night;
        if (msg.action === 'add' && msg.lab) {
          if (!['swarm-sort', 'sweep', 'render', 'tutor', 'translate'].includes(msg.lab)) throw new Error('That Lab cannot run on the Night Shift.');
          const def = labJob(msg.lab, msg.options ?? {}, this.info.datasetCount); // validates the options now
          ns.queue.push({ id: crypto.randomBytes(4).toString('hex'), lab: msg.lab, title: `${LAB_TITLES[msg.lab] ?? msg.lab}: ${def.title}`, options: msg.options ?? {}, status: 'waiting', addedAt: Date.now(), finishedAt: null, seconds: null });
        }
        if (msg.action === 'remove') ns.queue = ns.queue.filter((q) => q.id !== msg.id || q.status === 'running');
        if (msg.action === 'arm') ns.armed = true;
        if (msg.action === 'disarm') ns.armed = false;
        if (msg.action === 'clear-done') ns.queue = ns.queue.filter((q) => q.status === 'waiting' || q.status === 'running');
        if (msg.action === 'allow-unknown') ns.allowUnknown = !!msg.on;
        this.saveNight();
        break;
      }
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
        if (msg.what === 'speedup') {
          this.db.q.clearSpeedup.run();
          this.refreshRenderRace();
        }
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
    const baseline = this.run ? Number(this.db.get(baselineKey(this.run.def.kernel, this.run.def.params))) || null : null;
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
        ? { id: ex.id, lab: ex.lab, items: ex.items, order: ex.order.map((id) => this.nameOf(id)), step: ex.step, steps: this.experimentSteps(ex), status: ex.status, rows: ex.rows, race: ex.race }
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
      usecase: this.usecase,
      wall: {
        scene: this.wall.scene,
        at: this.wall.at,
        gap: this.wall.gap,
        order: this.wallDevices().map((n) => n.id),
        devices: [...this.nodes.values()]
          .filter((n) => !n.host && n.ws)
          .map((n) => ({ id: n.id, name: n.name, screen: n.screen, clock: n.clock, online: !!n.ws })),
        image: this.wallImageUrl(),
      },
      captions: {
        on: this.captions.on,
        translate: this.captions.translate,
        lines: this.captions.lines.slice(-12),
        pending: this.captions.orderer.pending,
        lagSec: median(this.captions.lags),
        audioSecondsHeard: round(this.captions.heard, 1),
        audioSecondsSaved: 0,
        devices: [...this.captions.devices],
        timedLines: this.captions.timing.length,
      },
      renderRace: this.renderRace,
      nightShift: { queue: this.night.queue, armed: this.night.armed, eligible: this.nightEligible().map((id) => this.nameOf(id)), allowUnknownBattery: this.night.allowUnknown },
      fleet: this.fleetInputs(),
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

function clampGap(v: number) {
  return Number.isFinite(v) ? Math.max(0, Math.min(400, Math.round(v))) : 40;
}

function median(a: number[]) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2, 1);
}

/** 1-device baselines are only comparable for the same work: renders depend on size and quality. */
function baselineKey(kernel: string, params: Record<string, unknown>) {
  return kernel === 'render' ? `baseline:render:${params.width}x${params.height}@${params.spp}` : `baseline:${kernel}`;
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
  const states = ['idle', 'working', 'paused-unplugged', 'paused-input', 'stopped', 'hidden', 'preparing'];
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
      asr: !!st?.ready?.asr,
      mt: !!st?.ready?.mt,
    },
    fedPhotos: Array.isArray(st?.fedPhotos) ? st!.fedPhotos.slice(0, 3).map((v) => Math.max(0, Math.min(10000, Number(v) || 0))) : [0, 0, 0],
  };
}
