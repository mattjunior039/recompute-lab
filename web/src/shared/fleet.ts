// Fleet calculator: an honest projection from measured numbers only.
// projection = measured per-device rate × fleet size × measured scaling efficiency.

import type { FleetInputs } from './protocol';

/** Preset fleet sizes: one cart, and a district's retired devices. */
export const FLEET_SIZES = [30, 9483];

export interface FleetRow {
  metric: string;
  value: number;
  unit: 'images per hour' | 'seconds' | 'hours per hour';
  source: string;
}

/** Projections for n devices, or [] when there is no measured per-device speed or scaling efficiency. */
export function fleetRows(f: FleetInputs, n: number): FleetRow[] {
  if (!f.efficiency || !(n > 0)) return [];
  const scale = n * f.efficiency.value;
  const out: FleetRow[] = [];
  for (const p of f.perDevice) {
    if (p.kernel === 'classify') out.push({ metric: 'Images sorted per hour', value: p.rate * 3600 * scale, unit: 'images per hour', source: p.source });
    if (p.kernel === 'render') out.push({ metric: 'Time to render one 8K picture', value: (7680 * 4320 * 2) / (p.rate * 1e6 * scale), unit: 'seconds', source: p.source });
  }
  if (f.captionRtf) out.push({ metric: 'Hours of speech captioned per hour', value: f.captionRtf.value * scale, unit: 'hours per hour', source: f.captionRtf.source });
  return out;
}

/** CSV rows (fleet_devices, fleet_result, …) for the preset sizes plus any extra sizes. */
export function fleetCsvRows(f: FleetInputs, extra: number[] = []) {
  const sizes = [...new Set([...FLEET_SIZES, ...extra.filter((n) => Number.isInteger(n) && n >= 1 && n <= 1_000_000)])].sort((a, b) => a - b);
  return sizes.flatMap((n) =>
    fleetRows(f, n).map((r) => ({
      fleet_devices: n,
      fleet_result: Number(r.value.toPrecision(4)),
      metric: r.metric,
      unit: r.unit,
      scaling_efficiency: f.efficiency!.value,
      measured_from: r.source,
    })),
  );
}
