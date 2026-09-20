import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { COOKIE_SECURE, CREW_PASSWORD, PUBLIC_ORIGIN } from './config.ts';
import { db } from './db.ts';
import { ApiError } from './validate.ts';

export const COOKIE_NAME = 'pizza_crew';
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/** Hashing both sides first gives fixed 32-byte inputs, so the compare can never throw on a
 *  length mismatch - which would itself be a timing signal. */
function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function passwordMatches(candidate: string): boolean {
  return timingSafeEqual(sha256(candidate), sha256(CREW_PASSWORD));
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function createSession(): string {
  const id = randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare(
    'INSERT INTO sessions (id, created_at, last_seen_at) VALUES (:id, :now, :now)',
  ).run({ id, now });
  return id;
}

export function destroySession(id: string): void {
  db.prepare('DELETE FROM sessions WHERE id = :id').run({ id });
  lastTouched.delete(id);
}

function sessionExists(id: string): boolean {
  const row = db.prepare('SELECT id FROM sessions WHERE id = :id').get({ id });
  return Boolean(row);
}

export function setSessionCookie(res: Response, id: string): void {
  res.cookie(COOKIE_NAME, id, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: ONE_YEAR_MS, // a wall tablet must never log itself out mid-event
    // A Secure cookie over http://192.168.x.x is SILENTLY DROPPED: login would return 204
    // and then everything 401s with no error anywhere. Opt-in, and only when the operator
    // has told us the origin is actually https.
    secure: COOKIE_SECURE,
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, { path: '/', sameSite: 'lax', secure: COOKIE_SECURE });
}

export function isAuthenticated(req: Request): boolean {
  const id = readCookie(req, COOKIE_NAME);
  return Boolean(id && sessionExists(id));
}

/**
 * last_seen_at is throttled in memory, and that throttle is load-bearing.
 *
 * This runs on the hottest path in the app: every crew screen polls once a second, so an
 * unconditional UPDATE here is one fsync'd page write per tablet per second - measured at
 * ~4KB a request, or roughly 144,000 writes and half a gigabyte across one evening with
 * eight tablets, none of which carry any information. On a Raspberry Pi that is SD card
 * wear for nothing. Once a minute is plenty for a field nothing renders.
 */
const TOUCH_INTERVAL_MS = 60_000;
const lastTouched = new Map<string, number>();

/** One line of wiring protects a whole router, so a new crew route is protected by default. */
export function requireCrew(req: Request, _res: Response, next: NextFunction): void {
  const id = readCookie(req, COOKIE_NAME);
  if (!id || !sessionExists(id)) {
    next(new ApiError(401, 'unauthorized', 'Crew login required.'));
    return;
  }
  const now = Date.now();
  if (now - (lastTouched.get(id) ?? 0) >= TOUCH_INTERVAL_MS) {
    lastTouched.set(id, now);
    db.prepare('UPDATE sessions SET last_seen_at = :now WHERE id = :id').run({ id, now });
  }
  next();
}

/**
 * CSRF guard. SameSite=Lax already blocks cross-site POSTs from a plain form navigation;
 * this closes the rest by rejecting any mutating request whose browser-sent Origin does not
 * match the host it arrived on.
 */
export function sameOriginOnly(req: Request, _res: Response, next: NextFunction): void {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    next();
    return;
  }
  const origin = req.get('origin');
  // Absent Origin means a non-browser client (curl, a script). Browsers always send it on
  // fetch(), including same-origin, so this is not a hole a page can walk through.
  if (!origin) {
    next();
    return;
  }
  let originHost = '';
  try {
    originHost = new URL(origin).host;
  } catch {
    next(new ApiError(403, 'bad_origin', 'Malformed Origin header.'));
    return;
  }
  if (originHost === req.headers.host || (PUBLIC_ORIGIN && origin === PUBLIC_ORIGIN)) {
    next();
    return;
  }
  next(new ApiError(403, 'cross_origin', 'Cross-origin write rejected.'));
}

// --- Login throttle --------------------------------------------------------------------
// Deliberately a delay and NOT a lockout: with one shared password, a lockout locks out the
// entire crew in the middle of service, which is a worse outcome than a slow guesser on a
// LAN. Resets on success.
const failures = new Map<string, number>();

export function loginDelayMs(ip: string): number {
  return Math.min(250 * (failures.get(ip) ?? 0), 3000);
}

export function noteLoginFailure(ip: string): void {
  failures.set(ip, (failures.get(ip) ?? 0) + 1);
}

export function noteLoginSuccess(ip: string): void {
  failures.delete(ip);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
