import os from 'node:os';
import { execFileSync } from 'node:child_process';

export interface LanAddress {
  iface: string;
  address: string;
}

/** IPv4 addresses other devices on the Wi-Fi can reach. Best guess first. */
export function lanAddresses(): LanAddress[] {
  const out: LanAddress[] = [];
  for (const [iface, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (a.address.startsWith('169.254.')) continue; // link-local: no router
      out.push({ iface, address: a.address });
    }
  }
  const score = (a: LanAddress) => {
    let s = 0;
    if (/^(en|eth|wlan|wl|Wi-?Fi)/i.test(a.iface)) s -= 10;
    if (/^(utun|bridge|vmnet|vboxnet|docker|awdl|llw|tailscale|zt)/i.test(a.iface)) s += 20;
    if (a.address.startsWith('192.168.')) s -= 3;
    else if (a.address.startsWith('10.')) s -= 2;
    else if (/^172\.(1[6-9]|2\d|3[01])\./.test(a.address)) s -= 1;
    return s;
  };
  return out.sort((a, b) => score(a) - score(b));
}

export function hostName() {
  return os.hostname().replace(/\.local$/i, '');
}

const MAC_MODELS: [RegExp, string][] = [
  [/^iMac20,/, 'iMac 2020'],
  [/^iMac19,/, 'iMac 2019'],
  [/^iMac18,/, 'iMac 2017'],
  [/^iMac17,/, 'iMac 2015'],
  [/^iMac16,/, 'iMac 2015'],
  [/^iMac15,|^iMac14,/, 'iMac 2014'],
  [/^iMacPro1,/, 'iMac Pro 2017'],
  [/^iMac21,/, 'iMac 2021'],
  [/^MacBookPro16,/, 'MacBook Pro 2019'],
  [/^MacBookPro15,/, 'MacBook Pro 2018'],
  [/^MacBookAir9,/, 'MacBook Air 2020'],
  [/^MacBookAir8,/, 'MacBook Air 2018'],
  [/^Macmini8,/, 'Mac mini 2018'],
  [/^iMac/, 'iMac'],
  [/^MacBookPro/, 'MacBook Pro'],
  [/^MacBookAir/, 'MacBook Air'],
  [/^Macmini/, 'Mac mini'],
];

/** A friendly name for the Hub computer's own node tile, e.g. "iMac 2020 (Hub)". */
export function machineName(): string {
  const override = process.env.RECOMPUTE_HOST_NAME?.trim();
  if (override) return override.slice(0, 40);
  if (process.platform === 'darwin') {
    let model = '';
    try {
      model = execFileSync('sysctl', ['-n', 'hw.model'], { encoding: 'utf8', timeout: 2000 }).trim();
    } catch {}
    const hit = MAC_MODELS.find(([re]) => re.test(model));
    return `${hit ? hit[1] : 'This Mac'} (Hub)`;
  }
  if (process.platform === 'win32') return 'This PC (Hub)';
  return 'This computer (Hub)';
}
