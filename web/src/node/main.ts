// Recompute node page: any browser joins the classroom lab by scanning a QR code.
// Join mode = a student's everyday device. Reborn mode (?mode=reborn) = a
// full-screen, compute-only page for an expired device in a charging cart.

import { h, clear, fmtInt, fmtNum, fmtTime, fmtBytes, toast } from '../shared/dom';
import { defaultWorkers, isMobile, probeCaps, deviceType } from '../shared/device';
import { HubSocket } from '../shared/socket';
import { fetchCached } from '../shared/filecache';
import type { BatteryState, Capabilities, HubToNode, Kernel, LabId, LeaseMsg, ModelInfo, NodeState, NodeStatus, NodeToHub } from '../shared/protocol';
import { Scheduler } from '../shared/scheduler';
import { labJob, compareOutputs } from '../../../hub/src/labs';
import { Engine, imageUrl } from './engine';
import { Teach } from './teach';
import { Tutor } from './tutor';

const qs = new URLSearchParams(location.search);
const MODE: 'join' | 'reborn' = qs.get('mode') === 'reborn' ? 'reborn' : 'join';
/** Hidden node inside the Console on the Hub computer ("This computer computes too"). */
const HOST = qs.get('host') === '1' && window.parent !== window;
// The Hub node keeps its own settings so it never clashes with a normal join tab in the same browser.
const LS_PREFIX = HOST ? 'recompute.host.' : 'recompute.';
const LS = {
  get: (k: string) => {
    try {
      return localStorage.getItem(`${LS_PREFIX}${k}`);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string | null) => {
    try {
      if (v === null) localStorage.removeItem(`${LS_PREFIX}${k}`);
      else localStorage.setItem(`${LS_PREFIX}${k}`, v);
    } catch {}
  },
};

const type = deviceType();
const WORKERS = Math.max(1, Math.min(16, Number(qs.get('workers')) || defaultWorkers()));
const GPU = qs.get('gpu') === '1';
const AUTOLOAD = qs.get('autoload') !== '0';

// ---------- state ----------
let room = (qs.get('room') ?? LS.get('room') ?? '').replace(/\D/g, '').slice(0, 6);
let nodeId = LS.get('nodeId') ?? undefined;
let name = LS.get('name') ?? '';
let caps: Capabilities;
let welcomed = false;
let hubModels: ModelInfo[] = safeJson(LS.get('models')) ?? [];
let datasetCount = Number(LS.get('datasetCount')) || 1000;
let stopped = false;
let battery: BatteryState = 'unknown';
let allowBattery = false;
let lab: { lab: LabId | null; jobId: string | null; canLaunch: boolean; demo: boolean } = { lab: null, jobId: null, canLaunch: false, demo: false };
let progress: Extract<HubToNode, { type: 'progress' }> | null = null;
let preparing = 0;
let preparingText = '';
let imagesCached = 0;
let itemsDone = Number(LS.get('itemsDone')) || 0;
let lastError: string | null = null;
let hubGoneSince: number | null = null;
let solo: { title: string; done: number; total: number; started: number; finished: number | null; unit: string; extra: string; cancel: boolean } | null = null;
const outstanding = { cpu: 0, llm: 0 };
let lastKernels = { cpu: '', llm: '' };
const active = new Map<string, { jobId: string; pool: 'cpu' | 'llm'; kernel: Kernel; n: number; abort?: AbortController }>();
const cancelledJobs = new Set<string>();
const completions: { t: number; n: number }[] = [];

const engine = new Engine(WORKERS, {
  onChange: () => schedule(),
  onThrottle: (_lvl, reason) => {
    toast(`Thermal backoff: ${reason}`, 'warn');
    schedule();
  },
});
const tutor = new Tutor(() => {
  schedule();
  topUp();
});
let teach: Teach;
let sock: HubSocket<HubToNode, NodeToHub> | null = null;

function safeJson<T>(s: string | null): T | null {
  try {
    return s ? (JSON.parse(s) as T) : null;
  } catch {
    return null;
  }
}

function send(m: NodeToHub) {
  sock?.send(m);
}

// ---------- device state ----------
function nodeState(): NodeState {
  if (stopped) return 'stopped';
  if (document.hidden && isMobile(type)) return 'hidden';
  if (battery === 'on-battery' && !allowBattery) return 'paused-unplugged';
  if (active.size > 0 || solo?.finished === null) return 'working';
  if (preparing > 0) return 'preparing';
  return 'idle';
}
const canCompute = () => ['idle', 'working', 'preparing'].includes(nodeState());

function rate() {
  const now = performance.now();
  while (completions.length && completions[0].t < now - 6000) completions.shift();
  const n = completions.reduce((s, c) => s + c.n, 0);
  return n / 6;
}

function status(): NodeStatus {
  return {
    state: nodeState(),
    battery,
    throttle: engine.throttle,
    activeWorkers: engine.busy + (tutor.busy ? 1 : 0),
    rate: Math.round(rate() * 100) / 100,
    ready: { mobilenet: engine.modelReady, dataset: imagesCached, tutor: tutor.ready ? tutor.modelId : null },
    fedPhotos: teach?.counts ?? [0, 0, 0],
  };
}

let lastStatusKey = '';
let lastStatusAt = 0;
function sendStatus(force = false) {
  if (!welcomed) return;
  const st = status();
  const key = JSON.stringify({ ...st, rate: Math.round(st.rate) });
  const now = Date.now();
  if (!force && key === lastStatusKey && now - lastStatusAt < 2000) return;
  const prevState = safeJson<NodeStatus>(lastStatusKey)?.state;
  lastStatusKey = key;
  lastStatusAt = now;
  send({ type: 'status', status: st });
  // Leaving a working state: the Hub drops our credits, so forget them too.
  if (!['idle', 'working', 'preparing'].includes(st.state)) {
    outstanding.cpu = outstanding.llm = 0;
    lastKernels = { cpu: '', llm: '' };
  } else if (prevState && !['idle', 'working', 'preparing'].includes(prevState)) topUp();
}

/** Tell the Hub how many more chunks we can take, and which kernels we have ready. */
function topUp() {
  if (!sock?.open || !welcomed || !canCompute() || solo?.finished === null) return;
  const cpuKernels: Kernel[] = ['pi', 'sir'];
  if (engine.modelReady) cpuKernels.unshift('classify');
  const runningCpu = [...active.values()].filter((a) => a.pool === 'cpu').length;
  const needCpu = engine.enabled - runningCpu - outstanding.cpu;
  const kc = cpuKernels.join();
  if (needCpu > 0 || kc !== lastKernels.cpu) {
    const n = Math.max(0, needCpu);
    send({ type: 'want', pool: 'cpu', slots: n, kernels: cpuKernels });
    outstanding.cpu += n;
    lastKernels.cpu = kc;
  }
  const llmKernels: Kernel[] = tutor.ready ? ['tutor'] : [];
  const runningLlm = [...active.values()].filter((a) => a.pool === 'llm').length;
  const needLlm = (tutor.ready && !chatBusy ? 1 : 0) - runningLlm - outstanding.llm;
  const kl = llmKernels.join();
  if (needLlm > 0 || kl !== lastKernels.llm) {
    const n = Math.max(0, needLlm);
    send({ type: 'want', pool: 'llm', slots: n, kernels: llmKernels });
    outstanding.llm += n;
    lastKernels.llm = kl;
  }
}

async function onLease(m: LeaseMsg) {
  const pool = m.kernel === 'tutor' ? 'llm' : 'cpu';
  outstanding[pool] = Math.max(0, outstanding[pool] - 1);
  if (!canCompute() || cancelledJobs.has(m.jobId)) {
    send({ type: 'release', leaseIds: [m.leaseId] });
    return;
  }
  const rec = { jobId: m.jobId, pool, kernel: m.kernel, n: m.items.length } as const;
  const abort = pool === 'llm' ? new AbortController() : undefined;
  active.set(m.leaseId, { ...rec, abort });
  schedule();
  sendStatus();
  try {
    let outputs: unknown[];
    let ms: number;
    if (pool === 'llm') {
      const t0 = performance.now();
      const questions = m.params.questions as string[];
      outputs = [];
      for (const i of m.items) {
        swarmAnswering = questions[i];
        schedule();
        const r = await tutor.ask(questions[i], { maxTokens: Number(m.params.maxTokens) || 96, signal: abort!.signal });
        outputs.push({ text: r.text, tokens: r.tokens, seconds: r.seconds, model: tutor.modelId });
        swarmLog.unshift({ q: questions[i], a: r.text, tps: r.tokPerSec });
      }
      swarmAnswering = null;
      ms = performance.now() - t0;
    } else {
      if (m.kernel === 'classify' && !engine.modelReady) await ensureModel();
      ({ outputs, ms } = await engine.run(m.kernel, m.params, m.items));
      if (m.kernel === 'classify') imagesCached = Math.max(imagesCached, Math.min(datasetCount, imagesCached + m.items.length));
    }
    if (!cancelledJobs.has(m.jobId)) {
      send({ type: 'result', leaseId: m.leaseId, outputs, ms: Math.round(ms) });
      completions.push({ t: performance.now(), n: m.items.length });
      itemsDone += m.items.length;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg !== 'cancelled' && !cancelledJobs.has(m.jobId)) {
      lastError = msg;
      send({ type: 'fail', leaseId: m.leaseId, error: msg });
    }
  } finally {
    swarmAnswering = null;
    active.delete(m.leaseId);
    topUp();
    schedule();
    sendStatus();
  }
}

// ---------- model / data preparation ----------
function modelInfo(id: string) {
  return hubModels.find((m) => m.id === id);
}

async function withPreparing<T>(text: string, fn: () => Promise<T>): Promise<T> {
  preparing++;
  preparingText = text;
  schedule();
  sendStatus();
  try {
    return await fn();
  } finally {
    preparing--;
    if (!preparing) preparingText = '';
    schedule();
    sendStatus();
    topUp();
  }
}

async function ensureModel() {
  if (engine.modelReady) return;
  const info = modelInfo('mobilenetv3');
  if (!info?.ready) throw new Error('The image model is not on the Hub yet.');
  await withPreparing('Loading the image model…', () =>
    engine.loadModel(info, {
      gpu: GPU,
      onProgress: (f) => {
        preparingText = `Downloading the image model… ${Math.round(f * 100)}%`;
        schedule();
      },
    }),
  ).catch((e) => {
    lastError = `Image model: ${e instanceof Error ? e.message : e}`;
    toast(lastError, 'warn');
    throw e;
  });
}

async function preloadImages() {
  await withPreparing('Saving the photo set on this device…', async () => {
    let done = 0;
    const next = { i: 0 };
    const worker = async () => {
      while (next.i < datasetCount) {
        const i = next.i++;
        await fetchCached(imageUrl(i)).catch(() => {});
        done++;
        if (done % 25 === 0) {
          imagesCached = done;
          preparingText = `Saving the photo set on this device… ${done}/${datasetCount}`;
          schedule();
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    imagesCached = done;
  });
}

async function loadTutor(id: string) {
  const info = modelInfo(id);
  if (!info?.ready) {
    toast('That tutor model is not on the Hub yet.', 'warn');
    return;
  }
  if (tutor.modelId === id) return;
  await withPreparing(`Loading the ${info.title} tutor…`, () =>
    tutor.load(info, (f) => {
      preparingText = `Loading the ${info.title} tutor… ${Math.round(f * 100)}% of ${fmtBytes(info.sizeBytes)}`;
      schedule();
    }),
  ).catch((e) => {
    lastError = `Tutor: ${e instanceof Error ? e.message : e}`;
    toast(lastError, 'warn');
  });
}

// ---------- hub connection ----------
function connect() {
  sock?.close();
  welcomed = false;
  sock = new HubSocket<HubToNode, NodeToHub>('/ws?role=node', {
    onOpen: async () => {
      hubGoneSince = null;
      caps ??= await probeCaps(WORKERS);
      outstanding.cpu = outstanding.llm = 0;
      lastKernels = { cpu: '', llm: '' };
      send({ type: 'hello', role: 'node', room, nodeId, name: name || undefined, mode: MODE, caps, status: status(), ...(HOST ? { host: true } : {}) });
      schedule();
    },
    onClose: (code) => {
      welcomed = false;
      hubGoneSince ??= Date.now();
      // Work in flight will be re-issued by the Hub to someone else (lease timeout).
      for (const a of active.values()) a.abort?.abort();
      if (code === 4001) {
        LS.set('room', null);
        room = '';
        sock?.close();
        sock = null;
        render();
        return;
      }
      if (code === 4002) {
        replaced = true;
        render();
        return;
      }
      schedule();
    },
    onMessage: (m) => void onMessage(m),
  });
}

async function onMessage(m: HubToNode) {
  switch (m.type) {
    case 'welcome':
      welcomed = true;
      nodeId = m.nodeId;
      name = m.name;
      room = m.room;
      hubModels = m.models;
      datasetCount = m.dataset.count;
      LS.set('nodeId', nodeId);
      LS.set('name', name);
      LS.set('room', room);
      LS.set('models', JSON.stringify(hubModels));
      LS.set('datasetCount', String(datasetCount));
      lastStatusKey = '';
      sendStatus(true);
      topUp();
      if (AUTOLOAD && !engine.modelReady && modelInfo('mobilenetv3')?.ready) ensureModel().catch(() => {});
      schedule();
      break;
    case 'error':
      toast(m.message, 'warn', 9000);
      lastError = m.message;
      if (m.fatal) roomError = m.message;
      schedule();
      break;
    case 'lease':
      void onLease(m);
      break;
    case 'cancel':
      cancelledJobs.add(m.jobId);
      engine.cancelQueued();
      for (const a of active.values()) if (a.jobId === m.jobId) a.abort?.abort();
      schedule();
      break;
    case 'cmd':
      if (m.cmd === 'stop') setStopped(true, 'The teacher paused this device.');
      else if (m.cmd === 'resume') setStopped(false);
      else if (m.cmd === 'rename' && typeof m.args?.name === 'string') {
        name = m.args.name;
        LS.set('name', name);
      } else if (m.cmd === 'prepare') {
        const a = m.args ?? {};
        if (a.mobilenet || a.all) await ensureModel().catch(() => {});
        if (a.images || a.all) await preloadImages();
        if (typeof a.tutor === 'string') await loadTutor(a.tutor);
      }
      schedule();
      break;
    case 'lab': {
      const prev = lab.lab;
      lab = { lab: m.lab, jobId: m.jobId, canLaunch: m.canLaunch, demo: m.demo };
      if (m.jobId) cancelledJobs.delete(m.jobId);
      if (MODE === 'join' && m.lab !== prev) {
        if (m.lab === 'teach') showTab('teach');
        else if (m.lab && tab === 'teach') showTab('compute');
      }
      if (m.lab === 'swarm-sort' && !engine.modelReady) ensureModel().catch(() => {});
      schedule();
      break;
    }
    case 'progress':
      progress = m;
      schedule();
      break;
    case 'models':
      hubModels = m.models;
      LS.set('models', JSON.stringify(hubModels));
      if (AUTOLOAD && !engine.modelReady && modelInfo('mobilenetv3')?.ready) ensureModel().catch(() => {});
      schedule();
      break;
    case 'fed:round':
    case 'fed:model':
    case 'fed:reset':
      await teach.onMessage(m);
      break;
  }
}

function setStopped(v: boolean, why?: string) {
  stopped = v;
  if (v) {
    engine.cancelQueued();
    for (const a of active.values()) a.abort?.abort();
    if (solo) solo.cancel = true;
    if (why) toast(why, 'warn');
  }
  sendStatus(true);
  if (!v) topUp();
  void updateWakeLock();
  schedule();
}

// ---------- battery & wake lock ----------
async function watchBattery() {
  const nav = navigator as unknown as { getBattery?: () => Promise<{ charging: boolean; addEventListener: (e: string, f: () => void) => void }> };
  if (!nav.getBattery) return; // Safari & Firefox: unknown, we say so honestly
  try {
    const b = await nav.getBattery();
    const upd = () => {
      battery = b.charging ? 'charging' : 'on-battery';
      sendStatus(true);
      if (canCompute()) topUp();
      else engine.cancelQueued();
      schedule();
    };
    b.addEventListener('chargingchange', upd);
    upd();
  } catch {}
}

let wakeLock: { release: () => Promise<void>; released?: boolean } | null = null;
async function updateWakeLock() {
  const want = !document.hidden && (MODE === 'reborn' || (!stopped && welcomed));
  const wl = (navigator as unknown as { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void>; released?: boolean }> } }).wakeLock;
  if (!wl || HOST) return;
  if (want && (!wakeLock || wakeLock.released)) {
    try {
      wakeLock = await wl.request('screen');
    } catch {}
  } else if (!want && wakeLock) {
    await wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}
document.addEventListener('visibilitychange', () => {
  void updateWakeLock();
  if (document.hidden && isMobile(type)) {
    engine.cancelQueued();
    for (const a of active.values()) a.abort?.abort();
  }
  sendStatus(true);
  if (!document.hidden) topUp();
  if (tab === 'teach') void teach.show(!document.hidden);
  schedule();
});

// ---------- solo mode (Hub unreachable) ----------
async function runSolo(labId: 'swarm-sort' | 'sweep', options: Record<string, unknown> = {}) {
  if (solo && solo.finished === null) return;
  if (labId === 'swarm-sort') {
    try {
      await ensureModel();
    } catch {
      toast('The image model has never been saved on this device, so Swarm Sort can’t run without the Hub.', 'warn', 9000);
      return;
    }
  }
  const def = labJob(labId, options, datasetCount);
  const sched = new Scheduler({ compare: compareOutputs });
  const job = sched.createJob({ id: 'solo', kernel: def.kernel, params: def.params, total: def.total, chunk: def.chunk, spotCheck: false });
  const s = { title: def.title, done: 0, total: def.total, started: performance.now(), finished: null as number | null, unit: def.unit, extra: '', cancel: false };
  solo = s;
  let inside = 0;
  let samples = 0;
  sendStatus(true);
  const loop = async () => {
    while (!s.cancel && job.status === 'running') {
      if (!canCompute()) {
        await sleep(300);
        continue;
      }
      const lease = sched.request('me', [def.kernel]);
      if (!lease) {
        await sleep(50);
        continue;
      }
      try {
        const r = await engine.run(lease.kernel, lease.params, lease.items);
        sched.complete(lease.id, 'me', r.outputs, r.ms);
        s.done += lease.items.length;
        itemsDone += lease.items.length;
        completions.push({ t: performance.now(), n: lease.items.length });
        if (def.kernel === 'pi')
          for (const o of r.outputs as { inside: number; samples: number }[]) {
            inside += o.inside;
            samples += o.samples;
          }
        if (samples) s.extra = `π ≈ ${((4 * inside) / samples).toFixed(6)}`;
        schedule();
      } catch {
        sched.fail(lease.id, 'me', 'error');
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, engine.enabled) }, loop));
  s.finished = performance.now();
  sendStatus(true);
  schedule();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- UI ----------
let tab: 'compute' | 'teach' | 'tutor' | 'device' = 'compute';
let roomError: string | null = null;
/** The Hub switched to a newer tab of this device; this one stays quiet until asked. */
let replaced = false;
let chatBusy = false;
let swarmAnswering: string | null = null;
const swarmLog: { q: string; a: string; tps: number | null }[] = [];
const app = document.getElementById('app')!;
let renderPending = false;

function schedule() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => {
    renderPending = false;
    update();
  });
}

function brand() {
  return h('div', { class: 'brand' }, h('img', { src: '/static/icon.svg', alt: '' }), h('div', null, h('div', { class: 'name' }, 'Re', h('b', null, 'compute')), h('div', { class: 'tagline small' }, 'Rethink. Reuse. Recompute.')));
}

function render() {
  if (replaced) return renderReplaced();
  if (!room) return renderRoomEntry();
  if (MODE === 'reborn') return renderReborn();
  renderJoin();
}

function renderReplaced() {
  const again = h('button', { class: 'go-btn primary' }, 'Use this tab instead');
  again.onclick = () => {
    replaced = false;
    render();
    connect();
  };
  clear(app, h('div', { class: 'node-wrap' }, brand(), h('div', { class: 'card col' }, h('h2', null, 'Recompute is open in another tab'), h('p', { class: 'muted' }, 'This device is already computing from a newer tab or window, so this one stepped aside. Close this tab, or switch back here.'), again)));
}

function renderRoomEntry() {
  const input = h('input', { class: 'room-input', inputmode: 'numeric', autocomplete: 'off', maxlength: '6', placeholder: '000000', 'aria-label': 'Room code' }) as HTMLInputElement;
  const go = h('button', { class: 'go-btn primary' }, 'Join the lab');
  const submit = () => {
    const v = input.value.replace(/\D/g, '');
    if (v.length !== 6) {
      toast('The room code has 6 digits — it’s on the teacher’s screen.', 'warn');
      return;
    }
    room = v;
    roomError = null;
    LS.set('room', room);
    render();
    connect();
  };
  go.onclick = submit;
  input.onkeydown = (e) => e.key === 'Enter' && submit();
  clear(
    app,
    h(
      'div',
      { class: 'node-wrap' },
      brand(),
      banners(),
      h('div', { class: 'card col' }, h('h2', null, 'Enter the room code'), roomError ? h('div', { class: 'banner bad' }, roomError) : null, input, go, h('p', { class: 'muted small' }, 'Scan the QR code on the teacher’s screen, or type the 6-digit code shown under it.')),
    ),
  );
  input.focus();
}

function banners() {
  const out: HTMLElement[] = [];
  if (!isSecureContext)
    out.push(
      h(
        'div',
        { class: 'banner warn' },
        'Basic mode (http): Swarm Sort and Science Sweep work, but there is no live camera and the tutor is slower. ',
        h('a', { href: '/trust' }, 'Set up secure mode →'),
      ),
    );
  return h('div', null, ...out);
}

// Elements updated in place by update()
const els = {
  conn: h('span', { class: 'pill' }),
  name: h('span', { class: 'num' }),
  state: h('div', { class: 'state' }),
  sub: h('div', { class: 'sub' }),
  timer: h('div', { class: 'big hidden' }),
  progBar: h('div', { class: 'bar hidden' }, h('i')),
  progText: h('div', { class: 'muted' }),
  stop: h('button', { class: 'stop-btn danger' }, 'STOP'),
  battery: h('span'),
  workers: h('span'),
  mine: h('span'),
  launch: h('div', { class: 'col' }),
  solo: h('div', { class: 'card col hidden' }),
  tabs: h('div', { class: 'tabs' }),
  pane: h('div'),
  computePane: h('div', { class: 'col' }),
  tutorPane: h('div', { class: 'card col' }),
  devicePane: h('div', { class: 'card col' }),
  rebornCount: h('div', { class: 'huge num' }),
  rebornRate: h('div', { class: 'label' }),
  rebornState: h('div', { class: 'name' }),
  pulse: h('span', { class: 'pulse idle' }),
  battBtn: h('button', { class: 'small hidden' }, 'Use battery anyway (this session)'),
};
els.stop.onclick = () => setStopped(!stopped, stopped ? undefined : 'Stopped. This device is not computing.');
els.battBtn.onclick = () => {
  allowBattery = true;
  sendStatus(true);
  topUp();
  schedule();
};

function renderJoin() {
  const tabBtn = (id: typeof tab, label: string) => {
    const b = h('button', { 'data-tab': id }, label);
    b.onclick = () => showTab(id);
    return b;
  };
  clear(els.tabs, tabBtn('compute', '⚡ Compute'), tabBtn('teach', '📷 Teach'), tabBtn('tutor', '💬 Tutor'), tabBtn('device', 'ⓘ Device'));
  clear(
    els.computePane,
    h('div', { class: 'card node-status' }, els.state, els.sub, els.timer, els.progBar, els.progText),
    els.stop,
    els.launch,
    els.solo,
    h(
      'div',
      { class: 'card kv' },
      h('span', { class: 'k' }, 'Power'),
      h('span', null, els.battery, ' ', els.battBtn),
      h('span', { class: 'k' }, 'Workers'),
      els.workers,
      h('span', { class: 'k' }, 'This device'),
      els.mine,
    ),
  );
  buildTutorPane();
  clear(app, h('div', { class: 'node-wrap' }, h('div', { class: 'node-head' }, brand(), h('div', { class: 'col', style: 'align-items:flex-end;gap:4px' }, els.name, els.conn)), banners(), els.tabs, els.pane));
  showTab(tab);
}

function showTab(t: typeof tab) {
  tab = t;
  if (MODE !== 'join' || !room) return;
  for (const b of els.tabs.querySelectorAll('button')) b.classList.toggle('on', b.getAttribute('data-tab') === t);
  const pane = t === 'compute' ? els.computePane : t === 'teach' ? teach.el : t === 'tutor' ? els.tutorPane : els.devicePane;
  if (els.pane.firstChild !== pane) clear(els.pane, pane);
  void teach.show(t === 'teach' && !document.hidden);
  if (t === 'device') renderDevice();
  schedule();
}

function renderReborn() {
  document.body.classList.add('reborn');
  const stop = h('button', { class: 'danger', style: 'font-size:22px;padding:14px 30px' }, 'STOP');
  stop.onclick = () => {
    setStopped(!stopped);
    stop.textContent = stopped ? 'RESUME' : 'STOP';
  };
  const fs = h('button', { class: 'ghost small' }, 'Full screen');
  fs.onclick = () => document.documentElement.requestFullscreen?.().catch(() => {});
  clear(
    app,
    h(
      'div',
      { class: 'reborn-wrap' },
      brand(),
      h('div', { class: 'row', style: 'justify-content:center' }, els.pulse, els.rebornState),
      els.name,
      els.rebornCount,
      els.rebornRate,
      els.conn,
      banners(),
      h('div', { class: 'row', style: 'justify-content:center' }, stop, fs),
      h('div', { class: 'muted small' }, 'Reborn mode: this device is a compute-only node. Keep it plugged in.'),
    ),
  );
}

function buildTutorPane() {
  const chat = h('div', { class: 'chat' });
  const input = h('textarea', { rows: '2', placeholder: 'Ask the tutor a question…', style: 'width:100%' }) as HTMLTextAreaElement;
  const ask = h('button', { class: 'primary' }, 'Ask');
  const loadBtns = h('div', { class: 'row' });
  const info = h('div', { class: 'muted small' });
  const swarm = h('div', { class: 'col small' });
  const doAsk = async () => {
    const q = input.value.trim();
    if (!q) return;
    if (!tutor.ready) {
      toast('Load a tutor model first.', 'warn');
      return;
    }
    input.value = '';
    chat.append(h('div', { class: 'msg user' }, q));
    const bot = h('div', { class: 'msg bot' }, '…');
    chat.append(bot);
    chat.scrollTop = chat.scrollHeight;
    chatBusy = true;
    try {
      const r = await tutor.ask(q, {
        onToken: (t) => {
          bot.textContent = t;
          chat.scrollTop = chat.scrollHeight;
        },
      });
      bot.append(h('div', { class: 'muted small' }, `${r.tokens} tokens · ${fmtNum(r.tokPerSec ?? 0)} tokens/s · on this device`));
    } catch (e) {
      bot.textContent = `Error: ${e instanceof Error ? e.message : e}`;
    } finally {
      chatBusy = false;
      topUp();
    }
  };
  ask.onclick = () => void doAsk();
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void doAsk();
    }
  };
  clear(
    els.tutorPane,
    h('h2', null, 'Private Tutor'),
    h('p', { class: 'lead' }, 'A small AI model that runs ', h('b', null, 'entirely on this device'), '. Nothing you type leaves it, and it works with the internet unplugged.'),
    loadBtns,
    info,
    chat,
    h('div', { class: 'row' }, h('div', { class: 'grow' }, input), ask),
    h(
      'p',
      { class: 'muted small' },
      'Honest note: joining the swarm does not make one answer faster. Swarm mode spreads a whole list of class questions across devices, so the list finishes sooner (more answers per minute).',
    ),
    swarm,
  );
  const upd = () => {
    clear(
      loadBtns,
      ...hubModels
        .filter((m) => m.kind === 'gguf')
        .map((m) => {
          const b = h('button', { class: tutor.modelId === m.id ? 'primary' : '' }, tutor.modelId === m.id ? `✓ ${m.title}` : `Load ${m.title} (${fmtBytes(m.sizeBytes)})`);
          b.disabled = !m.ready || !!tutor.loading;
          b.onclick = () => void loadTutor(m.id);
          return b;
        }),
    );
    info.textContent = tutor.ready
      ? `Ready: ${tutor.modelId} · ${tutor.threads} thread${tutor.threads === 1 ? '' : 's'}${tutor.lastTokPerSec ? ` · last ${fmtNum(tutor.lastTokPerSec)} tokens/s` : ''}`
      : tutor.loading
        ? preparingText
        : tutor.error
          ? `Could not load: ${tutor.error}`
          : hubModels.some((m) => m.kind === 'gguf' && m.ready)
            ? 'The model is downloaded once from the Hub, then kept on this device.'
            : 'The tutor model has not been downloaded to the Hub yet.';
    ask.disabled = !tutor.ready;
    clear(
      swarm,
      swarmAnswering ? h('div', { class: 'pill info' }, `Swarm: answering “${swarmAnswering}”`) : null,
      ...swarmLog.slice(0, 3).map((s) => h('div', null, h('b', null, s.q), h('div', { class: 'muted' }, s.a))),
    );
  };
  tutorUpdate = upd;
  upd();
}
let tutorUpdate: () => void = () => {};

function renderDevice() {
  const c = caps;
  const kv = (k: string, v: string) => [h('span', { class: 'k' }, k), h('span', null, v)];
  const clearBtn = h('button', { class: 'small' }, 'Delete saved models & photos set');
  clearBtn.onclick = async () => {
    const { clearCached } = await import('../shared/filecache');
    await clearCached();
    toast('Cleared the saved files on this device.');
  };
  clear(
    els.devicePane,
    h('h2', null, 'This device'),
    h(
      'div',
      { class: 'kv' },
      ...kv('Name', name || '—'),
      ...kv('Type', `${c?.deviceType ?? type} · ${c?.browser ?? ''}`),
      ...kv('CPU cores', String(c?.cores ?? navigator.hardwareConcurrency)),
      ...kv('Workers used', `${WORKERS} (cores − 1${isMobile(type) ? ', max 2 on phones' : ''})`),
      ...kv('Memory', c?.memoryGB ? `${c.memoryGB} GB (as reported by the browser)` : 'not reported by this browser'),
      ...kv('WebGPU', c?.webgpu ?? 'not available'),
      ...kv('Secure page', isSecureContext ? 'yes (https)' : 'no (http basic mode)'),
      ...kv('Multi-threaded WASM', crossOriginIsolated ? 'yes' : 'no'),
      ...kv('Image model', engine.modelReady ? `ready (${engine.backend})` : engine.modelError ? `error: ${engine.modelError}` : 'not loaded'),
      ...kv('Power', batteryText()),
      ...kv('Items computed here', fmtInt(itemsDone)),
    ),
    h('div', { class: 'row' }, h('a', { href: '/bench', class: 'step-btn', style: 'font-size:16px;padding:10px 14px' }, 'Run the benchmark'), clearBtn),
    h('p', { class: 'muted small' }, 'Recompute runs only its own built-in programs (image labelling, π, epidemic simulation, tutor). It never runs code sent over the network, has no accounts, and sends no analytics.'),
  );
}

function batteryText() {
  if (battery === 'charging') return '🔌 Plugged in';
  if (battery === 'on-battery') return allowBattery ? '🔋 On battery (allowed this session)' : '🔋 On battery — paused until plugged in';
  return '❔ Unknown on this browser — please keep it plugged in';
}

function stateText(): [string, string] {
  const st = nodeState();
  if (!welcomed) {
    if (hubGoneSince && Date.now() - hubGoneSince > 4000) return ['Hub not reachable', 'Retrying… you can still run labs on this device alone.'];
    return ['Connecting…', `Room ${room}`];
  }
  switch (st) {
    case 'stopped':
      return ['Stopped', 'Not computing. Tap Resume to help again.'];
    case 'hidden':
      return ['Paused', 'Keep this page open on screen to help.'];
    case 'paused-unplugged':
      return ['Paused: plug me in', 'Recompute only computes while charging.'];
    case 'preparing':
      return ['Getting ready', preparingText];
    case 'working':
      return ['Computing', labTitle()];
    default:
      return ['Ready', lab.lab ? `Waiting for work · ${labTitle()}` : 'Waiting for the teacher to start a lab.'];
  }
}

function labTitle() {
  return { 'swarm-sort': 'Swarm Sort', teach: 'Teach the Swarm', tutor: 'Private Tutor', sweep: 'Science Sweep' }[lab.lab ?? 'swarm-sort'] ?? '';
}

function update() {
  if (!room || replaced) return;
  if (MODE === 'reborn' && !app.querySelector('.reborn-wrap')) renderReborn();
  const [s, sub] = stateText();
  const st = nodeState();
  els.conn.className = `pill ${welcomed ? 'ok' : 'warn'}`;
  els.conn.textContent = welcomed ? `● Connected · room ${room}` : hubGoneSince ? '● Hub offline — retrying' : '● Connecting…';
  els.name.textContent = name || '';
  els.state.textContent = s;
  els.sub.textContent = sub;
  els.stop.textContent = stopped ? 'RESUME' : 'STOP';
  els.stop.className = `stop-btn ${stopped ? 'primary' : 'danger'}`;
  els.battery.textContent = batteryText();
  els.battBtn.classList.toggle('hidden', !(battery === 'on-battery' && !allowBattery));
  els.workers.textContent = `${engine.busy} busy of ${engine.enabled}${engine.throttle ? ` (cooling: −${engine.throttle})` : ''} · ${engine.modelReady ? `image model ready (${engine.backend})` : 'image model not loaded'}`;
  els.mine.textContent = `${fmtInt(itemsDone)} items computed · ${fmtNum(rate())}/s now`;
  LS.set('itemsDone', String(itemsDone));

  // Progress of the class job (from the Hub) or the solo job.
  const p = solo && (solo.finished === null || !welcomed) ? null : progress;
  if (p && p.jobId === lab.jobId ? true : p && p.status !== 'running') {
    els.timer.classList.remove('hidden');
    els.progBar.classList.remove('hidden');
    els.timer.textContent = fmtTime(p!.elapsed);
    (els.progBar.firstChild as HTMLElement).style.width = `${(100 * p!.done) / Math.max(1, p!.total)}%`;
    els.progText.textContent = `${fmtInt(p!.done)} / ${fmtInt(p!.total)} ${p!.unit} · ${fmtNum(p!.rate)}/s · ${p!.devices} device${p!.devices === 1 ? '' : 's'} · this device did ${fmtInt(p!.mine)}${p!.status === 'done' ? ' · finished!' : ''}`;
  } else if (solo) {
    const el = ((solo.finished ?? performance.now()) - solo.started) / 1000;
    els.timer.classList.remove('hidden');
    els.progBar.classList.remove('hidden');
    els.timer.textContent = fmtTime(el);
    (els.progBar.firstChild as HTMLElement).style.width = `${(100 * solo.done) / solo.total}%`;
    els.progText.textContent = `Solo: ${fmtInt(solo.done)} / ${fmtInt(solo.total)} ${solo.unit} · ${fmtNum(solo.done / Math.max(0.1, el))}/s ${solo.extra}${solo.finished ? ' · finished!' : ''}`;
  } else {
    els.timer.classList.add('hidden');
    els.progBar.classList.add('hidden');
    els.progText.textContent = lastError ? `Last problem: ${lastError}` : '';
  }

  // Launch buttons (teacher allows students / demo mode)
  const running = !!(progress && progress.status === 'running' && progress.jobId === lab.jobId);
  if (welcomed && lab.canLaunch && !running && !stopped) {
    if (!els.launch.dataset.on) {
      const b1 = h('button', { class: 'go-btn blue' }, '▶ Start Swarm Sort (1,000 photos)');
      b1.onclick = () => send({ type: 'launch', lab: 'swarm-sort', options: {} });
      const b2 = h('button', { class: 'small' }, '▶ Start Science Sweep (π)');
      b2.onclick = () => send({ type: 'launch', lab: 'sweep', options: { kind: 'pi' } });
      clear(els.launch, b1, h('div', { class: 'row' }, b2));
      els.launch.dataset.on = '1';
    }
    const b = els.launch.querySelector('button') as HTMLButtonElement;
    b.disabled = !engine.modelReady;
    b.textContent = engine.modelReady ? `▶ Start Swarm Sort (${fmtInt(datasetCount)} photos)` : 'Loading the image model…';
  } else if (els.launch.dataset.on) {
    clear(els.launch);
    delete els.launch.dataset.on;
  }

  // Solo fallback
  const hubGone = !welcomed && hubGoneSince !== null && Date.now() - hubGoneSince > 4000;
  if (hubGone || solo) {
    els.solo.classList.remove('hidden');
    if (!els.solo.dataset.on) {
      const a = h('button', { class: 'blue' }, '▶ Swarm Sort on this device');
      a.onclick = () => void runSolo('swarm-sort');
      const b = h('button', null, '▶ π sweep on this device');
      b.onclick = () => void runSolo('sweep', { kind: 'pi', batches: 100 });
      clear(els.solo, h('h3', null, 'Work alone'), h('div', { class: 'muted small' }, 'No Hub needed: these labs use the files already saved on this device.'), h('div', { class: 'row' }, a, b));
      els.solo.dataset.on = '1';
    }
    for (const b of els.solo.querySelectorAll('button')) (b as HTMLButtonElement).disabled = solo?.finished === null || stopped;
  } else if (els.solo.dataset.on) {
    els.solo.classList.add('hidden');
  }

  if (tab === 'tutor') tutorUpdate();

  // Reborn
  els.rebornState.textContent = s;
  els.pulse.className = `pulse ${st === 'working' ? '' : 'idle'}`;
  els.rebornCount.textContent = fmtInt(itemsDone);
  els.rebornRate.textContent = `items computed · ${fmtNum(rate())}/s`;
  sendStatus();
}

// ---------- boot ----------
teach = new Teach({
  engine,
  ensureModel,
  send,
  onCounts: () => {
    schedule();
    sendStatus(true);
  },
});

(window as unknown as Record<string, unknown>).__recompute = {
  get state() {
    return { welcomed, nodeId, name, room, status: status(), outstanding: { ...outstanding }, active: active.size, itemsDone, tutor: { ready: tutor.ready, id: tutor.modelId, tps: tutor.lastTokPerSec } };
  },
  engine,
  tutor,
  addPhotoFromUrl: (url: string, label: number) => teach.addFromUrl(url, label),
  stop: () => setStopped(true),
  resume: () => setStopped(false),
  loadTutor,
  ask: (q: string, maxTokens = 48) => tutor.ask(q, { maxTokens }),
  runSolo,
  preloadImages,
  get solo() {
    return solo;
  },
};

if ('serviceWorker' in navigator && isSecureContext && qs.get('sw') !== '0' && !HOST) navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});

render();
if (room) connect();
void watchBattery();
void updateWakeLock();
setInterval(() => {
  schedule();
  void updateWakeLock();
}, 1000);
