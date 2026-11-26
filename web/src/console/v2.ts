// Console panels for Swarm Render, the Screen Wall, Live Captions, Translate a document,
// use-case presets, the Night Shift queue and the fleet calculator.
// Everything shown comes from the Hub's live state or from measurements stored on the Hub.

import { h, fmtInt, fmtNum, fmtTime, toast } from '../shared/dom';
import { b64ToBytes, RENDER_PRESETS, tileGrid, type RenderRes } from '../shared/render';
import { wallLayout, drawWall, showSweepStart, wakeEnd } from '../shared/wall';
import { fleetRows, FLEET_SIZES } from '../shared/fleet';
import { resampleTo16k } from '../node/speech';
import type { ConsoleCmd, ConsoleState, LabId, RenderHeader, RenderTilesMsg, RunView, WallScene } from '../shared/protocol';

export interface Ctx {
  region: (id: string, key: unknown, build: () => Node | Node[] | null, tag?: keyof HTMLElementTagNameMap) => HTMLElement;
  canvas: (id: string) => HTMLCanvasElement;
  cmd: (c: ConsoleCmd) => void;
  update: () => void;
  keyQ: string;
  go: (view: string) => void;
}
let C: Ctx;
export function initV2(ctx: Ctx) {
  C = ctx;
}

const btn = (label: string, f: () => void, cls = '', disabled = false) => {
  const b = h('button', { class: cls }, label);
  b.disabled = disabled;
  b.onclick = f;
  return b;
};
const withKey = (url: string) => (C.keyQ ? `${url}${url.includes('?') ? '&' : '?'}${C.keyQ}` : url);

// ---------- device colours (same colour for a device everywhere on the Console) ----------
const PALETTE = ['#34d399', '#38bdf8', '#fbbf24', '#a78bfa', '#f87171', '#f472b6', '#2dd4bf', '#fb923c', '#a3e635', '#818cf8'];
const colorOf = new Map<string, string>();
export function deviceColor(id: string) {
  let c = colorOf.get(id);
  if (!c) colorOf.set(id, (c = PALETTE[colorOf.size % PALETTE.length]));
  return c;
}
const nameOf = (s: ConsoleState, id: string) => s.nodes.find((n) => n.id === id)?.name ?? 'a device that left';

// =====================================================================================
// Swarm Render
// =====================================================================================

export const renderOpts: { res: RenderRes; spp: number; first: string } = { res: '8k', spp: 2, first: '' };

interface LiveTile {
  item: number;
  x: number;
  y: number;
  w: number;
  h: number;
  node: string;
  t: number;
  data: ImageData;
  seen: number; // performance.now() when it arrived
}
let rHead: RenderHeader | null = null;
let rTiles: LiveTile[] = [];
const rImg = document.createElement('canvas');
let rLast = 0;
let showOwners = false;
let looping = false;
let replay: { start: number; dur: number; maxT: number; next: number; img: HTMLCanvasElement; rec: MediaRecorder | null } | null = null;

function sizeImg(c: HTMLCanvasElement, w: number, hh: number) {
  if (c.width !== w || c.height !== hh) {
    c.width = w;
    c.height = hh;
  }
  const g = c.getContext('2d')!;
  g.fillStyle = '#05070d';
  g.fillRect(0, 0, w, hh);
}

function toImageData(rgb: string, w: number, hh: number) {
  const src = b64ToBytes(rgb);
  const img = new ImageData(w, hh);
  const d = img.data;
  for (let i = 0, j = 0; i < w * hh; i++, j += 3) {
    d[i * 4] = src[j];
    d[i * 4 + 1] = src[j + 1];
    d[i * 4 + 2] = src[j + 2];
    d[i * 4 + 3] = 255;
  }
  return img;
}

export function onRenderTiles(m: RenderTilesMsg) {
  const job = m.header?.jobId ?? null;
  // A reset is a full sync (all tiles follow) or a new picture; a header-only update keeps the picture.
  if (m.reset && (m.tiles.length || job !== (rHead?.jobId ?? null))) {
    rTiles = [];
    replay = null;
    if (m.header) sizeImg(rImg, m.header.pw, m.header.ph);
  }
  rHead = m.header;
  if (rHead && (rImg.width !== rHead.pw || rImg.height !== rHead.ph)) sizeImg(rImg, rHead.pw, rHead.ph);
  const g = rImg.getContext('2d')!;
  const now = performance.now();
  const bulk = m.tiles.length > 200; // a catch-up sync: no border flashes
  for (const t of m.tiles) {
    const data = toImageData(t.rgb, t.w, t.h);
    g.putImageData(data, t.x, t.y);
    rTiles.push({ item: t.item, x: t.x, y: t.y, w: t.w, h: t.h, node: t.node, t: t.t, data, seen: bulk ? 0 : now });
  }
  if (m.tiles.length) rLast = now;
  kick();
}

function kick() {
  if (looping) return;
  looping = true;
  requestAnimationFrame(frame);
}

function frame() {
  const c = C.canvas('render');
  const now = performance.now();
  const busy = now - rLast < 2000 || replay !== null;
  if (c.isConnected) drawRender(c, now);
  if (busy && c.isConnected) requestAnimationFrame(frame);
  else looping = false;
}

function drawRender(c: HTMLCanvasElement, now: number) {
  const head = rHead;
  const w = head?.pw ?? 1920;
  const hh = head?.ph ?? 1080;
  if (c.width !== w || c.height !== hh) {
    c.width = w;
    c.height = hh;
  }
  const g = c.getContext('2d')!;
  if (!head) {
    g.fillStyle = '#05070d';
    g.fillRect(0, 0, w, hh);
    g.fillStyle = '#64748b';
    g.font = `600 ${Math.round(hh / 22)}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.fillText('Pick a size and press Swarm Render', w / 2, hh / 2);
    return;
  }
  const lw = Math.max(2, Math.round(w / 640));
  let tiles = rTiles;
  let flashAt = (t: LiveTile) => t.seen;
  if (replay) {
    const r = replay;
    const p = Math.min(1, (now - r.start) / r.dur);
    const upto = p * r.maxT;
    const rg = r.img.getContext('2d')!;
    const order = rTiles;
    while (r.next < order.length && order[r.next].t <= upto) {
      const t = order[r.next++];
      rg.putImageData(t.data, t.x, t.y);
    }
    g.drawImage(r.img, 0, 0);
    tiles = order.slice(0, r.next);
    const scale = r.dur / Math.max(1, r.maxT);
    flashAt = (t) => r.start + t.t * scale;
    drawClock(g, w, hh, upto / 1000);
    if (p >= 1 && now - r.start > r.dur + 1500) {
      r.rec?.stop();
      replay = null;
    }
  } else g.drawImage(rImg, 0, 0);
  if (showOwners) {
    for (const t of tiles) {
      g.fillStyle = deviceColor(t.node) + '48';
      g.fillRect(t.x, t.y, t.w, t.h);
      g.strokeStyle = deviceColor(t.node);
      g.lineWidth = lw;
      g.strokeRect(t.x + lw / 2, t.y + lw / 2, t.w - lw, t.h - lw);
    }
    return;
  }
  // While rendering, each new tile glows in its device's colour, then fades into the picture.
  for (const t of tiles) {
    const age = now - flashAt(t);
    if (age < 0 || age > 1600) continue;
    const a = 1 - age / 1600;
    const col = deviceColor(t.node);
    g.globalAlpha = 0.28 * a;
    g.fillStyle = col;
    g.fillRect(t.x, t.y, t.w, t.h);
    g.globalAlpha = a;
    g.strokeStyle = col;
    g.lineWidth = lw;
    g.strokeRect(t.x + lw / 2, t.y + lw / 2, t.w - lw, t.h - lw);
    g.globalAlpha = 1;
  }
}

function drawClock(g: CanvasRenderingContext2D, w: number, hh: number, sec: number) {
  const fs = Math.round(hh / 14);
  g.font = `800 ${fs}px system-ui, sans-serif`;
  g.textAlign = 'left';
  g.fillStyle = 'rgba(5,7,13,0.65)';
  g.fillRect(fs * 0.4, fs * 0.4, fs * 4.2, fs * 1.4);
  g.fillStyle = '#b8fff0';
  g.fillText(`${sec.toFixed(1)} s`, fs * 0.7, fs * 1.45);
}

function startReplay(record: boolean) {
  if (!rTiles.length || !rHead) return;
  const img = document.createElement('canvas');
  sizeImg(img, rHead.pw, rHead.ph);
  const ordered = rTiles.slice().sort((a, b) => a.t - b.t);
  rTiles = ordered;
  const maxT = Math.max(1, ordered.at(-1)!.t);
  let rec: MediaRecorder | null = null;
  if (record) {
    const c = C.canvas('render');
    const type = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm', 'video/mp4'].find((t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t));
    if (!type || !('captureStream' in c)) toast('This browser cannot record video; playing the timelapse only.', 'warn');
    else {
      const chunks: Blob[] = [];
      rec = new MediaRecorder((c as HTMLCanvasElement & { captureStream(fps: number): MediaStream }).captureStream(30), { mimeType: type, videoBitsPerSecond: 16_000_000 });
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = () => {
        const blob = new Blob(chunks, { type });
        const a = h('a', { href: URL.createObjectURL(blob), download: `recompute-render-timelapse.${type.includes('mp4') ? 'mp4' : 'webm'}` });
        document.body.append(a);
        a.click();
        setTimeout(() => {
          URL.revokeObjectURL(a.href);
          a.remove();
        }, 5000);
      };
      rec.start();
    }
  }
  replay = { start: performance.now() + 300, dur: 8000, maxT, next: 0, img, rec };
  kick();
}

/** Picture + legend + export buttons. Shown for the render lab (running, finished, or waiting to start). */
export function renderPanel(s: ConsoleState): Node[] {
  const run = s.run?.kernel === 'render' ? s.run : null;
  const counts = new Map<string, number>();
  for (const t of rTiles) counts.set(t.node, (counts.get(t.node) ?? 0) + 1);
  const total = rHead?.count ?? 0;
  const done = rTiles.length;
  const finished = !!rHead?.finishedAt;
  const baseRate = run?.baseline?.rate ?? null;
  const avg = run && run.elapsed > 0 ? run.done / run.elapsed : 0;
  const speedup = baseRate && run && run.devices > 1 ? avg / baseRate : null;
  const stage = C.region('render-stage', [rHead?.jobId, rHead?.width], () => {
    const c = C.canvas('render');
    c.className = 'render-canvas';
    queueMicrotask(kick);
    return h('div', { class: 'render-stage' }, c);
  });
  const hud = C.region('render-hud', [run?.elapsed, run?.status, done, total, speedup?.toFixed(1), rHead?.finishedAt, rHead?.width], () =>
    h(
      'div',
      { class: 'render-hud' },
      h('div', { class: 'stat' }, h('span', { class: 'v' }, run ? fmtTime(run.elapsed) : '—'), h('span', { class: 'k' }, finished ? 'total time' : 'elapsed')),
      h('div', { class: 'stat' }, h('span', { class: 'v' }, `${fmtInt(done)}/${fmtInt(total)}`), h('span', { class: 'k' }, 'tiles')),
      h('div', { class: 'stat' }, h('span', { class: 'v' }, rHead ? `${(rHead.width / 1000).toFixed(1)}K` : '—'), h('span', { class: 'k' }, rHead ? `${fmtInt(rHead.width)} × ${fmtInt(rHead.height)} px` : 'picture')),
      speedup
        ? h('div', { class: 'stat' }, h('span', { class: 'v', style: 'color:var(--green)' }, `${fmtNum(speedup, 1)}×`), h('span', { class: 'k' }, 'faster than 1 device (measured)'))
        : h('div', { class: 'stat' }, h('span', { class: 'v' }, run ? String(run.devices) : '0'), h('span', { class: 'k' }, 'devices rendering')),
    ),
  );
  const legend = C.region('render-legend', [[...counts], s.nodes.map((n) => [n.id, n.name])], () =>
    h(
      'div',
      { class: 'legend big-legend' },
      ...[...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([id, n]) => h('span', null, h('i', { style: `background:${deviceColor(id)}` }), `${nameOf(s, id)}: ${fmtInt(n)} tiles (${Math.round((100 * n) / Math.max(1, done))}%)`)),
      counts.size ? null : h('span', { class: 'muted' }, 'Each device’s tiles glow in its colour as they arrive.'),
    ),
  );
  const tools = C.region('render-tools', [showOwners, finished, rHead?.png, done > 0, s.canControl], () => {
    const owners = btn(showOwners ? '✓ Who rendered each tile' : '▦ Who rendered each tile', () => {
      showOwners = !showOwners;
      C.update();
      kick();
    }, showOwners ? 'primary small' : 'small');
    return h(
      'div',
      { class: 'row' },
      owners,
      btn('▶ Replay timelapse', () => startReplay(false), 'small', !done),
      btn('⏺ Save timelapse video', () => startReplay(true), 'small', !done),
      rHead?.png ? h('a', { class: 'btnlink small', href: withKey('/api/render.png'), download: '' }, '⬇ Full-size PNG') : h('span', { class: 'small muted' }, finished ? 'Saving the full-size PNG…' : ''),
      done ? h('a', { class: 'small', href: withKey('/api/render/tiles.csv'), download: '' }, '⬇ tiles.csv') : null,
    );
  });
  return [h('div', { class: 'card col render-card' }, stage, hud, legend, tools)];
}

/** "1 device vs all": the same picture on the first device alone, then on every device. */
export function racePanel(s: ConsoleState): Node {
  const online = s.nodes.filter((n) => n.online);
  if (!online.some((n) => n.id === renderOpts.first)) renderOpts.first = (online.find((n) => n.caps.deviceType === 'chromebook') ?? online.find((n) => !n.host) ?? online[0])?.id ?? '';
  const busy = s.experiment?.status === 'running' || s.experiment?.status === 'preparing';
  const rr = s.renderRace;
  return C.region('race', [online.map((n) => [n.id, n.name]), renderOpts, busy, s.run?.status, rr], () => {
    const sel = h('select', null, ...online.map((n) => h('option', { value: n.id, selected: n.id === renderOpts.first }, n.name)));
    sel.onchange = () => {
      renderOpts.first = sel.value;
      C.update();
    };
    const go = btn(`🏁 Race: 1 device vs all ${online.length}`, () => C.cmd({ cmd: 'race', lab: 'render', first: renderOpts.first, options: { res: renderOpts.res, spp: renderOpts.spp } }), 'blue', online.length < 2 || busy || !renderOpts.first);
    const cancel = busy ? btn('Cancel race', () => C.cmd({ cmd: 'experiment-cancel' }), 'ghost') : null;
    return h(
      'div',
      { class: 'card col' },
      h('h3', null, '1 device vs all'),
      h('div', { class: 'row' }, 'Alone first:', sel, go, cancel),
      h('div', { class: 'muted small' }, `Renders the same ${renderOpts.res.toUpperCase()} picture twice: on one device, then on all of them. Both times are measured and saved (Benchmarks → speedup.csv).`),
      rr
        ? h(
            'div',
            { class: 'row' },
            h('span', { class: 'small' }, `Last race: ${rr.rows.map((r) => `${r.devices} device${r.devices === 1 ? '' : 's'} ${fmtNum(r.seconds, 1)} s`).join(' vs ')}`),
            h('a', { class: 'btnlink small', href: withKey('/api/render.csv'), download: 'render.csv' }, '⬇ render.csv'),
          )
        : null,
    );
  });
}

export function renderExtra() {
  const resSel = h('select', { class: 'small' }, ...(Object.keys(RENDER_PRESETS) as RenderRes[]).map((r) => h('option', { value: r, selected: r === renderOpts.res }, `${r.toUpperCase()} · ${fmtInt(tileGrid({ ...RENDER_PRESETS[r], tile: 160 }).count)} tiles`)));
  const sppSel = h('select', { class: 'small' }, ...[1, 2, 4].map((v) => h('option', { value: String(v), selected: v === renderOpts.spp }, v === 1 ? 'draft' : v === 2 ? 'good' : 'best')));
  for (const el of [resSel, sppSel]) el.onclick = (e) => e.stopPropagation();
  resSel.onchange = () => (renderOpts.res = resSel.value as RenderRes);
  sppSel.onchange = () => (renderOpts.spp = Number(sppSel.value));
  return h('span', { class: 'row', style: 'gap:6px' }, resSel, sppSel);
}

// =====================================================================================
// Screen Wall
// =====================================================================================

let wallImg: HTMLImageElement | null = null;
let wallImgSrc = '';
let dragId: string | null = null;
let wallLoop = false;
let hubSkew = 0; // Hub clock minus this computer's clock, from the state timestamps

export function noteHubTime(hubT: number) {
  const d = hubT - Date.now();
  hubSkew = hubSkew === 0 ? d : hubSkew * 0.8 + d * 0.2;
}

const SCENES: [WallScene, string, string][] = [
  ['black', '⬛ All black', 'Every wall screen goes dark (ready for the cold open).'],
  ['wake', '✨ Wake sequence', 'Screens light up one by one with a pulse, then become one picture.'],
  ['image', '🖼 Show picture', 'The finished render, spread across all screens.'],
  ['sweep', '〰 RECOMPUTE sweep', 'The wordmark sweeps across every screen in sync.'],
  ['show', '▶ Full show', 'Wake → picture → wordmark sweep, in one go.'],
  ['off', '✕ Off', 'Screens go back to their normal page.'],
];

export function wallView(s: ConsoleState): Node[] {
  const w = s.wall;
  const devs = w.order.map((id) => w.devices.find((d) => d.id === id)).filter((d): d is NonNullable<typeof d> => !!d);
  const missing = w.devices.filter((d) => !w.order.includes(d.id));
  const all = [...devs, ...missing];
  const scenes = C.region('wall-scenes', [w.scene, w.at, s.canControl], () =>
    h(
      'div',
      { class: 'card col' },
      h('h2', null, 'Screen Wall'),
      h('p', { class: 'muted' }, 'Line up the devices left to right, in the same order as below. Every screen shows its own slice of one big picture, timed by the Hub’s clock.'),
      h('div', { class: 'wall-scenes' }, ...SCENES.map(([id, label, tip]) => {
        const b = btn(label, () => C.cmd({ cmd: 'wall', scene: id }), w.scene === id ? 'primary' : '');
        b.title = tip;
        return b;
      })),
      h('div', { class: 'muted small' }, `Now: ${SCENES.find((x) => x[0] === w.scene)?.[2] ?? w.scene}`),
    ),
  );
  const order = C.region('wall-order', [all.map((d) => [d.id, d.name, d.online, d.screen, d.clock && Math.round(d.clock.rtt)]), w.order, w.gap, s.canControl], () => {
    const ids = all.map((d) => d.id);
    const move = (id: string, to: number) => {
      const next = ids.filter((x) => x !== id);
      next.splice(Math.max(0, Math.min(next.length, to)), 0, id);
      C.cmd({ cmd: 'wall', order: next });
    };
    const gap = h('input', { type: 'range', min: '0', max: '160', step: '4', value: String(w.gap), style: 'width:220px' }) as HTMLInputElement;
    const gapV = h('span', { class: 'mono' }, `${w.gap} px`);
    gap.oninput = () => (gapV.textContent = `${gap.value} px`);
    gap.onchange = () => C.cmd({ cmd: 'wall', gap: Number(gap.value) });
    return h(
      'div',
      { class: 'card col' },
      h('h3', null, 'Order, left to right (drag, or use the arrows)'),
      all.length
        ? h(
            'div',
            { class: 'wall-list' },
            ...all.map((d, k) => {
              const item = h(
                'div',
                { class: `wall-item ${d.online && d.screen ? '' : 'off'}`, draggable: 'true' },
                h('span', { class: 'wall-n', style: `background:${deviceColor(d.id)}` }, String(k + 1)),
                h('div', { class: 'grow col', style: 'gap:2px' }, h('b', null, d.name), h('span', { class: 'small muted' }, d.screen ? `${d.screen.w}×${d.screen.h} screen${d.clock ? ` · clock ±${Math.max(1, Math.round(d.clock.rtt / 2))} ms` : ' · syncing clock…'}` : d.online ? 'waiting for its screen size…' : 'offline')),
                btn('◀', () => move(d.id, k - 1), 'small', k === 0),
                btn('▶', () => move(d.id, k + 1), 'small', k === all.length - 1),
              );
              item.ondragstart = () => (dragId = d.id);
              item.ondragover = (e) => e.preventDefault();
              item.ondrop = (e) => {
                e.preventDefault();
                if (dragId && dragId !== d.id) move(dragId, k);
                dragId = null;
              };
              return item;
            }),
          )
        : h('div', { class: 'muted' }, 'No screens yet. Open the join page on each device (it reports its screen size automatically). The Hub computer’s own hidden node is never on the wall.'),
      h('div', { class: 'row' }, 'Gap between screens (bezels):', gap, gapV),
    );
  });
  const preview = C.region('wall-preview', [w.image], () => {
    const c = C.canvas('wall');
    c.className = 'wall-canvas';
    queueMicrotask(() => kickWall());
    return h(
      'div',
      { class: 'card col' },
      h('h3', null, 'Preview (what each screen is showing now)'),
      c,
      h('div', { class: 'muted small' }, 'Tips: full brightness, auto-lock off, Do Not Disturb on. On iPhone, “Add to Home Screen” gives a full-screen page. Double-tap a screen to leave the wall. The brightest colour is a soft teal, never pure white, so phone cameras keep a steady exposure.'),
    );
  });
  if (w.image && w.image !== wallImgSrc) {
    wallImgSrc = w.image;
    const im = new Image();
    im.onload = () => (wallImg = im);
    im.src = w.image;
  }
  return [scenes, order, preview];
}

function kickWall() {
  if (wallLoop) return;
  wallLoop = true;
  requestAnimationFrame(wallFrame);
}

let lastState: ConsoleState | null = null;
export function setState(s: ConsoleState) {
  lastState = s;
}

function wallFrame() {
  const c = C.canvas('wall');
  const s = lastState;
  if (!c.isConnected || !s) {
    wallLoop = false;
    return;
  }
  const w = s.wall;
  const devs = w.order.map((id) => w.devices.find((d) => d.id === id)).filter((d) => d && d.online && d.screen) as { id: string; name: string; screen: { w: number; h: number } }[];
  const { canvas, slots } = wallLayout(devs.map((d) => ({ id: d.id, w: d.screen.w, h: d.screen.h })), w.gap);
  const cssW = c.clientWidth || 900;
  const scale = canvas.w > 0 ? Math.min(cssW / canvas.w, 360 / Math.max(1, canvas.h)) : 1;
  const W = Math.max(1, Math.round(canvas.w * scale));
  const H = Math.max(1, Math.round(canvas.h * scale));
  if (c.width !== Math.max(W, 10) || c.height !== Math.max(H, 10)) {
    c.width = Math.max(W, 10);
    c.height = Math.max(H, 10);
  }
  const g = c.getContext('2d')!;
  g.fillStyle = '#0b1220';
  g.fillRect(0, 0, c.width, c.height);
  const now = Date.now() + hubSkew;
  const imgSize = wallImg ? { w: wallImg.naturalWidth, h: wallImg.naturalHeight } : null;
  devs.forEach((d, k) => {
    const slot = slots.get(d.id)!;
    g.save();
    g.translate(slot.x * scale, slot.y * scale);
    g.scale(scale, scale);
    g.beginPath();
    g.rect(0, 0, slot.w, slot.h);
    g.clip();
    const scene = w.scene === 'off' ? 'off' : w.scene;
    drawWall(g, { scene, at: w.at, slot, canvas, index: k, count: devs.length }, now, wallImg, imgSize);
    g.restore();
    g.strokeStyle = deviceColor(d.id);
    g.lineWidth = 2;
    g.strokeRect(slot.x * scale + 1, slot.y * scale + 1, slot.w * scale - 2, slot.h * scale - 2);
    g.fillStyle = '#e2e8f0';
    g.font = '600 13px system-ui, sans-serif';
    g.fillText(`${k + 1}. ${d.name}`, slot.x * scale + 6, (slot.y + slot.h) * scale - 8);
  });
  if (!devs.length) {
    g.fillStyle = '#64748b';
    g.font = '600 16px system-ui, sans-serif';
    g.fillText('No screens on the wall yet', 16, 30);
  }
  requestAnimationFrame(wallFrame);
}

/** How long the current scene runs, in seconds. */
export function wallSceneSeconds(scene: WallScene, count: number) {
  if (scene === 'wake') return wakeEnd(count) / 1000;
  if (scene === 'show') return showSweepStart(count) / 1000;
  return 0;
}

// =====================================================================================
// Live Captions
// =====================================================================================

interface Mic {
  ctx: AudioContext;
  proc: ScriptProcessorNode;
  stream: MediaStream | null;
  src: AudioNode;
  kind: 'mic' | 'sample';
  buf: Float32Array[];
  len: number;
  loud: boolean;
  floor: number;
}
let mic: Mic | null = null;
let capSeq = 0;
const MIN_SEC = 2;
const MAX_SEC = 5;

async function startAudio(kind: 'mic' | 'sample') {
  stopAudio();
  const ctx = new AudioContext();
  let src: AudioNode;
  let stream: MediaStream | null = null;
  if (kind === 'mic') {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser has no microphone access here (it needs the secure https page).');
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    src = ctx.createMediaStreamSource(stream);
  } else {
    const wav = await (await fetch('/data/speech/sample-en.wav')).arrayBuffer();
    const buf = await ctx.decodeAudioData(wav);
    const bs = ctx.createBufferSource();
    bs.buffer = buf;
    bs.connect(ctx.destination); // play it out loud so the room hears what is being captioned
    bs.onended = () => {
      if (mic?.src === bs) setTimeout(() => (mic?.src === bs ? stopAudio() : undefined), 300);
    };
    bs.start();
    src = bs;
  }
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const mute = ctx.createGain();
  mute.gain.value = 0;
  src.connect(proc);
  proc.connect(mute);
  mute.connect(ctx.destination);
  const m: Mic = { ctx, proc, stream, src, kind, buf: [], len: 0, loud: false, floor: 0.004 };
  proc.onaudioprocess = (e) => onAudio(m, e.inputBuffer.getChannelData(0));
  mic = m;
  await ctx.resume();
  C.update();
}

function stopAudio() {
  const m = mic;
  if (!m) return;
  mic = null;
  flush(m);
  try {
    m.proc.disconnect();
    m.src.disconnect();
    if (m.src instanceof AudioBufferSourceNode) m.src.stop();
  } catch {}
  m.stream?.getTracks().forEach((t) => t.stop());
  void m.ctx.close();
  C.update();
}

function rms(a: Float32Array) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, a.length));
}

/** Cut the stream into 2–5 s pieces at a quiet moment, so words aren't split in half. */
function onAudio(m: Mic, block: Float32Array) {
  const r = rms(block);
  const quiet = r < Math.max(0.008, m.floor * 2.5);
  if (quiet) m.floor = m.floor * 0.95 + r * 0.05;
  else m.loud = true;
  m.buf.push(block.slice());
  m.len += block.length;
  const sec = m.len / m.ctx.sampleRate;
  if ((sec >= MIN_SEC && quiet) || sec >= MAX_SEC) flush(m);
}

function flush(m: Mic) {
  if (!m.len) return;
  const all = new Float32Array(m.len);
  let o = 0;
  for (const b of m.buf) {
    all.set(b, o);
    o += b.length;
  }
  const loud = m.loud;
  m.buf = [];
  m.len = 0;
  m.loud = false;
  if (!loud) return; // silence: nothing to caption
  const pcm = resampleTo16k(all, m.ctx.sampleRate);
  const i16 = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) i16[i] = Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767)));
  const bytes = new Uint8Array(i16.buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  C.cmd({ cmd: 'caption-audio', seq: capSeq++, pcm: btoa(s), sampleRate: 16000, endedAt: Date.now() });
  // The audio is gone from this page now too: only the base64 text was sent, and nothing keeps it.
}

export function captionsView(s: ConsoleState): Node[] {
  const cap = s.captions;
  const asr = s.models.find((m) => m.id === 'whisper-tiny-en');
  const mt = s.models.find((m) => m.id === 'opus-mt-en-es');
  const able = s.nodes.filter((n) => n.online && n.status.ready.asr).length;
  const controls = C.region('cap-controls', [cap.on, cap.translate, mic?.kind ?? null, asr?.ready, mt?.ready, able, s.canControl], () => {
    const on = cap.on;
    const micBtn = mic?.kind === 'mic' ? btn('■ Stop microphone', stopAudio, 'danger') : btn('🎤 Start microphone', () => void startAudio('mic').catch((e) => toast(`Microphone: ${e instanceof Error ? e.message : e}`, 'warn')), 'primary', !on);
    const sample = mic?.kind === 'sample' ? btn('■ Stop sample', stopAudio, 'danger') : btn('▶ Play the sample speech', () => void startAudio('sample').catch((e) => toast(String(e), 'warn')), '', !on);
    const tr = btn(cap.translate ? '✓ Spanish line' : 'Add Spanish line', () => C.cmd({ cmd: 'captions', on: true, translate: !cap.translate }), cap.translate ? 'blue' : '', !on || !mt?.ready);
    const power = on ? btn('Turn captions off', () => (stopAudio(), C.cmd({ cmd: 'captions', on: false })), 'ghost') : btn('▶ Turn captions on', () => C.cmd({ cmd: 'captions', on: true, translate: !!mt?.ready }), 'primary', !asr?.ready);
    const clr = btn('Clear', () => C.cmd({ cmd: 'captions-clear' }), 'ghost small');
    return h(
      'div',
      { class: 'card col' },
      h('div', { class: 'row' }, h('h2', { class: 'grow', style: 'margin:0' }, '🎙️ Live Captions'), power, clr),
      h('div', { class: 'row' }, micBtn, sample, tr),
      !asr?.ready ? h('div', { class: 'pill warn' }, 'The speech model is not on the Hub yet (Benchmarks → Models).') : null,
      on && !able ? h('div', { class: 'pill warn' }, 'Devices are loading the speech model… (about 45 MB, or 165 MB with Spanish, once per device)') : null,
      h('div', { class: 'muted small' }, 'The microphone is on this computer. Each 2–5 second piece of speech goes to whichever device is free; captions come back in order. Speech is processed in memory and dropped; nothing is recorded or saved.'),
    );
  });
  const live = C.region('cap-live', [cap.lines.slice(-3).map((l) => [l.seq, l.en, l.es]), cap.translate], () => {
    const recent = cap.lines.filter((l) => l.en.trim()).slice(-3);
    return h(
      'div',
      { class: 'card captions' },
      recent.length
        ? recent.map((l, k) =>
            h('div', { class: `cap-line ${k === recent.length - 1 ? 'now' : ''}` }, h('div', { class: 'cap-en' }, l.en), cap.translate && l.es ? h('div', { class: 'cap-es' }, l.es) : null),
          )
        : h('div', { class: 'cap-line now' }, h('div', { class: 'cap-en muted' }, cap.on ? 'Listening…' : 'Captions are off')),
    );
  });
  const stats = C.region('cap-stats', [cap.lagSec, Math.round(cap.audioSecondsHeard), cap.pending, cap.devices, cap.timedLines > 0], () =>
    h(
      'div',
      { class: 'stats' },
      h('div', { class: 'stat zero-stat' }, h('span', { class: 'v' }, '0'), h('span', { class: 'k' }, 'seconds of audio saved')),
      h('div', { class: 'stat' }, h('span', { class: 'v' }, cap.lagSec === null ? '—' : `~${fmtNum(cap.lagSec, 1)} s`), h('span', { class: 'k' }, cap.lagSec === null ? 'delay: not measured yet' : 'captions behind speech (measured, median of last 10)')),
      h('div', { class: 'stat' }, h('span', { class: 'v' }, fmtTime(cap.audioSecondsHeard)), h('span', { class: 'k' }, 'of speech captioned')),
      h('div', { class: 'stat' }, h('span', { class: 'v' }, String(cap.devices.length)), h('span', { class: 'k' }, cap.devices.length ? `devices: ${cap.devices.join(', ')}` : 'devices helping')),
      cap.timedLines > 0 ? h('a', { class: 'btnlink small', href: withKey('/api/captions.csv'), download: 'captions.csv', title: 'Measured delay of every caption since the last Clear. Timings only: no words, no audio.' }, '⬇ captions.csv') : null,
    ),
  );
  const hist = C.region('cap-hist', [cap.lines.length, cap.lines.at(-1)?.seq], () =>
    cap.lines.length > 3
      ? h(
          'div',
          { class: 'card col' },
          h('h3', null, 'Earlier'),
          ...cap.lines
            .slice(0, -3)
            .slice(-12)
            .map((l) => h('div', { class: 'small' }, h('b', null, l.en || '…'), l.es ? h('span', { class: 'muted' }, ` — ${l.es}`) : null, h('span', { class: 'muted' }, `  (${l.node}, ${fmtNum(l.lagSec, 1)} s)`))),
        )
      : h('div'),
  );
  return [controls, live, stats, hist];
}

/** Stop the microphone when leaving the captions lab. */
export function captionsLeft() {
  if (mic) stopAudio();
}

// =====================================================================================
// Translate a document / Summarize
// =====================================================================================

const SAMPLE_DOC = `Welcome to the new school year! This letter explains how to sign up for the after-school homework club.

The club meets every Tuesday and Thursday from 3:15 to 4:30 in the library. Students can get help with math, reading and science.

There is no cost to join. Please fill out the form on the back of this page and return it to your child's teacher by Friday.

If you have questions, call the front office or visit us during the family open house next month.`;
let docText = '';
let docMode: 'translate' | 'summarize' = 'translate';

export function setDocMode(m: 'translate' | 'summarize') {
  docMode = m;
}

export function docPanel(s: ConsoleState): Node {
  const mt = s.models.find((m) => m.id === 'opus-mt-en-es');
  const llm = s.models.find((m) => m.kind === 'gguf' && m.ready);
  return C.region('doc', [docMode, mt?.ready, llm?.id, s.canControl, s.run?.status], () => {
    const ta = h('textarea', { rows: '9', placeholder: 'Paste English text here. Blank lines separate paragraphs.', class: 'doc-input' }) as HTMLTextAreaElement;
    ta.value = docText;
    ta.oninput = () => (docText = ta.value);
    const paras = () => docText.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const sample = btn('Use a sample school letter', () => {
      docText = SAMPLE_DOC;
      ta.value = docText;
    }, 'small ghost');
    const tabs = h('div', { class: 'row' }, btn('English → Spanish', () => (docMode = 'translate', C.update()), docMode === 'translate' ? 'primary small' : 'small'), btn('Summarize (Private Tutor)', () => (docMode = 'summarize', C.update()), docMode === 'summarize' ? 'primary small' : 'small'));
    const go =
      docMode === 'translate'
        ? btn('▶ Translate with the swarm', () => {
            const p = paras();
            if (!p.length) return toast('Paste some text first.', 'warn');
            C.cmd({ cmd: 'start', lab: 'translate', options: { paragraphs: p } });
          }, 'primary', !mt?.ready)
        : btn('▶ Summarize each paragraph', () => {
            const p = paras();
            if (!p.length) return toast('Paste some text first.', 'warn');
            C.cmd({ cmd: 'start', lab: 'tutor', options: { model: llm?.id, maxTokens: 80, questions: p.map((x) => `Summarize this in one short sentence:\n\n${x}`) } });
          }, 'primary', !llm);
    return h(
      'div',
      { class: 'card col' },
      h('h2', null, '📄 Private documents'),
      tabs,
      ta,
      h('div', { class: 'row' }, go, sample),
      h('div', { class: 'muted small' }, docMode === 'translate' ? 'Each paragraph goes to a free device; they translate in parallel. The text never leaves this network.' : 'Each paragraph is summarized by the offline tutor model on one device. Short texts work best; check the summaries before you use them.'),
      !mt?.ready && docMode === 'translate' ? h('div', { class: 'pill warn' }, 'The translation model is not on the Hub yet.') : null,
    );
  });
}

export function translateExtra(run: RunView): Node {
  const tr = ((run.extra as Record<string, unknown>).translations as { i: number; en: string; es: string; node: string; seconds: number }[]) ?? [];
  return C.region('extra', [tr.length], () =>
    h(
      'div',
      { class: 'card col' },
      h('h3', null, 'Translated paragraphs (each by one device, offline)'),
      tr.length
        ? h('div', { class: 'doc-out' }, ...tr.map((t) => h('div', { class: 'doc-pair' }, h('div', null, t.en), h('div', { class: 'es' }, t.es, h('div', { class: 'muted small' }, `${t.node} · ${fmtNum(t.seconds)} s`)))))
        : h('div', { class: 'muted' }, 'Waiting for the first paragraph…'),
      h('div', { class: 'muted small' }, 'Machine translation can make mistakes. Have a Spanish speaker check anything important.'),
    ),
  );
}

// =====================================================================================
// Use cases: "Recompute beyond school"
// =====================================================================================

interface UseCase {
  id: string;
  icon: string;
  title: string;
  who: string;
  runs: string;
  privacy: string;
  honest: string;
  open: { lab?: LabId; view?: string; doc?: 'translate' | 'summarize' };
}
export const USE_CASES: UseCase[] = [
  {
    id: 'library',
    icon: '📚',
    title: 'Library or community center',
    who: 'Libraries and community centers with a shelf of donated or retired laptops.',
    runs: 'Private Tutor (offline AI help with homework and forms) and Translate a document for newcomers.',
    privacy: 'Questions and documents stay on the local network. No accounts, no cloud service.',
    honest: 'The tutor is a small model: good for simple explanations, not for facts you can’t check.',
    open: { lab: 'tutor' },
  },
  {
    id: 'shelter',
    icon: '🏕️',
    title: 'Emergency shelter (no internet)',
    who: 'Shelters and relief centers where the internet is down but there is power and a Wi-Fi router.',
    runs: 'Live Captions with a Spanish line, and the offline Private Tutor for questions.',
    privacy: 'Speech is processed in memory and dropped. Nothing is recorded or uploaded.',
    honest: 'Works when the internet doesn’t, because every model was saved on the Hub beforehand. Captions run a few seconds behind speech (measured on screen).',
    open: { lab: 'captions' },
  },
  {
    id: 'office',
    icon: '🗂️',
    title: 'Nonprofit or small office',
    who: 'Small organizations with old laptops and private documents they can’t paste into a cloud tool.',
    runs: 'Translate a document (paragraphs in parallel) and short summaries with the Private Tutor model.',
    privacy: 'Documents are processed on the office’s own devices and are not stored by the Hub after the job.',
    honest: 'Translations and summaries can contain mistakes; a person should check them.',
    open: { lab: 'translate', doc: 'translate' },
  },
  {
    id: 'art',
    icon: '🎨',
    title: 'Art and film class',
    who: 'Art, design and film classes that want big, high-resolution images without a render farm.',
    runs: 'Swarm Render: an 8K picture rendered tile by tile across the room, then shown on the Screen Wall.',
    privacy: 'The scene is built into Recompute; no files are uploaded.',
    honest: 'More devices finish faster, but each old device is slow alone. The speedup shown is measured.',
    open: { lab: 'render' },
  },
  {
    id: 'science',
    icon: '🔬',
    title: 'Science class and citizen science',
    who: 'Science classes running simulations: disease-spread sweeps and Monte Carlo experiments.',
    runs: 'Science Sweep, queued on the Night Shift: jobs run only on devices that are charging and idle, for example a cart overnight.',
    privacy: 'Only simulation numbers travel on the local network.',
    honest: 'Devices whose browser can’t report charging are skipped unless you allow them.',
    open: { view: 'uses' },
  },
  {
    id: 'home',
    icon: '🏠',
    title: 'Home and family',
    who: 'Families with old phones and laptops in a drawer.',
    runs: 'Any Lab: pool the family’s old devices on the home Wi-Fi, with one old computer as the Hub.',
    privacy: 'Everything stays on the home network. No sign-up.',
    honest: 'Swarm Sort uses its built-in photo set today; sorting your own photos is on the roadmap.',
    open: { lab: 'swarm-sort' },
  },
];

let openDocHook: ((m: 'translate' | 'summarize') => void) | null = null;
export function onOpenDoc(f: (m: 'translate' | 'summarize') => void) {
  openDocHook = f;
}

export function useCasesView(s: ConsoleState): Node[] {
  const cards = C.region('uc', [s.usecase, s.canControl], () =>
    h(
      'div',
      { class: 'col' },
      h('div', { class: 'card col' }, h('h2', { style: 'margin:0' }, 'Recompute beyond school'), h('p', { class: 'muted', style: 'margin:0' }, 'The same old devices and the same built-in Labs, set up for other places. Pick one to open the right Lab.')),
      h(
        'div',
        { class: 'uc-grid' },
        ...USE_CASES.map((u) =>
          h(
            'div',
            { class: `card col uc ${s.usecase === u.id ? 'on' : ''}` },
            h('div', { class: 'uc-t' }, h('span', { class: 'uc-i' }, u.icon), u.title),
            h('div', null, h('b', null, 'For: '), u.who),
            h('div', null, h('b', null, 'Runs: '), u.runs),
            h('div', { class: 'uc-p' }, '🔒 ', u.privacy),
            h('div', { class: 'muted small' }, u.honest),
            btn(s.usecase === u.id ? '✓ Open' : 'Open', () => {
              C.cmd({ cmd: 'usecase', id: u.id });
              if (u.open.doc) {
                setDocMode(u.open.doc);
                openDocHook?.(u.open.doc);
              }
              if (u.open.lab === 'captions') C.cmd({ cmd: 'captions', on: true, translate: !!s.models.find((m) => m.id === 'opus-mt-en-es')?.ready });
              if (u.open.lab && u.open.lab !== 'captions' && u.open.lab !== 'translate') pendingLab = u.open.lab;
              if (u.open.lab) C.go('lab');
              else document.getElementById('night')?.scrollIntoView({ behavior: 'smooth' });
            }, 'primary'),
          ),
        ),
      ),
    ),
  );
  return [cards, nightPanel(s), fleetPanel(s)];
}

/** A lab picked from a use-case card: highlighted in the launcher until started. */
export let pendingLab: LabId | null = null;
export function clearPendingLab() {
  pendingLab = null;
}

// =====================================================================================
// Night Shift
// =====================================================================================

const NIGHT_JOBS: { label: string; lab: LabId; options: Record<string, unknown> }[] = [
  { label: '🧪 Disease-spread sweep (SIR)', lab: 'sweep', options: { kind: 'sir' } },
  { label: 'π Estimate π', lab: 'sweep', options: { kind: 'pi' } },
  { label: '🎨 8K render', lab: 'render', options: { res: '8k', spp: 4 } },
  { label: '🖼️ Sort the photo set', lab: 'swarm-sort', options: {} },
];

function nightPanel(s: ConsoleState): Node {
  const ns = s.nightShift;
  return C.region('night', [ns, s.nodes.map((n) => [n.id, n.name]), s.canControl], () => {
    const el = h(
      'div',
      { class: 'card col', id: 'night' },
      h('div', { class: 'row' }, h('h2', { class: 'grow', style: 'margin:0' }, '🌙 Night Shift'), ns.armed ? btn('⏸ Night Shift is on', () => C.cmd({ cmd: 'night', action: 'disarm' }), 'blue') : btn('▶ Turn Night Shift on', () => C.cmd({ cmd: 'night', action: 'arm' }), 'primary')),
      h('p', { class: 'muted', style: 'margin:0' }, 'Queue jobs to run later, one after another, only on devices that are plugged in and idle (for example a charging cart overnight). Everything stays on the local network.'),
      h('div', { class: 'row' }, 'Add to the queue:', ...NIGHT_JOBS.map((j) => btn(j.label, () => C.cmd({ cmd: 'night', action: 'add', lab: j.lab, options: j.options }), 'small'))),
      ns.queue.length
        ? h(
            'table',
            null,
            h('tr', null, h('th', null, 'Job'), h('th', null, 'Status'), h('th', null, 'Time'), h('th', null, '')),
            ...ns.queue.map((q) =>
              h(
                'tr',
                null,
                h('td', null, q.title),
                h('td', null, h('span', { class: `pill ${q.status === 'done' ? 'ok' : q.status === 'running' ? 'info' : q.status === 'cancelled' ? 'warn' : ''}` }, q.status)),
                h('td', { class: 'num' }, q.seconds !== null ? fmtTime(q.seconds) : ''),
                h('td', null, q.status === 'waiting' ? btn('Remove', () => C.cmd({ cmd: 'night', action: 'remove', id: q.id }), 'small ghost') : null),
              ),
            ),
          )
        : h('div', { class: 'muted' }, 'The queue is empty.'),
      h(
        'div',
        { class: 'row' },
        h('span', { class: 'grow' }, ns.eligible.length ? `Can work now (charging + idle): ${ns.eligible.join(', ')}` : 'No device can work right now: plug one in and leave it idle.'),
        btn(ns.allowUnknownBattery ? '✓ Include devices that can’t report charging' : 'Include devices that can’t report charging', () => C.cmd({ cmd: 'night', action: 'allow-unknown', on: !ns.allowUnknownBattery }), ns.allowUnknownBattery ? 'small blue' : 'small'),
        ns.queue.some((q) => q.status === 'done' || q.status === 'cancelled') ? btn('Clear finished', () => C.cmd({ cmd: 'night', action: 'clear-done' }), 'small ghost') : null,
      ),
      h('div', { class: 'muted small' }, 'iPhones and Safari can’t report charging. They are left out unless you include them above.'),
    );
    return el;
  });
}

// =====================================================================================
// Fleet calculator (projection from measured numbers only)
// =====================================================================================

let fleetSize = 30;
const FLEET_PRESETS: [number, string][] = [
  [FLEET_SIZES[0], 'One cart (30)'],
  [FLEET_SIZES[1], 'A district’s retired devices (9,483)'],
];

function fleetPanel(s: ConsoleState): Node {
  const f = s.fleet;
  return C.region('fleet', [f, fleetSize], () => {
    const ready = f.perDevice.length > 0 && f.efficiency !== null;
    const head = h('h2', { style: 'margin:0' }, '📈 Fleet calculator');
    if (!ready)
      return h(
        'div',
        { class: 'card col' },
        head,
        h('p', { class: 'muted', style: 'margin:0' }, 'This stays empty until there are real measurements. It needs:'),
        h('div', null, `${f.perDevice.length ? '✓' : '○'} a per-device speed (Benchmarks: open /bench on a device and tap Run)`),
        h('div', null, `${f.efficiency ? '✓' : '○'} a measured scaling efficiency (Benchmarks: run the speedup experiment with 2 or more devices)`),
      );
    const eff = f.efficiency!;
    const custom = h('input', { type: 'number', min: '1', max: '1000000', value: String(fleetSize), style: 'width:120px' }) as HTMLInputElement;
    custom.onchange = () => {
      fleetSize = Math.max(1, Math.min(1_000_000, Math.round(Number(custom.value) || 1)));
      C.update();
    };
    const N = fleetSize;
    const rows = fleetRows(f, N).map((r): [string, string, string] => [r.metric, r.unit === 'seconds' ? (r.value < 1 ? 'under 1 s' : fmtTime(r.value)) : r.unit === 'hours per hour' ? fmtNum(r.value, 1) : fmtInt(Math.round(r.value)), r.source]);
    const sizes = [...new Set([...FLEET_SIZES, N])].sort((a, b) => a - b);
    const dl = h('a', { class: 'btnlink small', href: withKey(`/api/fleet.csv?n=${N}`), download: 'fleet.csv', title: 'Projection from measured per-device speed × measured scaling efficiency; real results vary.' }, '⬇ fleet.csv');
    return h(
      'div',
      { class: 'card col' },
      head,
      h('div', { class: 'row' }, ...FLEET_PRESETS.map(([n, l]) => btn(l, () => ((fleetSize = n), C.update()), N === n ? 'primary small' : 'small')), 'Custom:', custom, 'devices'),
      h(
        'table',
        null,
        h('tr', null, h('th', null, `With ${fmtInt(N)} devices`), h('th', null, 'Projection'), h('th', null, 'Measured from')),
        ...rows.map(([a, b, c]) => h('tr', null, h('td', null, a), h('td', { class: 'num big-num' }, b), h('td', { class: 'small muted' }, c))),
      ),
      h('div', { class: 'banner info' }, 'Projection from measured per-device speed × measured scaling efficiency; real results vary.'),
      h('div', { class: 'row' }, dl, h('span', { class: 'small muted' }, `rows for ${sizes.map((n) => fmtInt(n)).join(', ')} devices`)),
      h(
        'div',
        { class: 'muted small' },
        `Per-device speed uses the slowest measured device. Scaling efficiency ${Math.round(eff.value * 100)}% (${eff.source}) was measured with only ${eff.devices} devices; large fleets would run as many rooms of about 30 devices, each with its own Hub.`,
      ),
    );
  });
}
