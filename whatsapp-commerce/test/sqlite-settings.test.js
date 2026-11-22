import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, getDb } from '../src/db.js';

test('database file: WAL, synchronous NORMAL (crash-safe, ~3× faster writes), 5 s busy timeout; FULL can be chosen', () => {
  const file = path.join(os.tmpdir(), `wc-sqlite-${process.pid}.db`);
  try {
    initDb(file);
    assert.equal(getDb().prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.equal(getDb().prepare('PRAGMA synchronous').get().synchronous, 1, 'NORMAL');
    assert.equal(getDb().prepare('PRAGMA busy_timeout').get().timeout, 5000);
    getDb().close();
    process.env.SQLITE_SYNCHRONOUS = 'full';
    initDb(file);
    assert.equal(getDb().prepare('PRAGMA synchronous').get().synchronous, 2, 'FULL');
    getDb().close();
    process.env.SQLITE_SYNCHRONOUS = 'off'; // never allowed: falls back to NORMAL
    initDb(file);
    assert.equal(getDb().prepare('PRAGMA synchronous').get().synchronous, 1);
    getDb().close();
  } finally {
    delete process.env.SQLITE_SYNCHRONOUS;
    for (const f of [file, file + '-wal', file + '-shm']) try { fs.unlinkSync(f); } catch {}
  }
});
