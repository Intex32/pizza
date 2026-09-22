/** Every error thrown out of a route ends up here and is rendered as JSON by index.ts. */
export class ApiError extends Error {
  status: number;
  code: string;
  details: unknown;

  constructor(status: number, code: string, message?: string, details?: unknown) {
    super(message ?? code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function bad(code: string, message?: string, details?: unknown): ApiError {
  return new ApiError(400, code, message, details);
}
export function conflict(code: string, message?: string, details?: unknown): ApiError {
  return new ApiError(409, code, message, details);
}
export function notFound(code = 'not_found', message?: string): ApiError {
  return new ApiError(404, code, message);
}

export function asObject(v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw bad('invalid_body', 'Expected a JSON object');
  }
  return v as Record<string, unknown>;
}

type StrOpts = { min?: number; max?: number; trim?: boolean };

export function str(o: Record<string, unknown>, key: string, opts: StrOpts = {}): string {
  const { min = 1, max = 255, trim = true } = opts;
  const raw = o[key];
  if (typeof raw !== 'string') throw bad('invalid_field', `${key} must be a string`);
  const v = trim ? raw.trim() : raw;
  if (v.length < min) throw bad('invalid_field', `${key} must not be empty`);
  if (v.length > max) throw bad('invalid_field', `${key} must be at most ${max} characters`);
  return v;
}

export function optStr(
  o: Record<string, unknown>,
  key: string,
  opts: StrOpts = {},
): string | undefined {
  if (o[key] === undefined || o[key] === null) return undefined;
  return str(o, key, { ...opts, min: 0 });
}

export function int(
  o: Record<string, unknown>,
  key: string,
  opts: { min?: number; max?: number } = {},
): number {
  const { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = opts;
  const raw = o[key];
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    throw bad('invalid_field', `${key} must be a whole number`);
  }
  if (raw < min || raw > max) {
    throw bad('invalid_field', `${key} must be between ${min} and ${max}`);
  }
  return raw;
}

export function optInt(
  o: Record<string, unknown>,
  key: string,
  opts: { min?: number; max?: number } = {},
): number | undefined {
  if (o[key] === undefined) return undefined;
  return int(o, key, opts);
}

/** For fields that are meaningfully null, like ovenLayerId (null === the Unplaced tray). */
export function nullableInt(
  o: Record<string, unknown>,
  key: string,
  opts: { min?: number; max?: number } = {},
): number | null {
  if (o[key] === null || o[key] === undefined) return null;
  return int(o, key, opts);
}

export function optBool(o: Record<string, unknown>, key: string): boolean | undefined {
  if (o[key] === undefined) return undefined;
  if (typeof o[key] !== 'boolean') throw bad('invalid_field', `${key} must be true or false`);
  return o[key];
}

export function oneOf<T extends string>(
  o: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T {
  const raw = o[key];
  if (typeof raw !== 'string' || !(allowed as readonly string[]).includes(raw)) {
    throw bad('invalid_field', `${key} must be one of: ${allowed.join(', ')}`);
  }
  return raw as T;
}

export function strArray(
  o: Record<string, unknown>,
  key: string,
  opts: { maxItems?: number; maxLen?: number } = {},
): string[] {
  const { maxItems = 50, maxLen = 60 } = opts;
  const raw = o[key];
  if (!Array.isArray(raw)) throw bad('invalid_field', `${key} must be an array`);
  if (raw.length > maxItems) throw bad('invalid_field', `${key} may hold at most ${maxItems} items`);
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') throw bad('invalid_field', `${key} must contain only strings`);
    const v = item.trim();
    if (!v) continue;
    if (v.length > maxLen) throw bad('invalid_field', `each ${key} entry must be <= ${maxLen} chars`);
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

export function optStrArray(
  o: Record<string, unknown>,
  key: string,
  opts: { maxItems?: number; maxLen?: number } = {},
): string[] | undefined {
  if (o[key] === undefined) return undefined;
  return strArray(o, key, opts);
}

/**
 * An emoji field. Length is measured in CODE POINTS, not UTF-16 units, because a single
 * emoji like 👨‍🍳 is three code points and five units - a naive .length check would reject
 * perfectly ordinary input.
 */
export function optEmoji(o: Record<string, unknown>, key: string): string | undefined {
  if (o[key] === undefined || o[key] === null) return undefined;
  const raw = o[key];
  if (typeof raw !== 'string') throw bad('invalid_field', `${key} must be a string`);
  const v = raw.trim();
  if (v === '') return undefined;
  if ([...v].length > 16) throw bad('invalid_field', 'Use a single emoji');
  return v;
}

/** Clamp is deliberate: the CHECK constraint stays a backstop, never the user-facing validator. */
export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
