import fs from 'node:fs';
import path from 'node:path';
import { backup } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { BACKUP_DIR, DELETED_LOG } from './config.ts';
import { db, log } from './db.ts';

/**
 * Uses SQLite's ONLINE backup, never a file copy. With WAL enabled the most recent orders
 * live in pizza.db-wal, so copying the main file alone would silently lose them - which
 * would quietly violate the one hard constraint this app has.
 */
export async function runBackup(): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
  const name = `pizza-${stamp}.db`;
  await backup(db, path.join(BACKUP_DIR, name));
  log(`BACKUP ${name}`);
  return name;
}

export type BackupFile = { name: string; size: number; mtime: number };

export function listBackups(): BackupFile[] {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith('.db'))
    .map((name) => {
      const stat = fs.statSync(path.join(BACKUP_DIR, name));
      return { name, size: stat.size, mtime: stat.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

/**
 * Append-only record of everything ever deleted, as raw JSON rows.
 *
 * Synchronous and deliberately NOT wrapped in a try/catch: it runs inside the delete
 * transaction, so a full disk must ABORT the delete rather than lose the record.
 */
export function appendDeletedOrdersSync(rows: unknown[]): void {
  if (rows.length === 0) return;
  const at = Date.now();
  const text = `${rows.map((order) => JSON.stringify({ deletedAt: at, order })).join('\n')}\n`;
  fs.appendFileSync(DELETED_LOG, text, 'utf8');
}

// --- CLI: npm run backup ----------------------------------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const name = await runBackup();
  console.log(`backup: wrote ${path.join(BACKUP_DIR, name)}`);
}
