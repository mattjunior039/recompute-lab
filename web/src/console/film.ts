// 🎬 Film mode: one button runs every demo beat on the real joined devices, hands-free, while the
// screen is recorded once. Nothing here is simulated: each chapter sends the same commands a
// teacher would click, waits for the Hub's live state, and logs wall-clock times for editing.

import { h, clear, fmtNum, fmtTime, toast, DEVICE_ICON } from '../shared/dom';
import type { ConsoleCmd, ConsoleState, NodeView } from '../shared/protocol';
import { RENDER_PRESETS, type RenderRes } from '../shared/render';
import { WAKE_STEP_MS, FADE_MS, SWEEP_MS, SWEEP_PAUSE_MS, wakeEnd } from '../shared/wall';
import { zipStore, type ZipEntry } from '../shared/zip';
import QRCode from 'qrcode';
import * as v2 from './v2';

export interface FilmCtx {
  state: () => ConsoleState | null;
  cmd: (c: ConsoleCmd) => void;
  go: (view: string) => void;
  update: () => void;
  keyQ: string;
}

type Phase = 'closed' | 'join' | 'preflight' | 'countdown' | 'running' | 'done';
type ChapterStatus = 'running' | 'done' | 'skipped' | 'failed' | 'stopped' | 'retried';

/** One run unit: what Skip / Retry / Resume act on. */
interface ChapterLog {
  n: number;
  id: string;
  title: string;
  start: string;
  end: string | null;
  status: ChapterStatus;
  note: string;
}

/** One editing beat (for cutting the recording). film-log.json `chapters` is a list of these, in order. */
interface BeatLog {
  id: string;
  title: string;
  start: string;
  end: string | null;
}

interface Chapter {
  id: string;
  title: string;
  sub: string;
  /** The beat ids this act logs, in order (chapter ids used when editing the recording). */
  beats: string[];
  /** Show the Screen Wall page on the Console during this chapter (instead of the Lab page). */
  view: 'lab' | 'wall' | 'uses';
  optional?: boolean;
  run: () => Promise<string | void>;
}

/** Thrown to leave a chapter early. */
class Leave extends Error {
  constructor(readonly status: 'skipped' | 'retry' | 'stopped', note = '') {
    super(note);
  }
}

const CAMERA_RE = /17e|camera/i;
const DEFAULT_QUESTION = 'Why is it better to reuse an old laptop than to throw it away?';

let C: FilmCtx;
let phase: Phase = 'closed';
const opts = {
  picked: new Set<string>(),
  touched: new Set<string>(), // devices the user ticked or unticked by hand
  hero: '',
  res: '4k' as RenderRes,
  spp: 2,
  audio: 'mic' as 'sample' | 'file' | 'mic',
  audioName: '',
  audioBuf: null as ArrayBuffer | null,
  question: DEFAULT_QUESTION,
  speedup: false,
  from: 1,
  practice: false,
};
let net: { online: boolean | null; at: number; checked: string[] } = { online: null, at: 0, checked: [] };
let netTimer: ReturnType<typeof setInterval> | null = null;
let log: {
  app: string;
  created_at: string;
  /** Wall-clock time of the white sync flash + beep. */
  sync_at: string | null;
  /** Editing beats (wake, wall, render_solo, …) with ISO start/end. Beats that did not run are left out. */
  chapters: BeatLog[];
  /** The run units behind those beats, with status and the measured result. */
  acts: ChapterLog[];
  resumed_from: number;
  devices: { id: string; name: string; type: string }[];
  hero: string;
  render: { res: RenderRes; spp: number };
  audio: string;
  internet: { at: string; online: boolean | null }[];
  hub_computes: boolean;
  zip: string[];
} | null = null;
let openBeat: BeatLog | null = null;
/** Start an editing beat (ends the previous one). */
function beat(id: string, title: string) {
  if (!log) return;
  if (openBeat) openBeat.end = iso();
  openBeat = { id, title, start: iso(), end: null };
  log.chapters.push(openBeat);
}
let current = 0; // chapter number being run (1-based), 0 = none
let leave: Leave | null = null;
let chapterStartedAt = 0;
let prompt: { text: string; sub: string } | null = null;
let zipUrl: string | null = null;
let zipFiles: string[] = [];

const root = h('div', { class: 'film hidden', role: 'dialog', 'aria-label': 'Film mode' });
const bar = h('div', { class: 'film-bar hidden' });
const card = h('div', { class: 'film-title hidden' });
const flash = h('div', { class: 'film-flash hidden' });

export function initFilm(ctx: FilmCtx) {
  C = ctx;
  document.body.append(root, bar, card, flash);
  (window as unknown as { __film: unknown }).__film = {
    state: () => ({ phase, chapter: current, chapters: CHAPTERS.map((c, i) => ({ n: i + 1, id: c.id, title: c.title, beats: c.beats })), log, internet: net, zip: zipFiles, prompt }),
    open,
    join: showJoin,
    prepare: () => {
      const s = S();
      if (s) prepare(s);
    },
    configure,
    start: (from?: number) => start(from),
    skip: () => abort('skipped'),
    retry: () => abort('retry'),
    stop: () => abort('stopped'),
    close,
  };
}

const withKey = (url: string) => (C.keyQ ? `${url}${url.includes('?') ? '&' : '?'}${C.keyQ}` : url);
const S = () => C.state();
const iso = (t = Date.now()) => new Date(t).toISOString();
const online = (s: ConsoleState) => s.nodes.filter((n) => n.online && !n.host);
const pickedNodes = (s: ConsoleState) => online(s).filter((n) => opts.picked.has(n.id));
const node = (id: string) => S()?.nodes.find((n) => n.id === id) ?? null;
const nameOf = (id: string) => node(id)?.name ?? 'the device';
const btn = (label: string, f: () => void, cls = '', disabled = false) => {
  const b = h('button', { class: cls }, label);
  b.disabled = disabled;
  b.onclick = f;
  return b;
};

// ---------- open / configure ----------

export function isOpen() {
  return phase !== 'closed';
}

export function open() {
  if (phase === 'running' || phase === 'countdown') return;
  phase = 'preflight';
  root.classList.remove('hidden');
  startNetPoll();
  // The Hub only coordinates during a Film mode run: every measured number comes from the old devices.
  const s = S();
  if (s?.hostCompute.on) C.cmd({ cmd: 'host-compute', on: false });
  draw();
}

/** A big join screen (QR + link) for the start of a film session; lists devices as they join. */
let joinExpect = 0;
let qrFor = '';
const qrCanvas = h('canvas', { class: 'film-qr' }) as HTMLCanvasElement;
function showJoin(expect = 0) {
  if (phase === 'running' || phase === 'countdown') return;
  joinExpect = expect;
  phase = 'join';
  root.classList.remove('hidden');
  startNetPoll();
  drawKey = '';
  draw();
}
function joinView(s: ConsoleState) {
  if (qrFor !== s.urls.join) {
    qrFor = s.urls.join;
    void QRCode.toCanvas(qrCanvas, s.urls.join, { margin: 2, scale: 14, errorCorrectionLevel: 'M' });
  }
  const devs = online(s);
  const old = devs.filter((n) => !CAMERA_RE.test(n.name));
  return h(
    'div',
    { class: 'film-join' },
    h('div', { class: 'film-join-qr' }, qrCanvas),
    h(
      'div',
      { class: 'film-join-side' },
      h('h1', null, 'Join Recompute'),
      h('div', { class: 'film-join-step' }, 'On each old device, scan this code with the camera, or type:'),
      h('div', { class: 'film-join-url mono' }, s.urls.join),
      h('div', { class: 'film-join-step' }, `Room code `, h('b', null, `${s.room.slice(0, 3)} ${s.room.slice(3)}`)),
      h('div', { class: 'film-join-count' }, joinExpect ? `${old.length} of ${joinExpect} devices joined` : `${old.length} device${old.length === 1 ? '' : 's'} joined`),
      h('div', { class: 'film-join-devs' }, ...devs.map((n) => h('span', { class: `pill ${CAMERA_RE.test(n.name) ? 'warn' : 'ok'}` }, `${DEVICE_ICON[n.caps.deviceType] ?? '💻'} ${n.name}${CAMERA_RE.test(n.name) ? ' (camera: left out)' : ''}`))),
      h('div', { class: 'muted' }, 'The Hub (this Mac) only coordinates. Every result comes from the old devices.'),
    ),
  );
}

function close() {
  if (phase === 'running' || phase === 'countdown') return;
  phase = 'closed';
  root.classList.add('hidden');
  bar.classList.add('hidden');
  stopNetPoll();
}

/** For `npm run film`: set preflight choices without clicking. Device lists match names or ids. */
function configure(o: { devices?: string[]; exclude?: string[]; hero?: string; res?: RenderRes; spp?: number; from?: number; speedup?: boolean; practice?: boolean; question?: string; audio?: 'sample' | 'mic' | 'file' }) {
  const s = S();
  const match = (n: NodeView, list: string[]) => list.some((x) => x === n.id || n.name.toLowerCase().includes(x.toLowerCase()));
  if (s && o.devices) {
    opts.picked = new Set(online(s).filter((n) => match(n, o.devices!)).map((n) => n.id));
    for (const n of online(s)) opts.touched.add(n.id);
  }
  if (s && o.exclude)
    for (const n of online(s))
      if (match(n, o.exclude)) {
        opts.picked.delete(n.id);
        opts.touched.add(n.id);
      }
  if (s && o.hero) opts.hero = online(s).find((n) => match(n, [o.hero!]))?.id ?? opts.hero;
  if (o.res && o.res in RENDER_PRESETS) opts.res = o.res;
  if (o.spp) opts.spp = Math.max(1, Math.min(4, o.spp));
  if (o.from) opts.from = Math.max(1, Math.min(CHAPTERS.length, o.from));
  if (o.speedup !== undefined) opts.speedup = o.speedup;
  if (o.practice !== undefined) opts.practice = o.practice;
  if (o.question) opts.question = o.question.slice(0, 300);
  if (o.audio) opts.audio = o.audio;
  draw();
  return { picked: [...opts.picked].map(nameOf), hero: nameOf(opts.hero) };
}

function startNetPoll() {
  if (netTimer) return;
  const check = async () => {
    try {
      const r = await fetch(withKey('/api/internet'), { cache: 'no-store' });
      const j = await r.json();
      net = { online: !!j.online, at: j.at, checked: j.checked ?? [] };
    } catch {
      net = { online: null, at: Date.now(), checked: [] };
    }
    log?.internet.push({ at: iso(), online: net.online });
    draw();
  };
  void check();
  netTimer = setInterval(check, 5000);
}
function stopNetPoll() {
  if (netTimer) clearInterval(netTimer);
  netTimer = null;
}

function netBadge() {
  if (net.online === false) return h('span', { class: 'film-net off', title: `Checked just now: ${net.checked.join(', ')} unreachable` }, '🔌 Internet: OFF');
  if (net.online === true) return h('span', { class: 'film-net on' }, '🌐 Internet: ON');
  return h('span', { class: 'film-net unk' }, '🔌 Internet: checking…');
}

// ---------- device readiness ----------

function readiness(n: NodeView, s: ConsoleState) {
  const r = n.status.ready;
  const speech = s.models.some((m) => m.id === 'whisper-tiny-en' && m.ready);
  const mt = s.models.some((m) => m.id === 'opus-mt-en-es' && m.ready);
  const items: [string, boolean][] = [
    ['image model', r.mobilenet],
    [`photos ${r.dataset}/${s.datasetCount}`, r.dataset >= s.datasetCount],
    ['tutor', !!r.tutor],
  ];
  if (speech) items.push(['captions', !!r.asr && (!mt || !!r.mt)]);
  const teach = n.status.fedPhotos.reduce((a, b) => a + b, 0);
  return { items, ok: items.every(([, v]) => v), teach };
}

function syncPicks(s: ConsoleState) {
  for (const n of online(s)) {
    if (opts.touched.has(n.id)) continue;
    if (CAMERA_RE.test(n.name)) opts.picked.delete(n.id);
    else opts.picked.add(n.id);
  }
  for (const id of [...opts.picked]) if (!online(s).some((n) => n.id === id)) opts.picked.delete(id);
  const picked = pickedNodes(s);
  if (!picked.some((n) => n.id === opts.hero)) opts.hero = (picked.find((n) => n.caps.deviceType === 'chromebook') ?? picked[0])?.id ?? '';
}

function prepare(s: ConsoleState) {
  const tutor = s.models.find((m) => m.kind === 'gguf' && m.ready)?.id;
  const speech = s.models.some((m) => m.id === 'whisper-tiny-en' && m.ready) && s.models.some((m) => m.id === 'opus-mt-en-es' && m.ready);
  for (const n of pickedNodes(s)) C.cmd({ cmd: 'node', nodeId: n.id, action: 'prepare', args: { all: true, ...(tutor ? { tutor } : {}), ...(speech ? { speech: { asr: true, mt: true } } : {}) } });
}

// ---------- drawing ----------

let drawKey = '';
export function onState() {
  if (phase === 'closed') return;
  // The Hub is new hardware: it only coordinates during a Film mode run, so every measured number comes from old devices.
  if ((phase === 'running' || phase === 'countdown') && S()?.hostCompute.on) C.cmd({ cmd: 'host-compute', on: false });
  draw();
}

function draw() {
  const s = S();
  if (phase === 'closed' || !s) return;
  if (phase === 'preflight' || phase === 'done') syncPicks(s);
  drawBar();
  if (phase !== 'preflight' && phase !== 'done' && phase !== 'join') return;
  const key = JSON.stringify([phase, joinExpect, s.urls.join, opts, [...opts.picked], net.online, s.nodes.map((n) => [n.id, n.name, n.online, n.status.ready, n.status.state, n.status.fedPhotos, n.status.battery]), s.models.map((m) => [m.id, m.ready]), log?.acts.length, zipFiles]);
  if (key === drawKey) return;
  drawKey = key;
  clear(root, phase === 'join' ? joinView(s) : phase === 'preflight' ? preflight(s) : doneView(s));
}

function preflight(s: ConsoleState) {
  const nodes = online(s);
  const picked = pickedNodes(s);
  const missing = ['whisper-tiny-en', 'opus-mt-en-es', 'mobilenetv3'].filter((id) => !s.models.some((m) => m.id === id && m.ready));
  const notReady = picked.filter((n) => !readiness(n, s).ok);
  const rows = nodes.map((n) => {
    const r = readiness(n, s);
    const cb = h('input', { type: 'checkbox', checked: opts.picked.has(n.id) }) as HTMLInputElement;
    cb.onchange = () => {
      opts.touched.add(n.id);
      if (cb.checked) opts.picked.add(n.id);
      else opts.picked.delete(n.id);
      draw();
    };
    const batt = n.status.battery === 'charging' ? '⚡ charging' : n.status.battery === 'on-battery' ? '🔋 on battery' : 'power unknown';
    return h(
      'label',
      { class: `film-dev ${opts.picked.has(n.id) ? '' : 'off'}` },
      cb,
      h('span', { class: 'film-dev-n' }, `${DEVICE_ICON[n.caps.deviceType] ?? '💻'} ${n.name}`),
      h('span', { class: 'film-dev-r' }, ...r.items.map(([t, ok]) => h('span', { class: `pill ${ok ? 'ok' : 'warn'}` }, `${ok ? '✓' : '…'} ${t}`)), h('span', { class: `pill ${r.teach ? 'ok' : 'warn'}` }, `Teach photos: ${r.teach}`), h('span', { class: 'pill' }, batt), h('span', { class: 'pill' }, n.status.state)),
      CAMERA_RE.test(n.name) && !opts.picked.has(n.id) ? h('span', { class: 'small muted' }, 'camera phone: left out') : null,
    );
  });
  const sel = (choices: [string, string][], val: string, on: (v: string) => void) => {
    const el = h('select', null, ...choices.map(([v, t]) => h('option', { value: v, selected: v === val }, t))) as HTMLSelectElement;
    el.onchange = () => {
      on(el.value);
      draw();
    };
    return el;
  };
  const file = h('input', { type: 'file', accept: 'audio/*,.wav,.m4a,.mp3', class: 'film-audio-file' }) as HTMLInputElement;
  file.onchange = async () => {
    const f = file.files?.[0];
    if (!f) return;
    opts.audioBuf = await f.arrayBuffer();
    opts.audioName = f.name;
    opts.audio = 'file';
    draw();
  };
  const q = h('input', { type: 'text', value: opts.question, style: 'width:100%' }) as HTMLInputElement;
  q.onchange = () => (opts.question = q.value.trim() || DEFAULT_QUESTION);
  const check = (label: string, val: boolean, on: (v: boolean) => void) => {
    const c = h('input', { type: 'checkbox', checked: val }) as HTMLInputElement;
    c.onchange = () => {
      on(c.checked);
      draw();
    };
    return h('label', { class: 'row', style: 'gap:8px' }, c, label);
  };
  const blocked = !picked.length ? 'Tick at least one device.' : net.online === true && !opts.practice ? 'The internet is still on. Unplug the router’s internet cable (or tick “Practice run” below).' : net.online === null && !opts.practice ? 'Checking the internet…' : '';
  const go = btn(blocked ? 'Not ready yet' : notReady.length ? `▶ Start anyway (${notReady.length} not prepared)` : '▶ Start film run', () => void start(opts.from), `film-go ${notReady.length ? 'warn' : 'primary'}`, !!blocked);
  return h(
    'div',
    { class: 'film-panel' },
    h('div', { class: 'row' }, h('h1', { class: 'grow' }, '🎬 Film mode'), netBadge(), btn('Close', close, 'ghost')),
    h('div', { class: 'muted' }, 'One click runs every chapter on the real joined devices. Start your screen recordings first. You can skip or retry any chapter while it runs.'),
    h('div', { class: 'pill info' }, 'Hub coordinates only — all compute on old devices'),
    h('h2', null, `Devices (${picked.length} of ${nodes.length} ticked)`),
    nodes.length ? h('div', { class: 'film-devs' }, ...rows) : h('div', { class: 'banner warn' }, 'No devices yet. Open the join link on each old device.'),
    h('div', { class: 'row' }, btn('⬇ Prepare ticked devices', () => prepare(s), 'blue', !picked.length), notReady.length ? h('span', { class: 'small muted' }, `Not prepared yet: ${notReady.map((n) => n.name).join(', ')}`) : picked.length ? h('span', { class: 'pill ok' }, '✓ every ticked device is prepared') : null),
    missing.length ? h('div', { class: 'banner warn' }, `Not on the Hub yet: ${missing.join(', ')}. Download them in Setup with the internet on, before unplugging.`) : null,
    h(
      'div',
      { class: 'film-grid' },
      h('span', null, 'Render alone first on'),
      sel(
        picked.map((n) => [n.id, n.name]),
        opts.hero,
        (v) => (opts.hero = v),
      ),
      h('span', null, 'Render size'),
      h(
        'span',
        { class: 'row' },
        sel(
          (Object.keys(RENDER_PRESETS) as RenderRes[]).map((r) => [r, `${r.toUpperCase()} (${RENDER_PRESETS[r].width}×${RENDER_PRESETS[r].height})`]),
          opts.res,
          (v) => (opts.res = v as RenderRes),
        ),
        sel(
          [
            ['1', 'draft'],
            ['2', 'good'],
            ['4', 'best'],
          ],
          String(opts.spp),
          (v) => (opts.spp = Number(v)),
        ),
      ),
      h('span', null, 'Caption audio'),
      h(
        'span',
        { class: 'row' },
        sel(
          [
            ['file', opts.audioName ? `My recording: ${opts.audioName}` : 'My recording (choose a file →)'],
            ['mic', 'Live microphone (30 s)'],
            ['sample', 'Bundled sample speech (practice)'],
          ],
          opts.audio,
          (v) => (opts.audio = v as typeof opts.audio),
        ),
        file,
      ),
      h('span', null, 'Tutor question'),
      q,
      h('span', null, 'Start from chapter'),
      sel(
        CHAPTERS.map((c, i) => [String(i + 1), `${i + 1}. ${c.title}`]),
        String(opts.from),
        (v) => (opts.from = Number(v)),
      ),
    ),
    check('Chapter 9: also run the 1 → N speedup experiment (slow, off by default)', opts.speedup, (v) => (opts.speedup = v)),
    check('Practice run with the internet on (the badge will honestly say ON)', opts.practice, (v) => (opts.practice = v)),
    opts.audio === 'file' && !opts.audioBuf ? h('div', { class: 'banner warn' }, 'Choose your recording file. Without one, the live microphone is used.') : null,
    blocked ? h('div', { class: 'banner warn' }, blocked) : null,
    h('div', { class: 'row' }, go),
  );
}

function doneView(s: ConsoleState) {
  const L = log!;
  const from = h('select', null, ...CHAPTERS.map((c, i) => h('option', { value: String(i + 1) }, `${i + 1}. ${c.title}`))) as HTMLSelectElement;
  return h(
    'div',
    { class: 'film-panel' },
    h('div', { class: 'row' }, h('h1', { class: 'grow' }, '🎬 Film run finished'), netBadge(), btn('Close', close, 'ghost')),
    h(
      'table',
      { class: 'film-log' },
      h('tr', null, h('th', null, '#'), h('th', null, 'Chapter'), h('th', null, 'Result'), h('th', null, 'Time'), h('th', null, 'Note')),
      ...L.acts.map((c) =>
        h(
          'tr',
          null,
          h('td', null, String(c.n)),
          h('td', null, c.title),
          h('td', null, h('span', { class: `pill ${c.status === 'done' ? 'ok' : c.status === 'failed' ? 'bad' : 'warn'}` }, c.status)),
          h('td', { class: 'num' }, c.end ? fmtTime((Date.parse(c.end) - Date.parse(c.start)) / 1000) : '—'),
          h('td', { class: 'small' }, c.note),
        ),
      ),
    ),
    zipUrl ? h('div', { class: 'row' }, h('a', { class: 'btnlink', href: zipUrl, download: 'recompute-film-data.zip' }, '⬇ recompute-film-data.zip'), h('span', { class: 'small muted' }, zipFiles.join(' · '))) : h('div', { class: 'muted' }, 'Packing the data…'),
    h('div', { class: 'row' }, 'Run again from', from, btn('▶ Resume', () => void start(Number(from.value)), 'primary'), btn('New run (preflight)', () => ((phase = 'preflight'), draw()), 'ghost')),
    h('div', { class: 'muted small' }, `${pickedNodes(s).length} devices · flash at ${L.sync_at ?? '—'}`),
  );
}

function drawBar() {
  const show = phase === 'running' || phase === 'countdown';
  bar.classList.toggle('hidden', !show);
  root.classList.toggle('hidden', show || phase === 'closed');
  if (!show) return;
  const ch = CHAPTERS[current - 1];
  const el = chapterStartedAt ? (Date.now() - chapterStartedAt) / 1000 : 0;
  clear(
    bar,
    h('span', { class: 'film-rec' }, '● FILM'),
    h('span', { class: 'film-ch' }, ch ? `${current}/${CHAPTERS.length} · ${ch.title}` : 'Starting…'),
    h('span', { class: 'film-time' }, fmtTime(el)),
    netBadge(),
    h('span', { class: 'grow' }),
    btn('Skip ⏭', () => abort('skipped'), 'small'),
    btn('Retry ↻', () => abort('retry'), 'small'),
    btn('Stop ■', () => abort('stopped'), 'small danger'),
    prompt ? h('div', { class: 'film-prompt' }, h('div', { class: 'film-prompt-t' }, prompt.text), prompt.sub ? h('div', { class: 'film-prompt-s' }, prompt.sub) : null) : null,
  );
}
setInterval(() => {
  if (phase === 'running') drawBar();
}, 1000);

// ---------- the run ----------

function abort(status: Leave['status']) {
  if (phase !== 'running' && phase !== 'countdown') return;
  leave = new Leave(status);
}

function check() {
  if (leave) throw leave;
}

async function sleep(ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    check();
    await new Promise((r) => setTimeout(r, Math.min(100, end - Date.now())));
  }
  check();
}

/** Wait until the Hub's live state satisfies `pred`. Returns false on timeout. */
async function waitFor(pred: (s: ConsoleState) => boolean, timeoutMs: number) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    check();
    const s = S();
    if (s && pred(s)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  check();
  return false;
}

function say(text: string, sub = '') {
  prompt = text ? { text, sub } : null;
  drawBar();
}

async function titleCard(n: number, ch: Chapter) {
  clear(card, h('div', { class: 'film-title-n' }, `Chapter ${n}`), h('div', { class: 'film-title-t' }, ch.title), h('div', { class: 'film-title-s' }, ch.sub));
  card.classList.remove('hidden', 'out');
  try {
    await sleep(2000);
  } finally {
    card.classList.add('out');
    setTimeout(() => card.classList.add('hidden'), 450);
  }
}

function beep() {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 1000;
    g.gain.value = 0.25;
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.2);
    o.onended = () => void ctx.close();
  } catch {}
}

async function countdown() {
  phase = 'countdown';
  drawBar();
  for (const k of ['3', '2', '1']) {
    clear(card, h('div', { class: 'film-count' }, k));
    card.classList.remove('hidden', 'out');
    await sleep(900);
  }
  card.classList.add('hidden');
  // Sync flash: one full-screen white frame + a beep, to line up the camera and screen recordings.
  flash.classList.remove('hidden');
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  log!.sync_at = iso();
  beep();
  await new Promise((r) => setTimeout(r, 250));
  flash.classList.add('hidden');
  await new Promise((r) => setTimeout(r, 600));
}

/** Leave the Hub tidy after a chapter, whatever happened. */
async function tidy() {
  const s = S();
  prompt = null;
  if (v2.audioKind()) v2.stopAudio();
  if (!s) return;
  if (s.experiment && (s.experiment.status === 'running' || s.experiment.status === 'preparing')) C.cmd({ cmd: 'experiment-cancel' });
  if (s.run?.status === 'running') C.cmd({ cmd: 'cancel' });
  if (s.captions.on) C.cmd({ cmd: 'captions', on: false });
  if (s.fed.auto) C.cmd({ cmd: 'fed-auto', on: false });
  if (s.wall.scene !== 'off') C.cmd({ cmd: 'wall', scene: 'off' });
  C.cmd({ cmd: 'film-node', nodeId: '*', film: null });
  await new Promise((r) => setTimeout(r, 600));
}

async function start(from = 1) {
  const s = S();
  if (!s || phase === 'running' || phase === 'countdown') return;
  if (!pickedNodes(s).length) return toast('Tick at least one device.', 'warn');
  if (opts.audio === 'file' && !opts.audioBuf) opts.audio = 'mic'; // no voice file: live mic
  if (s.hostCompute.on) C.cmd({ cmd: 'host-compute', on: false });
  const picked = pickedNodes(s);
  // Devices left out (the camera phone) must not take any work or show on the wall.
  for (const n of online(s)) if (!opts.picked.has(n.id) && n.status.state !== 'stopped') C.cmd({ cmd: 'node', nodeId: n.id, action: 'stop' });
  for (const n of picked) if (n.status.state === 'stopped') C.cmd({ cmd: 'node', nodeId: n.id, action: 'resume' });
  C.cmd({ cmd: 'wall', only: picked.map((n) => n.id), scene: 'off' });
  if (zipUrl) URL.revokeObjectURL(zipUrl);
  zipUrl = null;
  zipFiles = [];
  log = {
    app: 'Recompute Film mode',
    created_at: iso(),
    sync_at: null,
    chapters: [],
    acts: [],
    resumed_from: Math.max(1, from),
    devices: picked.map((n) => ({ id: n.id, name: n.name, type: n.caps.deviceType })),
    hero: nameOf(opts.hero),
    render: { res: opts.res, spp: opts.spp },
    audio: opts.audio === 'file' ? `file: ${opts.audioName}` : opts.audio,
    internet: [{ at: iso(), online: net.online }],
    hub_computes: false,
    zip: [],
  };
  leave = null;
  current = 0;
  openBeat = null;
  drawKey = '';
  try {
    await countdown();
  } catch {
    // stopped during the countdown
  }
  phase = 'running';
  for (let k = Math.max(1, from); k <= CHAPTERS.length && leave?.status !== 'stopped'; k++) {
    const ch = CHAPTERS[k - 1];
    current = k;
    if (ch.optional && !opts.speedup) {
      log.acts.push({ n: k, id: ch.id, title: ch.title, start: iso(), end: iso(), status: 'skipped', note: 'off (optional)' });
      continue;
    }
    for (;;) {
      leave = null;
      const entry: ChapterLog = { n: k, id: ch.id, title: ch.title, start: iso(), end: null, status: 'running', note: '' };
      log.acts.push(entry);
      // A retried act replaces the beats of its earlier attempt.
      log.chapters = log.chapters.filter((b) => !ch.beats.includes(b.id));
      openBeat = null;
      chapterStartedAt = Date.now();
      C.go(ch.view);
      try {
        await titleCard(k, ch);
        entry.start = iso(); // the chapter itself starts after its title card
        const note = await ch.run();
        entry.note = note ?? '';
        entry.status = 'done';
        await sleep(3000); // hold the finished result on screen
      } catch (e) {
        if (e instanceof Leave) {
          entry.status = e.status === 'retry' ? 'retried' : e.status;
          entry.note = e.message || entry.note;
        } else {
          entry.status = 'failed';
          entry.note = e instanceof Error ? e.message : String(e);
          toast(`Chapter ${k}: ${entry.note}`, 'warn');
        }
      }
      entry.end = iso();
      // A finished act closes its last beat; an unfinished beat is not usable footage, so it is dropped.
      const last = openBeat as BeatLog | null; // set by beat() inside ch.run()
      if (last) {
        if (entry.status === 'done') last.end = entry.end;
        else log.chapters = log.chapters.filter((b) => b !== last);
        openBeat = null;
      }
      chapterStartedAt = 0;
      const left = leave as Leave | null; // set by the Skip/Retry/Stop buttons while the chapter ran
      const retry = left?.status === 'retry';
      const stopped = left?.status === 'stopped';
      leave = null;
      await tidy();
      if (stopped) leave = new Leave('stopped');
      if (!retry) break;
    }
  }
  current = 0;
  leave = null;
  phase = 'done';
  C.go('lab');
  draw();
  await pack();
}

// ---------- chapters ----------

const fail = (msg: string) => new Error(msg);
const skip = (note: string) => new Leave('skipped', note);

const CHAPTERS: Chapter[] = [
  {
    id: 'wall-wake',
    title: 'The Screen Wall wakes up',
    sub: 'Old devices, one by one',
    view: 'wall',
    beats: ['wake', 'wall'],
    async run() {
      beat('wake', 'Old devices wake up one by one');
      const s = S()!;
      const ids = pickedNodes(s).map((n) => n.id);
      C.cmd({ cmd: 'wall', only: ids, scene: 'black' });
      await waitFor((x) => x.wall.scene === 'black', 3000);
      const count = S()!.wall.order.length;
      if (!count) throw skip('no device reported its screen size');
      await sleep(2500);
      C.cmd({ cmd: 'wall', scene: 'wake' });
      await sleep(wakeEnd(count) + FADE_MS + 400);
      beat('wall', 'RECOMPUTE across the Screen Wall');
      C.cmd({ cmd: 'wall', scene: 'sweep' });
      await sleep(SWEEP_MS + SWEEP_PAUSE_MS + 400);
      return `${count} screens · ${(wakeEnd(count) / 1000).toFixed(1)} s wake (${WAKE_STEP_MS} ms apart)`;
    },
  },
  {
    id: 'render-race',
    title: 'Swarm Render',
    sub: 'One device alone, then every old device together',
    view: 'lab',
    beats: ['render_solo', 'render_swarm'],
    async run() {
      const s = S()!;
      const picked = pickedNodes(s);
      if (picked.length < 2) throw skip('needs at least two devices');
      v2.renderOpts.res = opts.res;
      v2.renderOpts.spp = opts.spp;
      v2.renderOpts.first = opts.hero;
      const prev = s.experiment?.id;
      C.cmd({ cmd: 'race', lab: 'render', first: opts.hero, options: { res: opts.res, spp: opts.spp }, devices: picked.map((n) => n.id) });
      const began = await waitFor((x) => !!x.experiment?.race && x.experiment.id !== prev, 15000);
      if (!began) throw fail('the race did not start');
      beat('render_solo', `Swarm Render: ${nameOf(opts.hero)} alone`);
      say(`${nameOf(opts.hero)} renders the picture alone first`, `${opts.res.toUpperCase()} · then all ${picked.length} devices`);
      await waitFor((x) => (x.experiment?.step ?? 0) >= 1 || x.experiment?.status === 'done' || x.experiment?.status === 'cancelled', 45 * 60_000);
      beat('render_swarm', `Swarm Render: all ${picked.length} old devices`);
      say(`Now all ${picked.length} old devices together`, '');
      const ok = await waitFor((x) => x.experiment?.status === 'done' || x.experiment?.status === 'cancelled', 45 * 60_000);
      say('');
      const ex = S()!.experiment;
      if (!ok || ex?.status !== 'done') throw fail(ok ? 'the race was cancelled' : 'the race took longer than 45 minutes');
      const rows = ex.rows;
      return rows.map((r) => `${r.devices} device${r.devices === 1 ? '' : 's'}: ${fmtNum(r.seconds, 1)} s`).join(' vs ') + (rows.at(-1)?.speedup ? ` · ${fmtNum(rows.at(-1)!.speedup, 2)}× faster` : '');
    },
  },
  {
    id: 'render-wall',
    title: 'The picture, across every screen',
    sub: 'Each old device shows its slice',
    view: 'wall',
    beats: ['render_wall'],
    async run() {
      const r = await fetch(withKey('/api/render.png'), { method: 'HEAD' }).catch(() => null);
      if (!r?.ok) throw skip('no finished render yet (run chapter 2 first)');
      const ids = pickedNodes(S()!).map((n) => n.id);
      beat('render_wall', 'The render across every screen');
      C.cmd({ cmd: 'wall', only: ids, scene: 'image' });
      await sleep(FADE_MS + 7000);
      return `${S()!.wall.order.length} screens`;
    },
  },
  {
    id: 'offline',
    title: 'No internet needed',
    sub: 'Everything runs on this local network',
    view: 'lab',
    beats: ['offline'],
    async run() {
      const r = await fetch(withKey('/api/internet'), { cache: 'no-store' }).then((x) => x.json()).catch(() => null);
      if (r) net = { online: !!r.online, at: r.at, checked: r.checked ?? [] };
      log?.internet.push({ at: iso(), online: net.online });
      beat('offline', net.online === false ? 'Internet: OFF (verified)' : net.online ? 'Internet: ON (practice run)' : 'Internet: not verified');
      const hosts = net.checked.join(', ');
      clear(
        card,
        h('div', { class: 'film-title-n' }, 'Checked by the Hub just now'),
        h('div', { class: `film-net big ${net.online === false ? 'off' : net.online ? 'on' : 'unk'}` }, net.online === false ? '🔌 Internet: OFF' : net.online ? '🌐 Internet: ON (practice run)' : '🔌 Internet: unknown'),
        h('div', { class: 'film-title-s' }, net.online === false ? `No reply from ${hosts}. Every model is already on this network.` : net.online ? 'Unplug the router’s internet cable for the real run.' : 'The Hub could not run its check.'),
      );
      card.classList.remove('hidden', 'out');
      try {
        await sleep(5000);
      } finally {
        card.classList.add('out');
        setTimeout(() => card.classList.add('hidden'), 450);
      }
      return net.online === false ? `verified offline (${hosts} unreachable)` : net.online ? 'internet was ON (practice run)' : 'not verified';
    },
  },
  {
    id: 'captions',
    title: 'Live Captions + Spanish',
    sub: 'Offline speech-to-text. No audio is saved.',
    view: 'lab',
    beats: ['captions'],
    async run() {
      const s = S()!;
      const asr = s.models.find((m) => m.id === 'whisper-tiny-en');
      const mt = s.models.find((m) => m.id === 'opus-mt-en-es');
      if (!asr?.ready) throw skip('the speech model is not on the Hub');
      C.cmd({ cmd: 'captions-clear' });
      C.cmd({ cmd: 'captions', on: true, translate: !!mt?.ready });
      const able = await waitFor((x) => x.captions.on && pickedNodes(x).some((n) => n.status.ready.asr), 120_000);
      if (!able) throw fail('no device loaded the speech model within 2 minutes');
      await sleep(800);
      beat('captions', 'Live Captions + Spanish');
      if (opts.audio === 'mic') {
        say('🎤 Speak now', 'The microphone on this Mac is live for 30 seconds');
        await v2.startAudio('mic');
        await sleep(30_000);
        v2.stopAudio();
      } else {
        await v2.startAudio(opts.audio === 'file' ? 'file' : 'sample', opts.audioBuf ?? undefined);
        await waitFor(() => v2.audioKind() === null, 10 * 60_000);
      }
      say('');
      await waitFor((x) => x.captions.pending === 0 && x.captions.timedLines > 0, 90_000);
      const c = S()!.captions;
      if (!c.timedLines) throw fail('no captions came back');
      return `${c.timedLines} caption pieces · captions ~${c.lagSec === null ? '?' : fmtNum(c.lagSec, 1)} s behind (measured) · ${c.devices.join(', ')}`;
    },
  },
  {
    id: 'tutor',
    title: 'Private Tutor',
    sub: 'An AI tutor running offline on an old device',
    view: 'lab',
    beats: ['tutor'],
    async run() {
      const s = S()!;
      const model = s.models.find((m) => m.kind === 'gguf' && m.ready && pickedNodes(s).some((n) => n.status.ready.tutor === m.id)) ?? s.models.find((m) => m.kind === 'gguf' && m.ready);
      if (!model) throw skip('no tutor model on the Hub');
      const prev = s.run?.jobId;
      beat('tutor', 'Private Tutor answers offline');
      C.cmd({ cmd: 'start', lab: 'tutor', options: { model: model.id, questions: [opts.question], maxTokens: 96 } });
      const began = await waitFor((x) => x.run?.lab === 'tutor' && x.run.jobId !== prev, 15000);
      if (!began) throw fail('the tutor did not start');
      const ok = await waitFor((x) => x.run?.lab === 'tutor' && x.run.status !== 'running', 6 * 60_000);
      const run = S()!.run;
      if (!ok || run?.status !== 'done') throw fail(ok ? 'the tutor run was cancelled' : 'no answer within 6 minutes');
      const who = run.perDevice.find((d) => d.items > 0)?.name ?? '';
      return `answered by ${who} in ${fmtNum(run.elapsed, 1)} s (${model.id})`;
    },
  },
  {
    id: 'teach',
    title: 'Teach the Swarm',
    sub: 'Training together. 0 photos uploaded.',
    view: 'lab',
    beats: ['teach'],
    async run() {
      const s = S()!;
      const holders = pickedNodes(s).filter((n) => n.status.fedPhotos.some((v) => v > 0));
      if (!holders.length) throw skip('no Teach photos on the devices (take a few of each kind on each device before recording)');
      beat('teach', 'Teach the Swarm: accuracy rises, 0 photos uploaded');
      C.cmd({ cmd: 'start', lab: 'teach' });
      C.cmd({ cmd: 'fed-reset' });
      await sleep(1200);
      C.cmd({ cmd: 'fed-auto', on: true });
      await waitFor((x) => x.fed.history.length >= 5 || (!x.fed.auto && !x.fed.roundOpen && x.fed.history.length > 0), 5 * 60_000);
      C.cmd({ cmd: 'fed-auto', on: false });
      await waitFor((x) => !x.fed.roundOpen, 60_000);
      const f = S()!.fed;
      if (!f.history.length) throw fail('no training round finished');
      const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);
      return `${f.history.length} rounds · accuracy ${pct(f.history[0].overall)} → ${pct(f.history.at(-1)!.overall)} · ${holders.length} devices · ${f.photosUploaded} photos uploaded`;
    },
  },
  {
    id: 'tap',
    title: 'Your device comes first',
    sub: 'Touch it and the work pauses instantly',
    view: 'lab',
    beats: ['pause', 'did'],
    async run() {
      const s = S()!;
      const hero = pickedNodes(s).find((n) => n.id === opts.hero) ?? pickedNodes(s).find((n) => n.mode === 'join');
      if (!hero) throw skip('no device to tap');
      if (hero.mode === 'reborn') throw skip(`${hero.name} is in Reborn mode (it never pauses for input)`);
      C.cmd({ cmd: 'start', lab: 'sweep', options: { kind: 'pi', batches: 100_000 } });
      const working = await waitFor((x) => x.nodes.find((n) => n.id === hero.id)?.status.state === 'working', 60_000);
      if (!working) throw fail(`${hero.name} did not start computing`);
      await sleep(1500);
      beat('pause', `Tap the ${hero.name}: it pauses instantly`);
      C.cmd({ cmd: 'film-node', nodeId: hero.id, film: { title: 'Tap this screen', sub: 'Work stops the moment you use your device', tap: true } });
      say(`👆 Tap the ${hero.name} now`, 'One tap on its screen');
      const paused = await waitFor((x) => x.nodes.find((n) => n.id === hero.id)?.status.state === 'paused-input', 120_000);
      if (!paused) throw fail('no tap within 2 minutes');
      const pausedAt = Date.now();
      C.cmd({ cmd: 'film-node', nodeId: hero.id, film: { title: 'Paused: you are using this device', sub: 'Computing resumes after 30 seconds without input' } });
      say(`⏸ ${hero.name} paused instantly`, 'It resumes by itself after 30 seconds of no input');
      const back = await waitFor((x) => x.nodes.find((n) => n.id === hero.id)?.status.state === 'working', 60_000);
      const resumed = (Date.now() - pausedAt) / 1000;
      beat('did', `What my device did: ${hero.name}`);
      C.cmd({ cmd: 'film-node', nodeId: hero.id, film: { title: 'What my device did', did: true } });
      say(back ? `▶ Resumed after ${fmtNum(resumed, 0)} s idle` : 'Still paused', 'Now look at its “What my device did” panel');
      await sleep(8000);
      C.cmd({ cmd: 'cancel' });
      const b = S()!.nodes.find((n) => n.id === hero.id)?.status.battery;
      return `${hero.name} paused on tap, ${back ? `resumed after ${fmtNum(resumed, 0)} s` : 'did not resume within 60 s'} · power: ${b ?? 'unknown'}`;
    },
  },
  {
    id: 'uses',
    title: 'Recompute beyond school',
    sub: 'Libraries, shelters, offices, homes',
    view: 'uses',
    beats: ['usecases', 'nightshift', 'fleet'],
    async run() {
      const s = S()!;
      v2.setFleetSize(30);
      C.update();
      await sleep(600);
      beat('usecases', 'Recompute beyond school');
      const cards = [...document.querySelectorAll<HTMLElement>('.uc')];
      for (const c of cards) {
        c.scrollIntoView({ behavior: 'smooth', block: 'center' });
        c.classList.add('film-focus');
        await sleep(2400).finally(() => c.classList.remove('film-focus'));
      }
      beat('nightshift', 'Night Shift: batch jobs while carts charge');
      document.getElementById('night')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      await sleep(4500);
      beat('fleet', 'Fleet projection from this run');
      document.getElementById('fleet')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      await sleep(7000);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      const f = s.fleet;
      return f.perDevice.length && f.efficiency ? `fleet projection for 30 devices from this run (${f.efficiency.source})` : 'fleet calculator empty: nothing measured yet';
    },
  },
  {
    id: 'speedup',
    title: 'More devices, more speed',
    sub: 'The same job on 1, 2, 3… old devices',
    view: 'lab',
    beats: ['speedup'],
    optional: true,
    async run() {
      const s = S()!;
      const order = pickedNodes(s)
        .slice()
        .sort((a, b) => (a.id === opts.hero ? -1 : b.id === opts.hero ? 1 : a.connectedAt - b.connectedAt))
        .map((n) => n.id);
      const prev = s.experiment?.id;
      beat('speedup', 'Speedup: 1, 2, 3… old devices');
      C.cmd({ cmd: 'experiment', lab: 'swarm-sort', items: s.datasetCount, order });
      const began = await waitFor((x) => !!x.experiment && !x.experiment.race && x.experiment.id !== prev, 15000);
      if (!began) throw fail('the experiment did not start');
      const ok = await waitFor((x) => x.experiment?.status === 'done' || x.experiment?.status === 'cancelled', 60 * 60_000);
      const ex = S()!.experiment;
      if (!ok || ex?.status !== 'done') throw fail('the experiment did not finish');
      return ex.rows.map((r) => `${r.devices}: ${fmtNum(r.seconds, 1)} s`).join(' · ');
    },
  },
];

// ---------- the data zip ----------

async function grab(path: string): Promise<Uint8Array | null> {
  try {
    const r = await fetch(withKey(path), { cache: 'no-store' });
    if (!r.ok) return null;
    return new Uint8Array(await r.arrayBuffer());
  } catch {
    return null;
  }
}
/** A CSV with a header and at least one data row. */
const hasRows = (b: Uint8Array | null) => !!b && new TextDecoder().decode(b).trim().split(/\r?\n/).length > 1;

async function pack() {
  const L = log!;
  const ran = (id: string) => L.acts.some((c) => c.id === id && c.status === 'done');
  const entries: ZipEntry[] = [];
  const add = (name: string, data: Uint8Array | null, need: (b: Uint8Array) => boolean = hasRows) => {
    if (data && need(data)) entries.push({ name, data });
  };
  add('render.csv', await grab('/api/render.csv'));
  add('captions.csv', await grab('/api/captions.csv'));
  add('fleet.csv', await grab('/api/fleet.csv?n=30'));
  if (ran('render-race') || ran('speedup')) add('speedup.csv', await grab('/api/export/speedup.csv'));
  add('bench.csv', await grab('/api/export/bench.csv'));
  add('render.png', await grab('/api/render.png'), (b) => b.length > 8);
  L.zip = [...entries.map((e) => e.name), 'film-log.json'];
  entries.push({ name: 'film-log.json', data: JSON.stringify(L, null, 2) });
  const zip = zipStore(entries);
  zipFiles = L.zip;
  zipUrl = URL.createObjectURL(new Blob([zip as BlobPart], { type: 'application/zip' }));
  const a = h('a', { href: zipUrl, download: 'recompute-film-data.zip' });
  document.body.append(a);
  a.click();
  a.remove();
  drawKey = '';
  draw();
}
