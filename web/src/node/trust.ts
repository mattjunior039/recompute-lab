// "Trust the Hub" page: walks a non-technical person through trusting the
// classroom certificate, so the secure (https) page and camera work.

import { h, clear } from '../shared/dom';
import { deviceType } from '../shared/device';

const app = document.getElementById('app')!;
const qs = new URLSearchParams(location.search);
const room = (qs.get('room') ?? '').replace(/\D/g, '').slice(0, 6);

interface Info {
  caFingerprint: string;
  httpsPort: number;
  httpPort: number;
  lanIp: string;
}

const STEPS: Record<string, { title: string; steps: (string | Node)[] }> = {
  chromebook: {
    title: 'Chromebook',
    steps: [
      'Tap “Download the certificate” above. It saves recompute-ca.crt to your Downloads.',
      'Open Settings → Privacy and security → Security → Manage certificates (on newer ChromeOS: “Manage device certificates”).',
      'Choose the Authorities tab, then Import. Pick recompute-ca.crt from Downloads.',
      'Tick “Trust this certificate for identifying websites”, then OK.',
      'Come back here and tap “Test the secure connection”.',
    ],
  },
  iphone: {
    title: 'iPhone / iPad',
    steps: [
      'Open this page in Safari (not Chrome) and tap “Download the certificate”. Tap Allow — you’ll see “Profile Downloaded”.',
      'Open Settings. Tap “Profile Downloaded” near the top (or General → VPN & Device Management), then Install and enter your passcode.',
      'IMPORTANT: Settings → General → About → Certificate Trust Settings → turn ON “Recompute Local CA”.',
      'Come back to Safari and tap “Test the secure connection”.',
    ],
  },
  android: {
    title: 'Android',
    steps: ['Tap “Download the certificate”.', 'Settings → Security → Encryption & credentials → Install a certificate → CA certificate → choose recompute-ca.crt.', 'Come back and tap “Test the secure connection”.'],
  },
  mac: {
    title: 'Mac',
    steps: [
      'Download the certificate and double-click it: Keychain Access opens.',
      'Find “Recompute Local CA” in the login keychain, double-click it, open Trust, set “When using this certificate” to Always Trust. Close and enter your password.',
      'Chrome and Safari now trust it. (Firefox: Settings → Privacy & Security → Certificates → View Certificates → Authorities → Import.)',
    ],
  },
  windows: {
    title: 'Windows',
    steps: [
      'Download the certificate and double-click it → Install Certificate → Current User.',
      'Choose “Place all certificates in the following store” → Browse → Trusted Root Certification Authorities → Finish → Yes.',
      'Restart the browser, come back and tap “Test the secure connection”.',
    ],
  },
};

async function main() {
  let info: Info | null = null;
  try {
    info = await (await fetch('/api/info')).json();
  } catch {}
  const host = location.hostname;
  const httpsBase = info ? `https://${host}:${info.httpsPort}` : `https://${host}:8443`;
  const httpBase = info ? `http://${host}:${info.httpPort}` : `http://${host}:8080`;
  const join = (base: string) => `${base}/join${room ? `?room=${room}` : ''}`;
  const t = deviceType();
  const key = t === 'ipad' ? 'iphone' : t === 'linux' ? 'chromebook' : t in STEPS ? t : 'chromebook';
  const result = h('div');
  const testBtn = h('button', { class: 'blue' }, 'Test the secure connection');
  testBtn.onclick = () => {
    clear(result, h('div', { class: 'banner info' }, 'Testing…'));
    const ws = new WebSocket(`wss://${host}:${info?.httpsPort ?? 8443}/ws?role=probe`);
    const timer = setTimeout(() => fail(), 5000);
    const fail = () => {
      clearTimeout(timer);
      ws.close();
      clear(result, h('div', { class: 'banner bad' }, 'Not trusted yet. Check each step again (on iPhone, step 3 is the one people miss).'));
    };
    ws.onopen = () => {
      clearTimeout(timer);
      ws.close();
      clear(result, h('div', { class: 'banner ok' }, '✓ Secure connection works! ', h('a', { href: join(httpsBase), class: 'step-btn' }, 'Continue to the lab →')));
    };
    ws.onerror = fail;
  };
  const picker = h('select', null, ...Object.entries(STEPS).map(([k, v]) => h('option', { value: k, selected: k === key }, v.title)));
  const steps = h('ol');
  const showSteps = (k: string) => clear(steps, ...STEPS[k].steps.map((s) => h('li', null, s)));
  picker.onchange = () => showSteps(picker.value);
  showSteps(key);
  clear(
    app,
    h(
      'div',
      { class: 'doc' },
      h('div', { class: 'brand' }, h('img', { src: '/static/icon.svg', alt: '' }), h('div', null, h('div', { class: 'name' }, 'Re', h('b', null, 'compute')), h('div', { class: 'tagline small' }, 'Rethink. Reuse. Recompute.'))),
      h('h1', null, 'Trust the classroom Hub (one time per device)'),
      h(
        'p',
        null,
        'The Hub makes its own security certificate, so devices need to be told to trust it once. This keeps everything on the local network — nothing goes to the internet. After this, the camera, offline saving and full speed all work.',
      ),
      h('div', { class: 'card col' }, h('a', { href: '/recompute-ca.crt', class: 'step-btn', download: 'recompute-ca.crt' }, '⬇ Download the certificate'), h('div', { class: 'small muted' }, 'Fingerprint (SHA-256) — should match the Hub window:'), h('div', { class: 'mono small', style: 'word-break:break-all' }, info?.caFingerprint ?? '…')),
      h('div', { class: 'card col' }, h('div', { class: 'row' }, h('h2', { style: 'margin:0' }, 'Steps for'), picker), steps),
      h('div', { class: 'card col' }, testBtn, result),
      h('div', { class: 'card col' }, h('h3', null, 'No time? Use basic mode'), h('p', { class: 'muted' }, 'Swarm Sort and Science Sweep work without trusting the certificate, just with no live camera and a slower tutor.'), h('a', { href: join(httpBase) }, 'Continue in basic mode (http) →')),
    ),
  );
}

void main();
