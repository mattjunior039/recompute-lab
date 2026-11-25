// Persistence in SQLite (built into Node 22.13+, so nothing to compile).
// Holds only what the lab needs: jobs, results, device nicknames, benchmark
// numbers people measured, and federated-learning round stats. No accounts, no PII.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type DB = ReturnType<typeof openDb>;

export function openDb(file: string) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, lab TEXT NOT NULL, kernel TEXT NOT NULL, params TEXT NOT NULL,
      total INTEGER NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL,
      finished_at INTEGER, summary TEXT, tag TEXT
    );
    CREATE TABLE IF NOT EXISTS results (
      job_id TEXT NOT NULL, item INTEGER NOT NULL, node_id TEXT NOT NULL, output TEXT NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY (job_id, item)
    );
    CREATE TABLE IF NOT EXISTS spot_checks (
      job_id TEXT NOT NULL, items TEXT NOT NULL, node_a TEXT NOT NULL, node_b TEXT NOT NULL, agree INTEGER NOT NULL, at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, device_type TEXT, browser TEXT, caps TEXT,
      first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, items_done INTEGER NOT NULL DEFAULT 0, busy_ms INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS watts (
      device TEXT PRIMARY KEY, idle_w REAL, busy_w REAL, note TEXT, at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bench (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, node_id TEXT, device TEXT, device_type TEXT, browser TEXT,
      cores INTEGER, memory_gb REAL, webgpu TEXT, isolated INTEGER, secure INTEGER, ua TEXT,
      test TEXT NOT NULL, backend TEXT, threads INTEGER, value REAL, unit TEXT, detail TEXT
    );
    CREATE TABLE IF NOT EXISTS speedup_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, experiment TEXT NOT NULL, at INTEGER NOT NULL, job_id TEXT, lab TEXT,
      devices INTEGER NOT NULL, device_names TEXT, items INTEGER, seconds REAL, items_per_sec REAL, speedup REAL
    );
    CREATE TABLE IF NOT EXISTS fed_rounds (
      session_id TEXT NOT NULL, round INTEGER NOT NULL, stats TEXT NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY (session_id, round)
    );
  `);

  const q = {
    kvGet: db.prepare('SELECT v FROM kv WHERE k = ?'),
    kvSet: db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
    insertJob: db.prepare('INSERT INTO jobs (id, lab, kernel, params, total, status, created_at, tag) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    finishJob: db.prepare('UPDATE jobs SET status = ?, finished_at = ?, summary = ? WHERE id = ?'),
    insertResult: db.prepare('INSERT OR IGNORE INTO results (job_id, item, node_id, output, at) VALUES (?, ?, ?, ?, ?)'),
    resultsOf: db.prepare('SELECT item, node_id, output FROM results WHERE job_id = ?'),
    runningJobs: db.prepare("SELECT * FROM jobs WHERE status = 'running' ORDER BY created_at"),
    recentJobs: db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?'),
    insertSpot: db.prepare('INSERT INTO spot_checks (job_id, items, node_a, node_b, agree, at) VALUES (?, ?, ?, ?, ?, ?)'),
    spotTotals: db.prepare('SELECT COUNT(*) AS n, SUM(agree) AS ok FROM spot_checks'),
    upsertNode: db.prepare(`INSERT INTO nodes (id, name, device_type, browser, caps, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET device_type = excluded.device_type, browser = excluded.browser, caps = excluded.caps, last_seen = excluded.last_seen`),
    nodeById: db.prepare('SELECT * FROM nodes WHERE id = ?'),
    renameNode: db.prepare('UPDATE nodes SET name = ? WHERE id = ?'),
    nodeWork: db.prepare('UPDATE nodes SET items_done = items_done + ?, busy_ms = busy_ms + ?, last_seen = ? WHERE id = ?'),
    allNodes: db.prepare('SELECT * FROM nodes ORDER BY first_seen'),
    nodeCount: db.prepare('SELECT COUNT(*) AS n FROM nodes'),
    totals: db.prepare('SELECT COALESCE(SUM(items_done),0) AS items, COALESCE(SUM(busy_ms),0) AS ms FROM nodes'),
    setWatts: db.prepare(`INSERT INTO watts (device, idle_w, busy_w, note, at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(device) DO UPDATE SET idle_w = excluded.idle_w, busy_w = excluded.busy_w, note = excluded.note, at = excluded.at`),
    delWatts: db.prepare('DELETE FROM watts WHERE device = ?'),
    allWatts: db.prepare('SELECT * FROM watts ORDER BY device'),
    insertBench: db.prepare(`INSERT INTO bench (at, node_id, device, device_type, browser, cores, memory_gb, webgpu, isolated, secure, ua, test, backend, threads, value, unit, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    allBench: db.prepare('SELECT * FROM bench ORDER BY at'),
    clearBench: db.prepare('DELETE FROM bench'),
    insertSpeedup: db.prepare(`INSERT INTO speedup_runs (experiment, at, job_id, lab, devices, device_names, items, seconds, items_per_sec, speedup)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    allSpeedup: db.prepare('SELECT * FROM speedup_runs ORDER BY at'),
    clearSpeedup: db.prepare('DELETE FROM speedup_runs'),
    clearJobs: db.prepare('DELETE FROM jobs'),
    clearResults: db.prepare('DELETE FROM results'),
    clearSpot: db.prepare('DELETE FROM spot_checks'),
    clearFed: db.prepare('DELETE FROM fed_rounds'),
    zeroNodeWork: db.prepare('UPDATE nodes SET items_done = 0, busy_ms = 0'),
    deleteNode: db.prepare('DELETE FROM nodes WHERE id = ?'),
    insertFed: db.prepare('INSERT OR REPLACE INTO fed_rounds (session_id, round, stats, at) VALUES (?, ?, ?, ?)'),
    allFed: db.prepare('SELECT * FROM fed_rounds ORDER BY at'),
  };

  return {
    raw: db,
    q,
    get(k: string): string | undefined {
      return (q.kvGet.get(k) as { v: string } | undefined)?.v;
    },
    set(k: string, v: string) {
      q.kvSet.run(k, v);
    },
    tx<T>(fn: () => T): T {
      db.exec('BEGIN');
      try {
        const r = fn();
        db.exec('COMMIT');
        return r;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    close() {
      db.close();
    },
  };
}
