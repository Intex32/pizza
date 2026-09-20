import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ROOT is derived from this file's own location, NEVER process.cwd(). Starting the server
 * from the wrong directory would otherwise create an empty database next to wherever the
 * shell happened to be, and look exactly like every order vanishing.
 */
export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // No .env is fine: the vars may come from the real environment (systemd, a shell export).
}

const portRaw = process.env.PORT ?? '3001';
export const PORT = Number(portRaw);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`FATAL: PORT is not a valid port number: ${JSON.stringify(portRaw)}`);
  process.exit(1);
}

export const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN ?? '';
/**
 * A Secure cookie over http://192.168.x.x is SILENTLY DROPPED by the browser: login would
 * return 204 and then everything 401s with no error anywhere. So Secure is opt-in, and only
 * when the operator has actually told us the origin is https.
 */
export const COOKIE_SECURE = PUBLIC_ORIGIN.startsWith('https://');

export const DATA_DIR = path.join(ROOT, 'data');
export const DB_PATH = process.env.DB_PATH ?? path.join(DATA_DIR, 'pizza.db');
export const BACKUP_DIR = path.join(DATA_DIR, 'backups');
export const DELETED_LOG = path.join(DATA_DIR, 'deleted-orders.log');
export const CLIENT_DIST = path.join(ROOT, 'client', 'dist');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });

export const CREW_PASSWORD = process.env.CREW_PASSWORD ?? '';

/**
 * Called from index.ts only - seed.ts and backup.ts touch the same database but have no
 * business demanding a crew password.
 */
export function requireCrewPassword(): string {
  if (CREW_PASSWORD.length < 8) {
    console.error('');
    console.error('FATAL: CREW_PASSWORD is missing or shorter than 8 characters.');
    console.error(`Expected it in ${path.join(ROOT, '.env')} or the environment.`);
    console.error('Copy .env.example to .env and set one, then start again.');
    console.error('');
    process.exit(1);
  }
  return CREW_PASSWORD;
}
