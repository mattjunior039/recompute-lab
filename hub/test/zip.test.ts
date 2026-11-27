import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { crc32, zipStore } from '../../web/src/shared/zip';

test('the Film mode zip opens with a standard unzip tool and keeps every byte', () => {
  assert.equal(crc32(new TextEncoder().encode('hello')), 0x3610a686);
  const png = new Uint8Array(70_000).map((_, i) => (i * 31) & 0xff);
  const zip = zipStore([
    { name: 'render.csv', data: 'devices,seconds\r\n1,120\r\n4,34\r\n' },
    { name: 'film-log.json', data: JSON.stringify({ flash: '2026-12-01T10:00:00.000Z' }) },
    { name: 'render.png', data: png },
  ]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-zip-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.zip'), zip);
    execFileSync('unzip', ['-q', '-o', 'a.zip', '-d', 'out'], { cwd: dir });
    assert.equal(fs.readFileSync(path.join(dir, 'out/render.csv'), 'utf8'), 'devices,seconds\r\n1,120\r\n4,34\r\n');
    assert.deepEqual(new Uint8Array(fs.readFileSync(path.join(dir, 'out/render.png'))), png);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'out/film-log.json'), 'utf8')).flash, '2026-12-01T10:00:00.000Z');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
