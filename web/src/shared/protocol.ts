// Messages exchanged over the WebSocket between Hub, Nodes and Console.
// Plain JSON only. Nodes only ever run the built-in kernels listed in KERNELS;
// the Hub sends data (item numbers and parameters), never code.

export const KERNELS = ['classify', 'pi', 'sir', 'tutor', 'render', 'caption', 'translate'] as const;
export type Kernel = (typeof KERNELS)[number];

export type LabId = 'swarm-sort' | 'teach' | 'tutor' | 'sweep' | 'render' | 'captions' | 'translate';

/** Kernels that hold a big model and run one at a time per device (the "llm" pool). */
export const HEAVY_KERNELS: readonly Kernel[] = ['tutor', 'caption', 'translate'];

export type DeviceType = 'chromebook' | 'iphone' | 'ipad' | 'android' | 'mac' | 'windows' | 'linux' | 'other';

export interface Capabilities {
  cores: number;
  workers: number;
  memoryGB: number | null; // navigator.deviceMemory (Chrome only, rounded by the browser)
  webgpu: string | null; // adapter description, or null when unavailable
  isolated: boolean; // crossOriginIsolated: multi-threaded WASM possible
  secure: boolean; // isSecureContext
  ua: string;
  deviceType: DeviceType;
  browser: string;
}

export type BatteryState = 'charging' | 'on-battery' | 'unknown';

export type NodeState =
  | 'idle'
  | 'working'
  | 'paused-unplugged'
  | 'paused-input' // Join mode: the person is using this device (keys, clicks, touches)
  | 'stopped'
  | 'hidden'
  | 'preparing';

export interface NodeReady {
  mobilenet: boolean;
  dataset: number; // images cached locally
  tutor: string | null; // tutor model id loaded and ready
  asr?: boolean; // speech-to-text model loaded (captions)
  mt?: boolean; // English→Spanish model loaded
}

export interface NodeStatus {
  state: NodeState;
  battery: BatteryState;
  throttle: number; // 0 = full speed, higher = backing off for heat
  activeWorkers: number;
  rate: number; // items per second, last few seconds
  ready: NodeReady;
  fedPhotos: number[]; // photos per class held on this device (counts only)
}

export interface LeaseMsg {
  type: 'lease';
  leaseId: string;
  jobId: string;
  kernel: Kernel;
  params: Record<string, unknown>;
  items: number[];
  verify: boolean;
}

export type HubToNode =
  | { type: 'welcome'; nodeId: string; name: string; room: string; models: ModelInfo[]; dataset: { count: number } }
  | { type: 'error'; message: string; fatal?: boolean }
  | LeaseMsg
  | { type: 'cancel'; jobId: string }
  | { type: 'cmd'; cmd: 'stop' | 'resume' | 'prepare' | 'rename'; args?: Record<string, unknown> }
  | { type: 'lab'; lab: LabId | null; jobId: string | null; canLaunch: boolean; demo: boolean }
  | { type: 'progress'; jobId: string; title: string; unit: string; status: 'running' | 'done' | 'cancelled'; done: number; total: number; elapsed: number; rate: number; devices: number; mine: number }
  | { type: 'models'; models: ModelInfo[] }
  | { type: 'fed:round'; sessionId: string; round: number; classes: string[]; weights: string; dims: [number, number]; epochs: number; lr: number }
  | { type: 'fed:model'; sessionId: string; round: number; weights: string; dims: [number, number] }
  | { type: 'fed:reset' }
  | { type: 'clock'; id: number; hub: number }
  | WallMsg;

/** Screen Wall: what one node shows. Times are Hub clock (ms since epoch). */
export interface WallMsg {
  type: 'wall';
  scene: WallScene;
  at: number;
  /** This node's rectangle in the shared virtual canvas (CSS px), or null if not on the wall. */
  slot: { x: number; y: number; w: number; h: number } | null;
  canvas: { w: number; h: number };
  index: number;
  count: number;
  image: string | null;
  name: string;
}
export type WallScene = 'off' | 'black' | 'wake' | 'image' | 'sweep' | 'show';

export interface ScreenInfo {
  w: number; // CSS px of the visible page
  h: number;
  dpr: number;
}

export type NodeToHub =
  | { type: 'hello'; role: 'node'; room: string; nodeId?: string; name?: string; mode: 'join' | 'reborn'; caps: Capabilities; status: NodeStatus; host?: boolean }
  | { type: 'status'; status: NodeStatus }
  | { type: 'want'; pool: 'cpu' | 'llm'; slots: number; kernels: Kernel[] } // adds `slots` credits for this pool
  | { type: 'launch'; lab: LabId; options?: Record<string, unknown> } // a node may start a lab when the teacher allows it
  | { type: 'result'; leaseId: string; outputs: unknown[]; ms: number }
  | { type: 'fail'; leaseId: string; error: string }
  | { type: 'release'; leaseIds: string[] }
  | { type: 'fed:update'; sessionId: string; round: number; weights: string | null; n: number; evalCorrect: number[]; evalTotal: number[] }
  | { type: 'ping' }
  | { type: 'clock'; id: number }
  | { type: 'screen'; screen: ScreenInfo; clock: { offset: number; rtt: number } | null };

export interface ModelInfo {
  id: string;
  title: string;
  kind: 'onnx' | 'gguf' | 'hf';
  license: string;
  ready: boolean;
  progress: number; // 0..1
  sizeBytes: number;
  files: { name: string; url: string; sha256: string; size: number }[];
  error?: string;
}

export interface ClassifyOutput {
  label: number;
  score: number;
}
export interface PiOutput {
  inside: number;
  samples: number;
}
export interface SirOutput {
  beta: number;
  gamma: number;
  peak: number; // mean peak infected fraction
  attack: number; // mean final attack rate
}
export interface CaptionOutput {
  en: string;
  es: string | null;
  asrMs: number;
  mtMs: number;
}
export interface TranslateOutput {
  text: string;
  ms: number;
}
export interface TutorOutput {
  text: string;
  tokens: number;
  seconds: number;
  model: string;
}

export const FED_CLASSES = ['repairable', 'recyclable', 'battery-hazard'];
export const FEATURE_DIM = 1280;

// Float32Array <-> base64, for weights on the wire.
export function f32ToB64(a: Float32Array): string {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function b64ToF32(b: string): Float32Array {
  const s = atob(b);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

// ---------- Console ----------

export interface NodeView {
  id: string;
  name: string;
  online: boolean;
  mode: 'join' | 'reborn';
  caps: Capabilities;
  status: NodeStatus;
  leases: number;
  itemsSession: number; // since the Hub started
  itemsRun: number; // in the current run
  kernels: string[];
  connectedAt: number;
  /** The Hub computer itself, computing from a hidden node inside its own Console. */
  host: boolean;
}

export interface RunView {
  jobId: string;
  lab: LabId;
  kernel: Kernel;
  title: string;
  status: 'running' | 'done' | 'cancelled';
  total: number;
  done: number;
  failed: number;
  startedAt: number;
  finishedAt: number | null;
  elapsed: number; // seconds
  rate: number; // items per second, last few seconds
  devices: number; // devices that worked in the last few seconds
  unit: string;
  timeline: [number, number, number, number][]; // [seconds since start, items done, devices active, items/s]
  perDevice: { nodeId: string; name: string; items: number; activeSec: number }[];
  baseline: { rate: number; source: string } | null;
  speedup: { devices: number; rate: number; speedup: number | null; seconds: number }[];
  spot: { checks: number; agree: number; disagree: number; items: number; skipped: number };
  energy: { wh: number; whPer1000: number | null; devices: string[]; missing: string[] } | null;
  extra: Record<string, unknown>;
}

export interface ExperimentView {
  id: string;
  lab: LabId;
  items: number;
  order: string[]; // node names in the order they are added
  step: number;
  steps: number;
  status: 'preparing' | 'running' | 'done' | 'cancelled';
  rows: { devices: number; names: string[]; seconds: number; itemsPerSec: number; speedup: number }[];
  /** "1 device vs all": two steps, the first device alone and then every device. */
  race?: boolean;
}

export interface FedView {
  sessionId: string;
  round: number;
  roundOpen: boolean;
  auto: boolean;
  classes: string[];
  history: { round: number; perClass: (number | null)[]; overall: number | null; evalPhotos: number; trainPhotos: number; participants: number; weightBytes: number }[];
  photosOnDevices: number[];
  photosUploaded: 0; // there is no way to upload a photo: the protocol has no message for it
  weightBytesTotal: number;
}

export interface ConsoleState {
  t: number;
  room: string;
  hubName: string;
  urls: { join: string; joinHttp: string; trust: string; console: string; all: string[] };
  caFingerprint: string;
  canControl: boolean;
  /** This Console is open on the Hub computer itself (so it can host the Hub's own node). */
  isHost: boolean;
  hostCompute: { on: boolean; workers: number; maxWorkers: number; name: string };
  demo: boolean;
  studentsCanLaunch: boolean;
  models: ModelInfo[];
  nodes: NodeView[];
  /** The lab the class is on now (Teach has no job, so this can differ from run.lab). */
  lab: LabId | null;
  run: RunView | null;
  experiment: ExperimentView | null;
  fed: FedView;
  /** Use-case preset currently picked on the Console (display only). */
  usecase: string | null;
  impact: {
    devicesEver: number;
    byType: Record<string, number>;
    itemsTotal: number;
    computeHours: number;
    spotChecks: number;
    spotAgree: number;
  };
  watts: { device: string; name: string; idle_w: number | null; busy_w: number | null; note: string | null }[];
  history: { jobId: string; lab: string; title: string; total: number; seconds: number | null; devices: number; status: string; at: number }[];
  datasetCount: number;
  tutorQuestions: string[];
  wall: WallView;
  captions: CaptionsView;
  renderRace: RenderRaceView | null;
  nightShift: NightShiftView;
  fleet: FleetInputs;
}

/** Live render tiles for the Console (sent outside the state message: they are image data). */
export interface RenderHeader {
  jobId: string | null;
  width: number;
  height: number;
  spp: number;
  pw: number; // preview size
  ph: number;
  factor: number;
  count: number;
  startedAt: number;
  finishedAt: number | null;
  png: boolean;
}
export interface RenderTilesMsg {
  type: 'render-tiles';
  header: RenderHeader | null;
  tiles: { item: number; x: number; y: number; w: number; h: number; node: string; t: number; rgb: string }[];
  reset: boolean;
}

export interface WallView {
  scene: WallScene;
  at: number;
  gap: number;
  order: string[]; // node ids, left to right
  devices: { id: string; name: string; screen: ScreenInfo | null; clock: { offset: number; rtt: number } | null; online: boolean }[];
  image: string | null;
}

export interface CaptionLine {
  seq: number;
  en: string;
  es: string | null;
  node: string;
  /** Seconds from the end of this piece of speech to the caption being ready on the Hub. */
  lagSec: number;
  audioSec: number;
}
export interface CaptionsView {
  on: boolean;
  translate: boolean;
  lines: CaptionLine[];
  pending: number; // audio pieces waiting or being worked on
  lagSec: number | null; // median of the last 10 pieces (measured)
  audioSecondsHeard: number;
  audioSecondsSaved: 0; // audio is processed in memory and dropped; there is nothing that saves it
  devices: string[];
  /** Caption timings logged since the last clear (seq, seconds, latency, device; no words): /api/captions.csv. */
  timedLines: number;
}

/** The latest Swarm Render timing on 1 device and on the full swarm (from a race or speedup run): /api/render.csv. */
export interface RenderRaceView {
  experiment: string;
  rows: { devices: number; seconds: number }[];
}

export interface NightShiftView {
  queue: { id: string; lab: LabId; title: string; options: Record<string, unknown>; status: 'waiting' | 'running' | 'done' | 'cancelled'; addedAt: number; finishedAt: number | null; seconds: number | null }[];
  armed: boolean;
  /** Devices that may work now: online, charging, idle. Battery-unknown devices count only if allowed. */
  eligible: string[];
  allowUnknownBattery: boolean;
}

/** Measured inputs for the fleet calculator; null = not measured yet (show nothing). */
export interface FleetInputs {
  perDevice: { kernel: string; label: string; unit: string; rate: number; device: string; source: string }[];
  efficiency: { value: number; devices: number; source: string } | null;
  captionRtf: { value: number; device: string; source: string } | null;
}

export type ConsoleCmd =
  | { cmd: 'start'; lab: LabId; options?: Record<string, unknown> }
  | { cmd: 'cancel' }
  | { cmd: 'reset' }
  | { cmd: 'demo'; on: boolean }
  | { cmd: 'students-launch'; on: boolean }
  | { cmd: 'new-room' }
  | { cmd: 'rename'; nodeId: string; name: string }
  | { cmd: 'node'; nodeId: string | '*'; action: 'stop' | 'resume' | 'prepare'; args?: Record<string, unknown> }
  | { cmd: 'forget-offline' }
  | { cmd: 'model-download'; id: string }
  | { cmd: 'fed-round' }
  | { cmd: 'fed-auto'; on: boolean }
  | { cmd: 'fed-reset' }
  | { cmd: 'watts'; device: string; idle_w: number | null; busy_w: number | null; note?: string }
  | { cmd: 'watts-delete'; device: string }
  | { cmd: 'experiment'; lab: LabId; items: number; order: string[] }
  | { cmd: 'usecase'; id: string | null }
  | { cmd: 'experiment-cancel' }
  | { cmd: 'host-compute'; on: boolean; workers?: number }
  | { cmd: 'clear'; what: 'bench' | 'speedup' | 'history' }
  | { cmd: 'render-sync' }
  | { cmd: 'race'; lab: 'render'; first: string; options?: Record<string, unknown> }
  | { cmd: 'wall'; scene?: WallScene; order?: string[]; gap?: number }
  | { cmd: 'captions'; on: boolean; translate?: boolean }
  | { cmd: 'caption-audio'; seq: number; pcm: string; sampleRate: number; endedAt: number }
  | { cmd: 'captions-clear' }
  | { cmd: 'night'; action: 'add' | 'remove' | 'arm' | 'disarm' | 'clear-done' | 'allow-unknown'; lab?: LabId; options?: Record<string, unknown>; id?: string; on?: boolean };

export interface BenchRecord {
  nodeId?: string;
  device: string;
  caps: Capabilities;
  test: string;
  backend: string;
  threads: number;
  value: number;
  unit: string;
  detail?: string;
}
