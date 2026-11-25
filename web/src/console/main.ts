// Recompute Console: the teacher's dashboard. Big type, high contrast, built
// to be filmed. Everything shown comes from the Hub's live state.

import QRCode from 'qrcode';
import { h, clear, fmtInt, fmtNum, fmtTime, fmtBytes, toast, DEVICE_ICON } from '../shared/dom';
import { lineChart, barChart } from '../shared/charts';
import type { ConsoleCmd, ConsoleState, LabId, NodeView, RunView } from '../shared/protocol';

const qs = new URLSearchParams(location.search);
const KEY = qs.get('key') ?? '';
const keyQ = KEY ? `key=${encodeURIComponent(KEY)}` : '';
const app = document.getElementById('app')!;

// ---------- screen scaling: legible on a 1080p projector, a 5K iMac and a 4K TV alike ----------
const ZOOM_KEY = 'recompute.console.zoom';
function zoomSetting(): string {
  try {
    return qs.get('zoom') ?? localStorage.getItem(ZOOM_KEY) ?? 'auto';
  } catch {
    return 'auto';
  }
}
/** The layout is designed for 1920 CSS pixels wide; wider screens scale everything up. */
function applyZoom() {
  const set = zoomSetting();
  const z = set === 'auto' ? Math.min(2.5, Math.max(1, window.innerWidth / 1920)) : Math.min(3, Math.max(0.5, Number(set) || 1));
  const v = String(Math.round(z * 100) / 100);
  if (document.documentElement.style.getPropertyValue('zoom') !== v) document.documentElement.style.setProperty('zoom', v);
}
applyZoom();

let S: ConsoleState | null = null;
let view: 'lab' | 'devices' | 'bench' | 'setup' = (qs.get('view') as never) ?? 'lab';
let ws: WebSocket | null = null;
let connected = false;
let labels: string[] = [];
let swarmCount = 1000;
let sweepKind: 'pi' | 'sir' = 'pi';
let tutorModel = 'smollm2-360m';
let wattsOpen = false;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws?role=console${KEY ? `&key=${encodeURIComponent(KEY)}` : ''}`);
  ws.onopen = () => {
    connected = true;
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'state') {
      S = m.state;
      update();
    } else if (m.type === 'toast') toast(m.text, m.level);
  };
  ws.onclose = () => {
    connected = false;
    update();
    setTimeout(connect, 1500);
  };
}

function cmd(c: ConsoleCmd) {
  if (!S?.canControl) {
    toast('This screen is view-only. Open the Console link printed in the Hub window.', 'warn');
    return;
  }
  ws?.send(JSON.stringify(c));
}

async function loadLabels() {
  try {
    const r = await fetch('/models/mobilenetv3/labels.json');
    if (r.ok) labels = await r.json();
  } catch {}
}
const shortLabel = (i: number) => (labels[i] ?? `class ${i}`).split(',')[0];

// ---------- regions: re-render a block only when its data changed ----------
const regions = new Map<string, { el: HTMLElement; key: string }>();
function region(id: string, key: unknown, build: () => Node | Node[] | null, tag: keyof HTMLElementTagNameMap = 'div') {
  let r = regions.get(id);
  if (!r) regions.set(id, (r = { el: h(tag), key: '\u0000' }));
  const k = typeof key === 'string' ? key : JSON.stringify(key);
  if (r.key !== k) {
    r.key = k;
    const out = build();
    clear(r.el, ...(Array.isArray(out) ? out : [out]));
  }
  return r.el;
}

const canvases = new Map<string, HTMLCanvasElement>();
function canvas(id: string) {
  let c = canvases.get(id);
  if (!c) canvases.set(id, (c = h('canvas')));
  return c;
}

// ---------- layout ----------
const head = h('header', { class: 'c-head' });
const main = h('main', { class: 'c-main' });
const content = h('div', { class: 'col' });
const side = h('aside', { class: 'c-side' });

function layout() {
  clear(app, head, main);
  clear(main, content, side);
  updateHead();
}

function updateHead() {
  const nav = (id: typeof view, label: string) => {
    const b = h('button', { class: view === id ? 'on' : '' }, label);
    b.onclick = () => {
      view = id;
      regions.clear();
      updateHead();
      update();
    };
    return b;
  };
  clear(
    head,
    h('div', { class: 'brand' }, h('img', { src: '/static/icon.svg', alt: '' }), h('div', null, h('div', { class: 'name' }, 'Re', h('b', null, 'compute')), h('div', { class: 'tagline' }, 'Rethink. Reuse. Recompute.'))),
    h('nav', { class: 'c-nav' }, nav('lab', 'Lab'), nav('devices', 'Devices'), nav('bench', 'Benchmarks'), nav('setup', 'Setup')),
    region('head-flags', [S?.demo, connected, S?.canControl], () => [
      h(
        'div',
        { class: 'row' },
        S?.demo ? h('span', { class: 'flag' }, 'DEMO MODE') : null,
        !connected ? h('span', { class: 'pill bad' }, 'Hub disconnected') : null,
        S && !S.canControl ? h('span', { class: 'pill warn' }, 'view only') : null,
      ),
    ]),
    h('div', { class: 'room' }, h('div', { class: 'small muted' }, 'ROOM CODE'), region('room', S?.room, () => h('div', { class: 'code' }, S?.room ?? '······'))),
  );
}

// ---------- side: join QR + impact ----------
function sideView(s: ConsoleState) {
  const host = hostCard(s);
  return [
    ...(host ? [host] : []),
    region('qr', [s.urls.join, s.urls.trust, s.room], () => {
      const big = h('canvas');
      const small = h('canvas');
      void QRCode.toCanvas(big, s.urls.join, { margin: 1, scale: 8, errorCorrectionLevel: 'M' });
      const trust = `${s.urls.trust}?room=${s.room}`;
      void QRCode.toCanvas(small, trust, { margin: 1, scale: 4, errorCorrectionLevel: 'M' });
      return h(
        'div',
        { class: 'card col' },
        h('h2', null, 'Scan to join'),
        h('div', { class: 'qr' }, big),
        h('div', { class: 'mono small', style: 'word-break:break-all' }, s.urls.join),
        h('details', null, h('summary', { class: 'muted small' }, 'First time on a device? Trust the Hub'), h('div', { class: 'row', style: 'margin-top:8px' }, h('div', { class: 'qr small', style: 'width:150px' }, small), h('div', { class: 'small muted', style: 'flex:1' }, 'Scan this first on a new device to set up secure mode (one time), or to join in basic mode.')), h('div', { class: 'mono small', style: 'word-break:break-all' }, trust)),
      );
    }),
    region('impact', [s.impact, s.nodes.filter((n) => n.online).length], () => {
      const online = s.nodes.filter((n) => n.online).length;
      const types = Object.entries(s.impact.byType)
        .map(([t, n]) => `${DEVICE_ICON[t] ?? '💻'} ${n}`)
        .join('  ');
      return h(
        'div',
        { class: 'card col' },
        h('h2', null, 'Impact'),
        h('div', { class: 'stat' }, h('span', { class: 'v' }, `${online}`), h('span', { class: 'k' }, 'devices computing now')),
        h('div', { class: 'stat' }, h('span', { class: 'v' }, `${s.impact.devicesEver}`), h('span', { class: 'k' }, 'devices given a second job')),
        h('div', { class: 'muted' }, types),
        h('div', { class: 'stat' }, h('span', { class: 'v' }, fmtInt(s.impact.itemsTotal)), h('span', { class: 'k' }, 'tasks computed')),
        h('div', { class: 'stat' }, h('span', { class: 'v' }, fmtNum(s.impact.computeHours, 2)), h('span', { class: 'k' }, 'device-hours of compute')),
        h('div', { class: 'stat' }, h('span', { class: 'v' }, '0'), h('span', { class: 'k' }, 'new devices bought · 0 cloud calls')),
        s.impact.spotChecks ? h('div', { class: 'muted small' }, `Spot checks: ${s.impact.spotAgree}/${s.impact.spotChecks} results confirmed by a second device`) : null,
      );
    }),
  ];
}

// ---------- Lab view ----------
const LABS: { id: LabId; t: string; d: string }[] = [
  { id: 'swarm-sort', t: '🖼️ Swarm Sort', d: 'Label a set of photos with an image AI. More devices → faster.' },
  { id: 'teach', t: '📷 Teach the Swarm', d: 'Train a class model together. Photos never leave each device.' },
  { id: 'tutor', t: '💬 Private Tutor', d: 'An offline AI tutor. Swarm answers a question list.' },
  { id: 'sweep', t: '🧪 Science Sweep', d: 'Estimate π or sweep a disease-spread model.' },
];

function launcher(s: ConsoleState) {
  const running = s.run?.status === 'running';
  const mobilenet = s.models.find((m) => m.id === 'mobilenetv3');
  const gguf = s.models.filter((m) => m.kind === 'gguf');
  if (!gguf.find((m) => m.id === tutorModel) && gguf[0]) tutorModel = gguf[0].id;
  const key = [running, s.lab, s.run?.lab, s.demo, mobilenet?.ready, gguf.map((m) => [m.id, m.ready]), swarmCount, sweepKind, tutorModel, s.datasetCount, s.experiment?.status];
  return region('launcher', key, () => {
    const btn = (l: (typeof LABS)[number], extra: Node | null, disabled = false) => {
      const b = h('button', { class: `lab-btn ${(s.lab ?? s.run?.lab) === l.id ? 'on' : ''}` }, h('span', { class: 't' }, l.t), h('span', { class: 'd' }, l.d), extra);
      b.disabled = disabled;
      b.onclick = (e) => {
        if ((e.target as HTMLElement).closest('select')) return;
        if (l.id === 'swarm-sort') cmd({ cmd: 'start', lab: 'swarm-sort', options: { count: swarmCount } });
        else if (l.id === 'sweep') cmd({ cmd: 'start', lab: 'sweep', options: sweepKind === 'pi' ? { kind: 'pi' } : { kind: 'sir' } });
        else if (l.id === 'tutor') cmd({ cmd: 'start', lab: 'tutor', options: { model: tutorModel } });
        else cmd({ cmd: 'start', lab: 'teach' });
      };
      return b;
    };
    const sel = (opts: [string, string][], val: string, on: (v: string) => void) => {
      const el = h('select', { class: 'small' }, ...opts.map(([v, t]) => h('option', { value: v, selected: v === val }, t)));
      el.onclick = (e) => e.stopPropagation();
      el.onchange = () => {
        on(el.value);
        regions.get('launcher')!.key = '';
        update();
      };
      return el;
    };
    const counts = [...new Set([100, 250, 500, s.datasetCount])].filter((n) => n <= s.datasetCount);
    const ssExtra = s.demo ? h('span', { class: 'small muted' }, `${fmtInt(s.datasetCount)} photos (demo)`) : sel(counts.map((n) => [String(n), `${fmtInt(n)} photos`]), String(swarmCount), (v) => (swarmCount = Number(v)));
    const swExtra = sel([['pi', 'Estimate π'], ['sir', 'Disease spread (SIR)']], sweepKind, (v) => (sweepKind = v as 'pi' | 'sir'));
    const tuExtra = gguf.length > 1 ? sel(gguf.map((m) => [m.id, m.title]), tutorModel, (v) => (tutorModel = v)) : h('span', { class: 'small muted' }, gguf[0]?.title ?? '');
    const stop = h('button', { class: 'danger' }, '■ Stop the job');
    stop.disabled = !running;
    stop.onclick = () => cmd({ cmd: 'cancel' });
    const reset = h('button', { class: s.demo ? 'blue' : 'ghost' }, '↺ Reset for a new take');
    reset.onclick = () => {
      if (s.demo || confirm('Clear the current run and the Teach the Swarm model?')) cmd({ cmd: 'reset' });
    };
    return h(
      'div',
      { class: 'card col' },
      h('div', { class: 'labs' }, btn(LABS[0], ssExtra, !mobilenet?.ready), btn(LABS[1], null), btn(LABS[2], tuExtra, !gguf.some((m) => m.ready)), btn(LABS[3], swExtra)),
      h('div', { class: 'row' }, stop, reset, !mobilenet?.ready ? h('span', { class: 'pill warn' }, mobilenet?.error ? `Image model: ${mobilenet.error}` : `Image model downloading to the Hub… ${Math.round((mobilenet?.progress ?? 0) * 100)}%`) : null),
    );
  });
}

function runPanel(run: RunView, s: ConsoleState) {
  const unitRate = run.unit === 'images' ? 'images/s' : `${run.unit}/s`;
  const pct = (100 * run.done) / Math.max(1, run.total);
  const top = region('run-stats', [run.jobId, run.status, run.done, run.elapsed, run.rate, run.devices, run.failed], () =>
    h(
      'div',
      { class: 'col' },
      h('div', { class: 'row' }, h('h2', { style: 'margin:0', class: 'grow' }, run.title), h('span', { class: `pill ${run.status === 'done' ? 'ok' : run.status === 'running' ? 'info' : 'warn'}` }, run.status === 'done' ? '✓ finished' : run.status)),
      h(
        'div',
        { class: 'stats' },
        h('div', { class: 'stat' }, h('span', { class: 'v' }, fmtTime(run.elapsed)), h('span', { class: 'k' }, 'elapsed')),
        h('div', { class: 'stat' }, h('span', { class: 'v' }, fmtNum(run.rate)), h('span', { class: 'k' }, run.status === 'running' ? `${unitRate} now` : `${unitRate} average`)),
        h('div', { class: 'stat' }, h('span', { class: 'v' }, String(run.devices)), h('span', { class: 'k' }, 'devices working')),
        h('div', { class: 'stat' }, h('span', { class: 'v' }, `${fmtInt(run.done)}`), h('span', { class: 'k' }, `of ${fmtInt(run.total)} ${run.unit}`)),
      ),
      h('div', { class: 'bar' }, h('i', { style: `width:${pct}%` })),
      run.failed ? h('div', { class: 'pill warn' }, `${run.failed} item(s) failed 3 times and were skipped`) : null,
    ),
  );
  const chartsKey = run.jobId;
  const charts = region('run-charts', chartsKey, () =>
    h(
      'div',
      { class: 'row', style: 'align-items:stretch' },
      h('div', { class: 'card grow', style: 'min-width:320px;flex:3' }, h('h3', null, `Speed (${unitRate}) and devices`), canvas('rate'), h('div', { class: 'legend' }, h('span', null, h('i', { style: 'background:#34d399' }), unitRate), h('span', null, h('i', { style: 'background:#a78bfa' }), 'devices working'))),
      h('div', { class: 'card grow', style: 'min-width:260px;flex:2' }, h('h3', null, 'Speedup vs one device'), canvas('speedup'), region('speedup-note', [run.baseline?.source], () => h('div', { class: 'muted small' }, run.baseline ? `1× = ${fmtNum(run.baseline.rate, 2)} ${unitRate}, ${run.baseline.source}. Dashed = perfect scaling.` : 'Run with one device first (or keep it alone for a few seconds) to measure the 1× baseline.'))),
    ),
  );
  const devTable = region('run-devices', [run.perDevice, run.spot, run.energy], () =>
    h(
      'div',
      { class: 'card col' },
      h('h3', null, 'Who did the work'),
      h(
        'table',
        null,
        h('tr', null, h('th', null, 'Device'), h('th', null, run.unit), h('th', null, 'Active')),
        ...run.perDevice.map((d) => h('tr', null, h('td', null, d.name), h('td', { class: 'num' }, fmtInt(d.items)), h('td', { class: 'num' }, `${fmtNum(d.activeSec)} s`))),
      ),
      run.spot.checks
        ? h('div', { class: 'muted' }, `Spot checks: ${run.spot.checks} chunks re-done by a second device — ${run.spot.agree} agreed${run.spot.disagree ? `, ${run.spot.disagree} disagreed` : ''}.`)
        : run.kernel !== 'tutor'
          ? h('div', { class: 'muted small' }, 'Spot checks start when two or more devices are working (about 5% of chunks are re-done elsewhere).')
          : null,
      run.energy
        ? h(
            'div',
            { class: 'banner info' },
            `Energy (from plug-in meter readings): ${fmtNum(run.energy.wh, 3)} Wh${run.energy.whPer1000 !== null ? ` · ${fmtNum(run.energy.whPer1000, 3)} Wh per 1,000 ${run.unit}` : ''}`,
            run.energy.missing.length ? h('div', { class: 'small' }, `Not included (no measurement yet): ${run.energy.missing.join(', ')}`) : null,
          )
        : null,
    ),
  );
  return [h('div', { class: 'card col' }, top), charts, extraPanel(run), devTable];
}

function drawRunCharts(run: RunView) {
  const tl = run.timeline;
  const c1 = canvases.get('rate');
  if (c1 && c1.isConnected)
    lineChart(
      c1,
      [
        { name: 'rate', color: '#34d399', points: tl.map((p) => [p[0], p[3]]) },
        { name: 'devices', color: '#a78bfa', points: tl.map((p) => [p[0], p[2]]), axis: 'right', step: true, width: 2.5 },
      ],
      { height: 260, xLabel: 'seconds', y2Integer: true, xMax: Math.max(10, Math.ceil((tl.at(-1)?.[0] ?? 0) / 10) * 10) },
    );
  const c2 = canvases.get('speedup');
  if (c2 && c2.isConnected) {
    const rows = run.speedup;
    const useSpeed = rows.some((r) => r.speedup !== null);
    barChart(
      c2,
      rows.map((r) => ({ label: `${r.devices} device${r.devices === 1 ? '' : 's'}`, value: useSpeed ? (r.speedup ?? 0) : r.rate, color: r.devices === 1 ? '#38bdf8' : '#34d399' })),
      { height: 230, fmt: (v) => (useSpeed ? `${fmtNum(v)}×` : `${fmtNum(v)}/s`), ideal: useSpeed ? (l) => Number(l.split(' ')[0]) : undefined },
    );
  }
}

function extraPanel(run: RunView) {
  const x = run.extra as Record<string, unknown>;
  if (run.kernel === 'classify') {
    const g = (x.gallery as { i: number; label: number; score: number; node: string }[]) ?? [];
    return region('extra', [g.map((e) => e.i), labels.length], () =>
      h(
        'div',
        { class: 'card col' },
        h('h3', null, 'Just labelled'),
        h(
          'div',
          { class: 'gallery' },
          ...g
            .slice(-12)
            .reverse()
            .map((e) => h('figure', null, h('img', { src: `/data/swarmsort/images/${String(e.i).padStart(4, '0')}.jpg`, alt: '', loading: 'lazy' }), h('figcaption', null, h('b', null, shortLabel(e.label)), ` ${Math.round(e.score * 100)}%`, h('div', { class: 'muted' }, e.node)))),
        ),
      ),
    );
  }
  if (run.kernel === 'pi') {
    const p = x.pi as { estimate: number | null; samples: number; error: number | null } | undefined;
    return region('extra', [p?.samples], () => {
      const est = p?.estimate;
      const str = est ? est.toFixed(7) : '—';
      const real = Math.PI.toFixed(7);
      let k = 0;
      while (k < str.length && str[k] === real[k]) k++;
      return h(
        'div',
        { class: 'card col', style: 'text-align:center' },
        h('div', { class: 'muted' }, 'π estimated by throwing random darts at a square'),
        h('div', { class: 'huge mono' }, h('span', { style: 'color:var(--green)' }, str.slice(0, k)), h('span', { style: 'color:var(--muted)' }, str.slice(k))),
        h('div', { class: 'muted' }, `${fmtInt(p?.samples ?? 0)} darts · real π = ${real}${p?.error !== null && p?.error !== undefined ? ` · off by ${p.error.toExponential(1)}` : ''}`),
      );
    });
  }
  if (run.kernel === 'sir') {
    const sir = x.sir as { grid: number; cells: ([number, number] | null)[]; params: Record<string, number> } | undefined;
    return region('extra', [sir?.cells.filter(Boolean).length], () => {
      if (!sir) return null;
      const g = sir.grid;
      const p = sir.params;
      return h(
        'div',
        { class: 'card col' },
        h('h3', null, 'How many people get sick? (share of a 1,000-person town)'),
        h(
          'div',
          { class: 'row', style: 'align-items:flex-start' },
          h('div', { class: 'small muted', style: 'writing-mode:vertical-rl;transform:rotate(180deg)' }, `infection rate β ${p.betaMin} → ${p.betaMax}`),
          h(
            'div',
            { class: 'grow col', style: 'gap:6px' },
            h('div', { class: 'heat', style: `grid-template-columns:repeat(${g},1fr);max-width:560px` }, ...sir.cells.map((c) => h('div', { style: `background:${c ? heatColor(c[0]) : '#1e293b'}`, title: c ? `attack ${Math.round(c[0] * 100)}%, peak ${Math.round(c[1] * 100)}%` : '' }))),
            h('div', { class: 'small muted' }, `recovery rate γ ${p.gammaMin} → ${p.gammaMax}`),
            h('div', { class: 'legend' }, ...[0, 0.25, 0.5, 0.75, 1].map((v) => h('span', null, h('i', { style: `background:${heatColor(v)}` }), `${v * 100}%`))),
          ),
        ),
      );
    });
  }
  if (run.kernel === 'tutor') {
    const ans = (x.answers as { i: number; question: string; text: string; tokens: number; seconds: number; node: string; model: string }[]) ?? [];
    return region('extra', [ans.length], () =>
      h(
        'div',
        { class: 'card col' },
        h('h3', null, 'Answers (each written entirely on one device, offline)'),
        h('div', { class: 'muted small' }, 'Swarm mode answers more questions per minute. It does not make a single answer faster.'),
        h(
          'div',
          { class: 'answers' },
          ...ans.map((a) => h('div', { class: 'a' }, h('div', { class: 'q' }, a.question), h('div', null, a.text), h('div', { class: 'muted small' }, `${a.node} · ${a.tokens} tokens in ${fmtNum(a.seconds)} s (${fmtNum(a.tokens / Math.max(0.1, a.seconds))} tokens/s)`))),
        ),
      ),
    );
  }
  return h('div');
}

function heatColor(v: number) {
  // dark blue → teal → amber → red
  const stops = [
    [15, 23, 42],
    [20, 184, 166],
    [251, 191, 36],
    [239, 68, 68],
  ];
  const x = Math.max(0, Math.min(1, v)) * (stops.length - 1);
  const k = Math.min(stops.length - 2, Math.floor(x));
  const f = x - k;
  const c = stops[k].map((a, j) => Math.round(a + (stops[k + 1][j] - a) * f));
  return `rgb(${c.join(',')})`;
}

function teachPanel(s: ConsoleState) {
  const f = s.fed;
  const photos = f.photosOnDevices.reduce((a, b) => a + b, 0);
  const top = region('teach-top', [f.round, f.roundOpen, f.auto, photos, f.photosOnDevices, f.weightBytesTotal, s.nodes.filter((n) => n.online).length], () => {
    const round = h('button', { class: 'primary' }, f.roundOpen ? 'Round in progress…' : `▶ Train round ${f.round + 1}`);
    round.disabled = f.roundOpen;
    round.onclick = () => cmd({ cmd: 'fed-round' });
    const auto = h('button', { class: f.auto ? 'blue' : '' }, f.auto ? '⏸ Auto rounds on' : '⟳ Auto rounds');
    auto.onclick = () => cmd({ cmd: 'fed-auto', on: !f.auto });
    const reset = h('button', { class: 'ghost' }, 'New class model');
    reset.onclick = () => confirm('Start a new class model from scratch? (Photos stay on the devices.)') && cmd({ cmd: 'fed-reset' });
    return h(
      'div',
      { class: 'row', style: 'align-items:stretch' },
      h('div', { class: 'zero', style: 'flex:1;min-width:260px' }, h('div', { class: 'huge' }, '0'), h('div', { class: 'k' }, 'photos uploaded'), h('div', { class: 'muted small' }, 'The Hub has no way to receive a photo. Only model numbers travel.')),
      h(
        'div',
        { class: 'card col', style: 'flex:2;min-width:300px' },
        h('h2', null, 'Teach the Swarm'),
        h(
          'div',
          { class: 'stats', style: 'grid-template-columns:repeat(3,minmax(0,1fr))' },
          ...f.classes.map((c, k) => h('div', { class: 'stat' }, h('span', { class: `v c${k}` }, fmtInt(f.photosOnDevices[k] ?? 0)), h('span', { class: 'k' }, `${c} photos (kept on devices)`))),
        ),
        h('div', { class: 'muted' }, `Round ${f.round} · ${fmtBytes(f.weightBytesTotal)} of model numbers shared in total · ${photos} photos stayed on the devices`),
        h('div', { class: 'row' }, round, auto, reset),
      ),
    );
  });
  const chart = region('teach-chart', f.sessionId, () =>
    h(
      'div',
      { class: 'card col' },
      h('h3', null, 'Class model accuracy, per round (on photos it never trained on)'),
      canvas('fed'),
      h('div', { class: 'legend' }, ...f.classes.map((c, k) => h('span', null, h('i', { style: `background:${['#34d399', '#38bdf8', '#fbbf24'][k]}` }), c)), h('span', null, h('i', { style: 'background:#f1f5f9' }), 'overall')),
    ),
  );
  const table = region('teach-table', f.history, () =>
    f.history.length
      ? h(
          'div',
          { class: 'card' },
          h(
            'table',
            null,
            h('tr', null, h('th', null, 'Round'), h('th', null, 'Devices'), h('th', null, 'Trained on'), h('th', null, 'Checked on'), ...f.classes.map((c) => h('th', null, c)), h('th', null, 'Overall')),
            ...f.history
              .slice()
              .reverse()
              .map((r) =>
                h(
                  'tr',
                  null,
                  h('td', null, String(r.round)),
                  h('td', null, String(r.participants)),
                  h('td', null, `${r.trainPhotos} photos`),
                  h('td', null, `${r.evalPhotos} photos`),
                  ...r.perClass.map((v) => h('td', { class: 'num' }, v === null ? '—' : `${Math.round(v * 100)}%`)),
                  h('td', { class: 'num' }, r.overall === null ? '—' : `${Math.round(r.overall * 100)}%`),
                ),
              ),
          ),
          h('div', { class: 'muted small' }, 'Accuracy in round N is measured on each device’s held-out photos using the class model from before that round’s training.'),
        )
      : h('div'),
  );
  return [top, chart, table];
}

function drawFed(s: ConsoleState) {
  const c = canvases.get('fed');
  if (!c?.isConnected) return;
  const hist = s.fed.history;
  const colors = ['#34d399', '#38bdf8', '#fbbf24'];
  const series = s.fed.classes.map((name, k) => ({ name, color: colors[k], points: hist.filter((r) => r.perClass[k] !== null).map((r) => [r.round, (r.perClass[k] as number) * 100] as [number, number]) }));
  series.push({ name: 'overall', color: '#f1f5f9', points: hist.filter((r) => r.overall !== null).map((r) => [r.round, (r.overall as number) * 100] as [number, number]) });
  lineChart(c, series, { height: 250, xLabel: 'round', yMax: 100, xMax: Math.max(5, (hist.at(-1)?.round ?? 0) + 1), yFmt: (v) => `${v.toFixed(0)}%` });
}

function demoCard(s: ConsoleState) {
  if (!s.demo) return null;
  const online = s.nodes.filter((n) => n.online);
  const tutorId = s.models.find((m) => m.kind === 'gguf' && m.ready)?.id ?? null;
  const key = [online.map((n) => [n.id, n.name, n.status.ready, n.status.state]), s.models.map((m) => [m.id, m.ready]), s.datasetCount];
  return region('demo', key, () => {
    const prep = h('button', { class: 'blue' }, '⬇ Prepare all devices (models + photos)');
    prep.onclick = () => cmd({ cmd: 'node', nodeId: '*', action: 'prepare', args: { all: true, ...(tutorId ? { tutor: tutorId } : {}) } });
    const ok = (b: boolean) => (b ? '✓' : '…');
    return h(
      'div',
      { class: 'card col demo-on' },
      h('div', { class: 'row' }, h('h2', { style: 'margin:0' }, 'Demo checklist'), h('span', { class: 'flag' }, 'fixed job sizes')),
      h(
        'div',
        { class: 'kv' },
        ...s.models.flatMap((m) => [h('span', { class: 'k' }, m.title), h('span', null, m.ready ? '✓ on the Hub' : m.error ? `✗ ${m.error}` : `downloading ${Math.round(m.progress * 100)}%`)]),
        ...online.flatMap((n) => [
          h('span', { class: 'k' }, `${DEVICE_ICON[n.caps.deviceType] ?? '💻'} ${n.name}`),
          h('span', null, `${ok(n.status.ready.mobilenet)} image model · ${ok(n.status.ready.dataset >= s.datasetCount)} photos ${n.status.ready.dataset}/${s.datasetCount} · ${n.status.ready.tutor ? '✓ tutor' : '… tutor'} · ${n.status.state}`),
        ]),
      ),
      h('div', { class: 'row' }, prep),
      h('div', { class: 'muted small' }, 'Prepare everything once with the internet on. After that, the demo works with the router’s internet unplugged.'),
    );
  });
}

function labView(s: ConsoleState) {
  const out: Node[] = [];
  const d = demoCard(s);
  if (d) out.push(d);
  out.push(launcher(s));
  if (s.lab === 'teach') out.push(...teachPanel(s));
  else if (s.run) out.push(...runPanel(s.run, s));
  else if (s.fed.round > 0 || s.nodes.some((n) => n.status.fedPhotos.some((v) => v > 0))) out.push(...teachPanel(s));
  else out.push(region('empty', [s.nodes.length], () => h('div', { class: 'card', style: 'text-align:center;padding:40px' }, h('div', { class: 'big' }, `${s.nodes.filter((n) => n.online).length} devices connected`), h('div', { class: 'muted' }, 'Scan the QR code to join, then pick a lab.'))));
  if (s.experiment) out.push(experimentPanel(s));
  out.push(nodeGrid(s, true));
  return out;
}

// ---------- Devices ----------
function nodeCard(n: NodeView, s: ConsoleState, compact: boolean) {
  const st = n.status;
  const stateCls = !n.online ? 'bad' : st.state === 'working' ? 'ok' : st.state === 'idle' ? 'info' : 'warn';
  const stateTxt = !n.online ? 'offline' : { idle: 'ready', working: 'computing', 'paused-unplugged': 'paused: unplugged', stopped: 'stopped', hidden: 'screen off', preparing: 'getting ready' }[st.state];
  const batt = st.battery === 'charging' ? '🔌' : st.battery === 'on-battery' ? '🔋' : '❔';
  const card = h(
    'div',
    { class: `ncard ${n.online ? (st.state === 'working' ? 'working' : '') : 'offline'}` },
    h('div', { class: 'nm' }, h('span', { class: 'ic' }, DEVICE_ICON[n.caps.deviceType] ?? '💻'), h('span', { class: 'grow' }, n.name), n.mode === 'reborn' ? h('span', { class: 'flag' }, 'REBORN') : null, n.host ? h('span', { class: 'flag hub' }, 'HUB') : null),
    h('div', { class: 'row', style: 'gap:6px' }, h('span', { class: `pill ${stateCls}` }, stateTxt), h('span', { title: 'power' }, batt), st.throttle ? h('span', { class: 'pill warn' }, `cooling −${st.throttle}`) : null),
    h('div', { class: 'rate' }, `${fmtNum(st.rate)}/s`),
    h('div', { class: 'meta' }, `${fmtInt(n.itemsRun)} this run · ${fmtInt(n.itemsSession)} total`),
    h(
      'div',
      { class: 'meta' },
      `${n.caps.cores} cores · ${n.caps.workers} worker${n.caps.workers === 1 ? "" : "s"}${n.caps.memoryGB ? ` · ${n.caps.memoryGB} GB` : ''} · ${n.caps.browser}${n.caps.webgpu ? ' · WebGPU' : ''}${n.caps.secure ? '' : ' · http'}`,
    ),
    compact ? null : h('div', { class: 'meta' }, `${st.ready.mobilenet ? '✓' : '·'} image model · ${st.ready.dataset} photos saved · ${st.ready.tutor ? `✓ ${st.ready.tutor}` : '· no tutor'} · Teach: ${st.fedPhotos.join('/')}`),
  );
  if (!compact && n.online && s.canControl) {
    const b = (label: string, f: () => void, cls = 'small') => {
      const x = h('button', { class: cls }, label);
      x.onclick = f;
      return x;
    };
    card.append(
      h(
        'div',
        { class: 'row', style: 'gap:6px' },
        b('Rename', () => {
          const v = prompt('Name for this device', n.name);
          if (v) cmd({ cmd: 'rename', nodeId: n.id, name: v });
        }),
        st.state === 'stopped' ? b('Resume', () => cmd({ cmd: 'node', nodeId: n.id, action: 'resume' })) : b('Stop', () => cmd({ cmd: 'node', nodeId: n.id, action: 'stop' })),
        b('Prepare', () => cmd({ cmd: 'node', nodeId: n.id, action: 'prepare', args: { all: true } })),
      ),
    );
  }
  return card;
}

function nodeGrid(s: ConsoleState, compact: boolean) {
  const key = [compact, s.canControl, s.nodes.map((n) => [n.id, n.name, n.online, n.status, n.itemsRun, n.itemsSession, n.mode, n.caps.workers])];
  return region(compact ? 'grid-c' : 'grid', key, () => {
    const online = s.nodes.filter((n) => n.online).length;
    return h(
      'div',
      { class: 'card col' },
      h('div', { class: 'row' }, h('h2', { style: 'margin:0', class: 'grow' }, `Devices (${online} online)`)),
      s.nodes.length ? h('div', { class: 'nodes' }, ...s.nodes.filter((n) => !compact || n.online).map((n) => nodeCard(n, s, compact))) : h('div', { class: 'muted' }, 'No devices yet. Scan the QR code with a Chromebook, phone or laptop.'),
    );
  });
}

function devicesView(s: ConsoleState) {
  const bulk = region('bulk', [s.canControl], () => {
    const b = (label: string, f: () => void, cls = '') => {
      const x = h('button', { class: cls }, label);
      x.onclick = f;
      return x;
    };
    return h(
      'div',
      { class: 'card row' },
      b('Stop all', () => cmd({ cmd: 'node', nodeId: '*', action: 'stop' }), 'danger'),
      b('Resume all', () => cmd({ cmd: 'node', nodeId: '*', action: 'resume' })),
      b('Prepare all (models + photos)', () => cmd({ cmd: 'node', nodeId: '*', action: 'prepare', args: { all: true } }), 'blue'),
      b('Forget offline devices', () => cmd({ cmd: 'forget-offline' }), 'ghost'),
    );
  });
  return [bulk, nodeGrid(s, false)];
}

// ---------- Benchmarks (+ optional measured watts) ----------
let benchRows: Record<string, unknown>[] = [];
let benchLoaded = false;
async function loadBench() {
  try {
    const r = await fetch(`/api/bench${keyQ ? `?${keyQ}` : ''}`);
    if (r.ok) benchRows = await r.json();
  } catch {}
  benchLoaded = true;
  regions.delete('bench-table');
  update();
}

const expPick: string[] = [];
let expLab: LabId = 'swarm-sort';
let expItems = 0; // 0 = the whole photo set

/** Chromebook first (the hero device), the Hub computer last, everyone else in between in join order. */
const TYPE_ORDER = ['chromebook', 'windows', 'linux', 'mac', 'android', 'ipad', 'iphone', 'other'];
function autoOrder(nodes: NodeView[]) {
  const rank = (n: NodeView) => (n.host ? 99 : Math.max(0, TYPE_ORDER.indexOf(n.caps.deviceType)));
  return nodes
    .slice()
    .sort((a, b) => rank(a) - rank(b) || a.connectedAt - b.connectedAt)
    .map((n) => n.id);
}

function experimentSummary(ex: NonNullable<ConsoleState['experiment']>) {
  const first = ex.rows[0];
  const last = ex.rows.at(-1);
  if (!first || !last || ex.rows.length < 2) return null;
  return h('div', { class: 'exp-summary' }, `1 device: ${fmtNum(first.seconds, 1)} s  →  ${last.devices} devices: ${fmtNum(last.seconds, 1)} s  =  ${fmtNum(last.speedup, 2)}× faster`);
}

function experimentPanel(s: ConsoleState) {
  const ex = s.experiment!;
  const status = ex.status === 'preparing' ? 'getting every device ready (image model + photos)…' : ex.status === 'running' ? `step ${ex.step} of ${ex.steps}` : ex.status;
  return region('exp', ex, () =>
    h(
      'div',
      { class: 'card col' },
      h('h3', null, `Speedup experiment · ${ex.lab === 'sweep' ? 'Science Sweep (π)' : 'Swarm Sort'} · ${fmtInt(ex.items)} ${ex.lab === 'sweep' ? 'batches' : 'photos'} · ${status}`),
      h('div', { class: 'muted small' }, `Order: ${ex.order.map((n, i) => `${i + 1}. ${n}`).join('  ')}`),
      experimentSummary(ex),
      h(
        'table',
        null,
        h('tr', null, h('th', null, 'Devices'), h('th', null, 'Which'), h('th', null, 'Seconds'), h('th', null, 'Items/s'), h('th', null, 'Speedup')),
        ...ex.rows.map((r) => h('tr', null, h('td', null, String(r.devices)), h('td', null, r.names.join(' + ')), h('td', { class: 'num' }, fmtNum(r.seconds, 2)), h('td', { class: 'num' }, fmtNum(r.itemsPerSec, 2)), h('td', { class: 'num' }, `${fmtNum(r.speedup, 2)}×`))),
      ),
    ),
  );
}

function benchView(s: ConsoleState) {
  if (!benchLoaded) void loadBench();
  const csv = (name: string, label: string) => h('a', { href: `/api/export/${name}.csv${keyQ ? `?${keyQ}` : ''}`, class: 'small', download: '' }, label);
  const online = s.nodes.filter((n) => n.online);
  const exRunning = s.experiment?.status === 'running' || s.experiment?.status === 'preparing';
  const exp = region('exp-form', [online.map((n) => [n.id, n.name]), expPick, expLab, expItems, s.experiment?.status, s.datasetCount], () => {
    const labSel = h('select', null, h('option', { value: 'swarm-sort', selected: expLab === 'swarm-sort' }, 'Swarm Sort'), h('option', { value: 'sweep', selected: expLab === 'sweep' }, 'Science Sweep (π)'));
    labSel.onchange = () => {
      expLab = labSel.value as LabId;
      update();
    };
    const nItems = expItems || (expLab === 'sweep' ? 400 : s.datasetCount);
    const items = h('input', { type: 'number', value: String(nItems), min: '10', max: '5000', style: 'width:110px' }) as HTMLInputElement;
    items.onchange = () => (expItems = Number(items.value) || 0);
    const picks = online.map((n) => {
      const pos = expPick.indexOf(n.id);
      const b = h('button', { class: pos >= 0 ? 'primary small' : 'small' }, pos >= 0 ? `${pos + 1}. ${n.name}` : n.name);
      b.onclick = () => {
        if (pos >= 0) expPick.splice(pos, 1);
        else expPick.push(n.id);
        update();
      };
      return b;
    });
    const all = h('button', { class: 'small' }, `Use all ${online.length} (Chromebook first, Hub last)`);
    all.disabled = !online.length;
    all.onclick = () => {
      expPick.splice(0, expPick.length, ...autoOrder(online));
      update();
    };
    const none = h('button', { class: 'small ghost' }, 'Clear order');
    none.onclick = () => {
      expPick.length = 0;
      update();
    };
    const picked = expPick.filter((id) => online.some((n) => n.id === id));
    const go = h('button', { class: 'blue' }, picked.length > 1 ? `▶ Run 1 → ${picked.length} devices` : '▶ Run 1, 2, 3… devices');
    go.disabled = !picked.length || exRunning;
    go.onclick = () => cmd({ cmd: 'experiment', lab: expLab, items: nItems, order: picked });
    const cancel = h('button', { class: 'ghost' }, 'Cancel');
    cancel.onclick = () => cmd({ cmd: 'experiment-cancel' });
    return h(
      'div',
      { class: 'card col' },
      h('h2', null, 'Automated speedup experiment'),
      h('p', { class: 'muted' }, 'Runs the same job on the first device, then the first two, then three… and logs every time. First every device loads the image model and saves the photos, so downloads never count against step 1. Tap “Use all”, or tap devices in the order to add them.'),
      h('div', { class: 'row' }, 'Lab', labSel, expLab === 'sweep' ? 'Batches' : 'Photos', items),
      h('div', { class: 'row' }, all, none),
      h('div', { class: 'row' }, ...picks),
      h('div', { class: 'row' }, go, exRunning ? cancel : null, csv('speedup', '⬇ speedup.csv')),
    );
  });
  // Online devices plus any device that already has a measurement, so old test devices don't clutter the table.
  const wattNodes = s.nodes.filter((n) => !n.host && (n.online || s.watts.some((w) => w.device === n.id)));
  const watts = region('watts', [wattNodes.map((n) => [n.id, n.name]), s.watts, s.hostCompute.name], () => {
    const rows = [{ id: 'hub', name: `${s.hostCompute.name.replace(/ \(Hub\)$/, '')} (Hub — includes its own computing)` }, ...wattNodes.map((n) => ({ id: n.id, name: n.name }))];
    const box = h(
      'details',
      { class: 'card col', open: wattsOpen || s.watts.length > 0 },
      h('summary', null, h('b', null, 'Optional: measured watts'), h('span', { class: 'muted' }, ' — only if you have a plug-in power meter')),
      h('p', { class: 'muted' }, 'Plug each device into a plug-in power meter. Type what it shows when idle and while computing. Energy per job appears only after you enter real readings here — Recompute never estimates watts. Leave this empty if you have no meter.'),
      h(
        'table',
        null,
        h('tr', null, h('th', null, 'Device'), h('th', null, 'Idle W'), h('th', null, 'Busy W'), h('th', null, 'Note'), h('th', null, '')),
        ...rows.map((r) => {
          const cur = s.watts.find((w) => w.device === r.id);
          const idle = h('input', { type: 'number', step: '0.1', min: '0', value: cur?.idle_w ?? '', style: 'width:90px' }) as HTMLInputElement;
          const busy = h('input', { type: 'number', step: '0.1', min: '0', value: cur?.busy_w ?? '', style: 'width:90px' }) as HTMLInputElement;
          const note = h('input', { value: cur?.note ?? '', placeholder: 'meter model, screen on…', style: 'width:100%' }) as HTMLInputElement;
          const save = h('button', { class: 'small primary' }, 'Save');
          save.onclick = () => cmd({ cmd: 'watts', device: r.id, idle_w: idle.value === '' ? null : Number(idle.value), busy_w: busy.value === '' ? null : Number(busy.value), note: note.value });
          return h('tr', null, h('td', null, r.name), h('td', null, idle), h('td', null, busy), h('td', null, note), h('td', null, save));
        }),
      ),
      h('div', { class: 'row' }, csv('watts', '⬇ watts.csv')),
    );
    box.addEventListener('toggle', () => (wattsOpen = box.open));
    return box;
  });
  // Hidden entirely unless real meter readings exist; never an empty or estimated energy panel.
  const energy = region('energy', [s.run?.jobId, s.run?.energy, s.run?.status], () => {
    const e = s.run?.energy;
    if (!s.run || !e) return h('div');
    return h(
      'div',
      { class: 'card col' },
      h('h2', null, 'Energy per job'),
      h(
        'div',
        { class: 'col' },
        h('div', { class: 'big' }, `${fmtNum(e.wh, 3)} Wh`),
        h('div', null, `${s.run.title} · ${e.whPer1000 !== null ? `${fmtNum(e.whPer1000, 3)} Wh per 1,000 ${s.run.unit}` : ''}`),
        h('div', { class: 'muted small' }, `= busy watts × seconds each device was active. Included: ${e.devices.join(', ') || '—'}.${e.missing.length ? ` Missing measurements: ${e.missing.join(', ')}.` : ''}`),
      ),
    );
  });
  const table = region('bench-table', [benchRows.length], () => {
    const refresh = h('button', { class: 'small' }, '↻ Refresh');
    refresh.onclick = () => void loadBench();
    const clr = h('button', { class: 'small ghost' }, 'Clear');
    clr.onclick = () => confirm('Delete all benchmark results?') && (cmd({ cmd: 'clear', what: 'bench' }), setTimeout(loadBench, 300));
    return h(
      'div',
      { class: 'card col' },
      h('div', { class: 'row' }, h('h2', { class: 'grow', style: 'margin:0' }, 'Benchmark results'), refresh, clr, csv('bench', '⬇ bench.csv'), csv('runs', '⬇ runs.csv')),
      h('p', { class: 'muted' }, 'Open ', h('b', { class: 'mono' }, '/bench'), ' on each device and tap Run. Results appear here. These are the only device speed numbers Recompute reports.'),
      benchRows.length
        ? h(
            'table',
            null,
            h('tr', null, h('th', null, 'Device'), h('th', null, 'Test'), h('th', null, 'Backend'), h('th', null, 'Threads'), h('th', null, 'Result')),
            ...benchRows
              .slice()
              .reverse()
              .slice(0, 60)
              .map((r) => h('tr', null, h('td', null, String(r.device ?? '')), h('td', null, String(r.test)), h('td', null, String(r.backend ?? '')), h('td', null, String(r.threads ?? '')), h('td', { class: 'num' }, `${fmtNum(Number(r.value), 2)} ${r.unit ?? ''}`))),
          )
        : h('div', { class: 'muted' }, 'No results yet.'),
    );
  });
  return [table, exp, s.experiment ? experimentPanel(s) : h('div'), watts, energy, modelsCard(s)];
}

function modelsCard(s: ConsoleState) {
  return region('models', s.models.map((m) => [m.id, m.ready, Math.round(m.progress * 100), m.error]), () =>
    h(
      'div',
      { class: 'card col' },
      h('h2', null, 'Models on the Hub'),
      h('p', { class: 'muted' }, 'Each model is downloaded once from the internet, checked against a pinned SHA-256 fingerprint, and then served to devices over the local network.'),
      h(
        'table',
        null,
        h('tr', null, h('th', null, 'Model'), h('th', null, 'Size'), h('th', null, 'License'), h('th', null, 'Status')),
        ...s.models.map((m) => {
          const dl = h('button', { class: 'small' }, m.error ? 'Retry download' : 'Download');
          dl.onclick = () => cmd({ cmd: 'model-download', id: m.id });
          return h('tr', null, h('td', null, m.title), h('td', null, fmtBytes(m.sizeBytes)), h('td', null, m.license), h('td', null, m.ready ? h('span', { class: 'pill ok' }, '✓ ready') : m.progress > 0 && !m.error ? `${Math.round(m.progress * 100)}%` : dl, m.error ? h('div', { class: 'small muted' }, m.error) : null));
        }),
      ),
    ),
  );
}

// ---------- Setup ----------
function setupView(s: ConsoleState) {
  return region('setup', [s.urls, s.room, s.demo, s.studentsCanLaunch, s.caFingerprint, s.canControl, zoomSetting(), s.isHost, s.hostCompute], () => {
    const toggle = (label: string, on: boolean, f: () => void) => {
      const b = h('button', { class: on ? 'primary' : '' }, `${on ? '✓ ' : ''}${label}`);
      b.onclick = f;
      return b;
    };
    const fresh = h('button', { class: 'ghost' }, 'Start fresh (clear practice history)');
    fresh.onclick = () =>
      confirm('Clear job history, impact counters and offline devices? Measured watts, benchmarks, speedup results and models are kept.') && cmd({ cmd: 'clear', what: 'history' });
    const newRoom = h('button', { class: 'ghost' }, 'New room code');
    newRoom.onclick = () => confirm('Make a new room code? Devices will need the new code.') && cmd({ cmd: 'new-room' });
    return h(
      'div',
      { class: 'col' },
      h(
        'div',
        { class: 'card col' },
        h('h2', null, 'Modes'),
        h('div', { class: 'row' }, toggle('Demo mode', s.demo, () => cmd({ cmd: 'demo', on: !s.demo })), h('span', { class: 'muted' }, 'Fixed job sizes, a “prepare everything” checklist, a one-tap reset, and the Chromebook can start Swarm Sort itself.')),
        h('div', { class: 'row' }, toggle('Students can start labs', s.studentsCanLaunch, () => cmd({ cmd: 'students-launch', on: !s.studentsCanLaunch }))),
        s.isHost ? h('div', { class: 'row' }, toggle(`${s.hostCompute.name} computes too`, s.hostCompute.on, () => cmd({ cmd: 'host-compute', on: !s.hostCompute.on })), h('span', { class: 'muted' }, 'The Hub computer joins as one more device (from this Console window).')) : null,
      ),
      h(
        'div',
        { class: 'card col' },
        h('h2', null, 'Screen size'),
        h('p', { class: 'muted' }, 'Auto makes everything bigger on wide screens (a 5K iMac or a 4K TV), so it reads on camera. Saved on this computer.'),
        h(
          'div',
          { class: 'row' },
          ...[['auto', 'Auto'], ['1', '100%'], ['1.25', '125%'], ['1.5', '150%'], ['1.75', '175%'], ['2', '200%']].map(([v, label]) => {
            const b = h('button', { class: zoomSetting() === v ? 'primary' : '' }, label);
            b.onclick = () => {
              try {
                if (v === 'auto') localStorage.removeItem(ZOOM_KEY);
                else localStorage.setItem(ZOOM_KEY, v);
              } catch {}
              applyZoom();
              regions.clear();
              update();
            };
            return b;
          }),
        ),
      ),
      h(
        'div',
        { class: 'card col' },
        h('h2', null, 'Addresses'),
        h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Join (secure)'), h('span', { class: 'mono small' }, s.urls.join), h('span', { class: 'k' }, 'Join (basic http)'), h('span', { class: 'mono small' }, s.urls.joinHttp), h('span', { class: 'k' }, 'Trust page'), h('span', { class: 'mono small' }, `${s.urls.trust}?room=${s.room}`), h('span', { class: 'k' }, 'Reborn mode'), h('span', { class: 'mono small' }, `${s.urls.join}&mode=reborn`), s.urls.console ? h('span', { class: 'k' }, 'Teacher console') : null, s.urls.console ? h('span', { class: 'mono small' }, s.urls.console) : null, h('span', { class: 'k' }, 'Hub addresses'), h('span', { class: 'mono small' }, s.urls.all.join('  '))),
        h('div', { class: 'small muted' }, `Certificate fingerprint (SHA-256): ${s.caFingerprint}`),
        h('div', { class: 'row' }, newRoom, fresh),
      ),
      h('div', { class: 'card col' }, h('h2', null, 'Privacy'), h('p', null, 'No accounts, no names, no analytics. Everything stays on this local network. Devices only run Recompute’s built-in programs; the Hub sends numbers, never code. Teach the Swarm photos never leave the device that took them.')),
    );
  });
}

// ---------- "This computer computes too": the Hub's own node ----------
// A tiny same-origin iframe running the normal node page in host mode. The heavy work happens in
// that page's Web Workers, so the Console itself stays smooth on camera.
let hostFrame: HTMLIFrameElement | null = null;
function syncHostFrame(s: ConsoleState) {
  const want = s.isHost && s.canControl && s.hostCompute.on;
  const src = want ? `/join?room=${s.room}&host=1&workers=${s.hostCompute.workers}&sw=0` : '';
  if (!want) {
    hostFrame?.remove();
    hostFrame = null;
    return;
  }
  if (hostFrame?.dataset.src === src) return;
  hostFrame?.remove();
  hostFrame = h('iframe', { title: 'This computer’s compute node', 'aria-hidden': 'true', tabindex: '-1', class: 'host-frame' }) as HTMLIFrameElement;
  hostFrame.dataset.src = src;
  hostFrame.src = src;
  document.body.append(hostFrame);
}

function hostCard(s: ConsoleState) {
  if (!s.isHost || !s.canControl) return null;
  const me = s.nodes.find((n) => n.host);
  const key = [s.hostCompute, me?.online, me?.status.state, me?.status.rate, me?.status.ready.mobilenet, me?.itemsRun, me?.name];
  return region('host', key, () => {
    const on = s.hostCompute.on;
    const b = h('button', { class: `host-toggle ${on ? 'primary' : ''}` }, on ? '✓ This computer computes too' : '💻 This computer computes too');
    b.onclick = () => cmd({ cmd: 'host-compute', on: !on });
    const opts: number[] = [];
    for (let k = 1; k <= s.hostCompute.maxWorkers; k++) opts.push(k);
    const sel = h('select', { class: 'small', 'aria-label': 'Workers' }, ...opts.map((k) => h('option', { value: String(k), selected: k === s.hostCompute.workers }, `${k} worker${k === 1 ? '' : 's'}`)));
    sel.onchange = () => cmd({ cmd: 'host-compute', on, workers: Number(sel.value) });
    const st = !on ? 'Off: this computer only coordinates.' : !me?.online ? 'Starting…' : me.status.state === 'working' ? `Computing · ${fmtNum(me.status.rate)}/s` : me.status.ready.mobilenet ? 'Ready' : 'Getting ready…';
    return h(
      'div',
      { class: `card col ${on ? 'host-on' : ''}` },
      h('h2', null, s.hostCompute.name),
      h('div', { class: 'row' }, b),
      h('div', { class: 'row small' }, h('span', { class: 'grow muted' }, st), sel),
      h('div', { class: 'muted small' }, 'Adds the Hub computer as one more device with its own tile. Keep this Console window open while it computes.'),
    );
  });
}

// ---------- update loop ----------
function update() {
  updateHead();
  if (!S) {
    clear(content, h('div', { class: 'boot' }, connected ? 'Loading…' : 'Connecting to the Hub…'));
    return;
  }
  const s = S;
  main.classList.toggle('wide', view !== 'lab');
  const parts = view === 'lab' ? labView(s) : view === 'devices' ? devicesView(s) : view === 'bench' ? benchView(s) : [setupView(s)];
  syncChildren(content, parts);
  syncChildren(side, view === 'lab' ? sideView(s) : []);
  syncHostFrame(s);
  side.classList.toggle('hidden', view !== 'lab');
  if (s.run && view === 'lab') drawRunCharts(s.run);
  if (view === 'lab') drawFed(s);
}

/** Replace children only where they differ, so canvases and inputs survive updates. */
function syncChildren(parent: HTMLElement, kids: Node[]) {
  kids.forEach((k, i) => {
    if (parent.childNodes[i] !== k) parent.insertBefore(k, parent.childNodes[i] ?? null);
  });
  while (parent.childNodes.length > kids.length) parent.lastChild!.remove();
}

window.addEventListener('resize', () => {
  applyZoom();
  if (S) update();
});

layout();
void loadLabels();
connect();
update();
