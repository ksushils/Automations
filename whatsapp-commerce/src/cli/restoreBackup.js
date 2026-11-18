#!/usr/bin/env node
/*
 * Open an encrypted off-server backup:  BACKUP_PASSPHRASE=... node src/cli/restoreBackup.js backup.db.enc restored.db
 * (uses ENCRYPTION_KEY if BACKUP_PASSPHRASE isn't set). The result is a normal SQLite database file: stop the app,
 * keep a copy of the current database, put the restored file in its place, start the app.
 */
import fs from 'node:fs';
import { openBackup } from '../offsite.js';

const [, , from, to] = process.argv;
if (!from || !to) { console.error('Usage: node src/cli/restoreBackup.js <backup.db.enc> <restored.db>'); process.exit(1); }
if (fs.existsSync(to)) { console.error(`${to} already exists – choose a new file name.`); process.exit(1); }
fs.writeFileSync(to, openBackup(fs.readFileSync(from)));
console.log(`Restored ${fs.statSync(to).size} bytes to ${to}`);
