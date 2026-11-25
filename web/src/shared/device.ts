// What is this device? Only coarse facts the scheduler needs; nothing identifying.

import type { Capabilities, DeviceType } from './protocol';

export function deviceType(ua = navigator.userAgent): DeviceType {
  if (/CrOS/.test(ua)) return 'chromebook';
  if (/iPhone|iPod/.test(ua)) return 'iphone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ipad';
  if (/Android/.test(ua)) return 'android';
  if (/Macintosh|Mac OS X/.test(ua)) return 'mac';
  if (/Windows/.test(ua)) return 'windows';
  if (/Linux|X11/.test(ua)) return 'linux';
  return 'other';
}

export function browserName(ua = navigator.userAgent) {
  let m: RegExpMatchArray | null;
  if ((m = ua.match(/Edg\/(\d+)/))) return `Edge ${m[1]}`;
  if ((m = ua.match(/(?:Chrome|CriOS)\/(\d+)/))) return `Chrome ${m[1]}`;
  if ((m = ua.match(/(?:Firefox|FxiOS)\/(\d+)/))) return `Firefox ${m[1]}`;
  if ((m = ua.match(/Version\/([\d.]+).*Safari/))) return `Safari ${m[1]}`;
  if (/AppleWebKit/.test(ua)) return 'Safari';
  return 'Browser';
}

export function isMobile(t = deviceType()) {
  return t === 'iphone' || t === 'ipad' || t === 'android';
}

/** Worker count: leave one core for the device itself (cores − 1); phones are capped at 2 to stay cool. */
export function defaultWorkers(cores = navigator.hardwareConcurrency || 2, t = deviceType()) {
  const n = Math.max(1, cores - 1);
  return isMobile(t) ? Math.min(2, n) : n;
}

export async function webgpuAdapter(): Promise<string | null> {
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return null;
  try {
    const a = (await gpu.requestAdapter()) as { info?: { vendor?: string; architecture?: string; description?: string } } | null;
    if (!a) return null;
    const i = a.info ?? {};
    return [i.vendor, i.architecture, i.description].filter(Boolean).join(' ') || 'available';
  } catch {
    return null;
  }
}

export async function probeCaps(workers: number): Promise<Capabilities> {
  const ua = navigator.userAgent;
  return {
    cores: navigator.hardwareConcurrency || 1,
    workers,
    memoryGB: (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? null,
    webgpu: await webgpuAdapter(),
    isolated: !!globalThis.crossOriginIsolated,
    secure: !!globalThis.isSecureContext,
    ua,
    deviceType: deviceType(ua),
    browser: browserName(ua),
  };
}
