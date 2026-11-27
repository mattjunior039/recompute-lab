// A tiny "stored" (uncompressed) ZIP writer: enough to bundle a few CSVs, a PNG and a JSON log
// into one download, with no dependencies. PNGs are already compressed, so storing costs little.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array | string;
  date?: Date;
}

function dosTime(d: Date) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** Build a ZIP archive (store method, UTF-8 names). */
export function zipStore(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const files = entries.map((e) => {
    const data = typeof e.data === 'string' ? enc.encode(e.data) : e.data;
    return { name: enc.encode(e.name), data, crc: crc32(data), ...dosTime(e.date ?? new Date()) };
  });
  const localSize = files.reduce((s, f) => s + 30 + f.name.length + f.data.length, 0);
  const centralSize = files.reduce((s, f) => s + 46 + f.name.length, 0);
  const out = new Uint8Array(localSize + centralSize + 22);
  const v = new DataView(out.buffer);
  let o = 0;
  const offsets: number[] = [];
  for (const f of files) {
    offsets.push(o);
    v.setUint32(o, 0x04034b50, true);
    v.setUint16(o + 4, 20, true); // version needed
    v.setUint16(o + 6, 0x0800, true); // UTF-8 names
    v.setUint16(o + 8, 0, true); // stored
    v.setUint16(o + 10, f.time, true);
    v.setUint16(o + 12, f.date, true);
    v.setUint32(o + 14, f.crc, true);
    v.setUint32(o + 18, f.data.length, true);
    v.setUint32(o + 22, f.data.length, true);
    v.setUint16(o + 26, f.name.length, true);
    v.setUint16(o + 28, 0, true);
    out.set(f.name, o + 30);
    out.set(f.data, o + 30 + f.name.length);
    o += 30 + f.name.length + f.data.length;
  }
  const cdStart = o;
  files.forEach((f, i) => {
    v.setUint32(o, 0x02014b50, true);
    v.setUint16(o + 4, 20, true); // made by
    v.setUint16(o + 6, 20, true); // needed
    v.setUint16(o + 8, 0x0800, true);
    v.setUint16(o + 10, 0, true);
    v.setUint16(o + 12, f.time, true);
    v.setUint16(o + 14, f.date, true);
    v.setUint32(o + 16, f.crc, true);
    v.setUint32(o + 20, f.data.length, true);
    v.setUint32(o + 24, f.data.length, true);
    v.setUint16(o + 28, f.name.length, true);
    // extra, comment, disk, internal attrs = 0
    v.setUint32(o + 38, 0, true); // external attrs
    v.setUint32(o + 42, offsets[i], true);
    out.set(f.name, o + 46);
    o += 46 + f.name.length;
  });
  v.setUint32(o, 0x06054b50, true);
  v.setUint16(o + 8, files.length, true);
  v.setUint16(o + 10, files.length, true);
  v.setUint32(o + 12, o - cdStart, true);
  v.setUint32(o + 16, cdStart, true);
  return out;
}
