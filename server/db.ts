import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, ROOT } from './config.ts';
import type { Status } from '../shared/status.ts';
import type {
  CrewState,
  CustomerOrder,
  Order,
  OvenLayer,
  PizzaType,
  Settings,
} from '../shared/types.ts';

export const db = new DatabaseSync(DB_PATH);

// --- PRAGMAs. The order is load-bearing. -----------------------------------------------
// busy_timeout FIRST: the WAL switch needs a brief exclusive lock, and a `node --watch`
// restart that overlaps the dying process is routine during development.
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA journal_mode = WAL');
// FULL, not NORMAL: a pizza oven and a Pi on one extension cord makes a power cut realistic,
// and at ~500 writes an evening the extra fsync is unmeasurable.
db.exec('PRAGMA synchronous = FULL');
// Per-connection, and OFF by default. Asserted below rather than assumed.
db.exec('PRAGMA foreign_keys = ON');

const fk = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys?: number } | undefined;
if (!fk || Number(fk.foreign_keys) !== 1) {
  console.error('FATAL: could not enable PRAGMA foreign_keys. Refusing to start.');
  process.exit(1);
}

// --- Schema drift check ----------------------------------------------------------------
// CREATE TABLE IF NOT EXISTS silently no-ops against an older table that is missing a
// column added later. Without this, the failure surfaces as a 500 on the customer order
// endpoint in the middle of service.
const EXPECTED_COLUMNS: Record<string, string[]> = {
  pizza_types: [
    'id', 'name', 'ingredients', 'bake_seconds', 'sold_out', 'archived_at', 'position',
    'created_at', 'updated_at',
  ],
  oven_layers: ['id', 'name', 'capacity', 'position', 'created_at', 'updated_at'],
  orders: [
    'id', 'public_token', 'client_request_id', 'customer_name', 'note', 'pizza_type_id',
    'pizza_type_name', 'status', 'cancelled_at', 'cancel_reason', 'remade_from', 'paid_at',
    'created_at', 'updated_at', 'queued_at', 'baking_started_at', 'bake_seconds', 'ready_at',
    'picked_up_at', 'oven_layer_id', 'oven_slot',
  ],
  sessions: ['id', 'created_at', 'last_seen_at'],
  settings: ['key', 'value'],
};

/**
 * `skipMissingTables` is what makes this runnable BEFORE the schema is applied, which it
 * must be: schema.sql now creates an index over oven_slot, so against an older database
 * `db.exec` throws "no such column" and the operator gets a stack trace instead of the
 * plain-English instructions below. Checking first means the useful message always wins.
 */
function checkSchemaDrift(skipMissingTables: boolean): void {
  for (const [table, expected] of Object.entries(EXPECTED_COLUMNS)) {
    const info = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (info.length === 0 && skipMissingTables) continue; // schema.sql is about to create it
    const actual = info.map((r) => r.name);
    const missing = expected.filter((c) => !actual.includes(c));
    const extra = actual.filter((c) => !expected.includes(c));
    if (missing.length || extra.length) {
      console.error('');
      console.error(`FATAL: table "${table}" does not match the expected schema.`);
      if (missing.length) console.error(`  missing columns:    ${missing.join(', ')}`);
      if (extra.length) console.error(`  unexpected columns: ${extra.join(', ')}`);
      console.error('');
      console.error('This database was created by an older version of the schema.');
      console.error('There is no migration framework, by design. To move forward:');
      console.error('  1. npm run backup');
      console.error(`  2. delete ${DB_PATH} (and the -wal / -shm files beside it)`);
      console.error('  3. restart, then: npm run seed');
      console.error('');
      process.exit(1);
    }
  }
}

// Before: catches an out-of-date database and explains it.
checkSchemaDrift(true);
db.exec(fs.readFileSync(path.join(ROOT, 'server', 'schema.sql'), 'utf8'));
// After: catches schema.sql and EXPECTED_COLUMNS disagreeing with each other, which is a
// developer mistake rather than an operator one - but it fails the same loud way.
checkSchemaDrift(false);

// --- Settings defaults -----------------------------------------------------------------
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('orders_open', '1')").run();

// --- Boot banner -----------------------------------------------------------------------
// The absolute path and the order count go out first so a wrong-directory start - which
// would create an empty database and look exactly like every order vanishing - is obvious.
const bootCount = (db.prepare('SELECT count(*) AS n FROM orders').get() as { n: number }).n;
console.log(`db: ${DB_PATH}`);
console.log(`db: ${bootCount} order(s) on disk`);

// --- Transactions ----------------------------------------------------------------------
/**
 * node:sqlite is synchronous over exactly one connection, so an open BEGIN IMMEDIATE is
 * GLOBAL PROCESS STATE. An `await` inside a transaction would let an unrelated request
 * commit inside it - during the admin purge that would mean destroying an order nobody
 * intended to destroy, and one that is absent from the backup. So this refuses async work
 * structurally rather than by convention.
 */
export function tx<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  let result: T;
  try {
    result = fn();
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  if (result instanceof Promise) {
    db.exec('ROLLBACK');
    throw new Error('tx() callback must be synchronous - no await inside a transaction');
  }
  db.exec('COMMIT');
  return result;
}

// --- State version (drives the polling endpoint) ---------------------------------------
// Initialised to a wall-clock timestamp so that after a restart every client holding an
// older value simply receives a full snapshot. No sequence numbers, no replay buffer, and
// therefore no "the counter reset and every tablet silently desynced" failure mode.
let stateVersion = Date.now();

export function getStateVersion(): number {
  return stateVersion;
}

export function bumpVersion(): number {
  stateVersion = Math.max(Date.now(), stateVersion + 1);
  return stateVersion;
}

export function log(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`);
}

// --- Row mapping -----------------------------------------------------------------------
type Row = Record<string, unknown>;

const n = (v: unknown): number => Number(v);
const nOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

function parseIngredients(v: unknown): string[] {
  try {
    const parsed: unknown = JSON.parse(s(v) || '[]');
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function rowToOrder(row: Row): Order {
  return {
    id: n(row.id),
    customerName: s(row.customer_name),
    note: s(row.note),
    pizzaTypeId: nOrNull(row.pizza_type_id),
    pizzaTypeName: s(row.pizza_type_name),
    status: s(row.status) as Status,
    cancelledAt: nOrNull(row.cancelled_at),
    cancelReason: s(row.cancel_reason),
    remadeFrom: nOrNull(row.remade_from),
    paidAt: nOrNull(row.paid_at),
    createdAt: n(row.created_at),
    updatedAt: n(row.updated_at),
    queuedAt: nOrNull(row.queued_at),
    bakingStartedAt: nOrNull(row.baking_started_at),
    bakeSeconds: nOrNull(row.bake_seconds),
    readyAt: nOrNull(row.ready_at),
    pickedUpAt: nOrNull(row.picked_up_at),
    ovenLayerId: nOrNull(row.oven_layer_id),
    ovenSlot: nOrNull(row.oven_slot),
  };
}

/** Only ever returned to the holder of the token itself. Crew snapshots omit the token. */
export function rowToCustomerOrder(row: Row): CustomerOrder {
  return { ...rowToOrder(row), publicToken: s(row.public_token) };
}

export function rowToPizzaType(row: Row): PizzaType {
  return {
    id: n(row.id),
    name: s(row.name),
    ingredients: parseIngredients(row.ingredients),
    bakeSeconds: n(row.bake_seconds),
    soldOut: n(row.sold_out) === 1,
    archivedAt: nOrNull(row.archived_at),
    position: n(row.position),
  };
}

export function rowToLayer(row: Row): OvenLayer {
  return {
    id: n(row.id),
    name: s(row.name),
    capacity: n(row.capacity),
    position: n(row.position),
  };
}

// --- Reads -----------------------------------------------------------------------------
export function allOrders(): Order[] {
  return (db.prepare('SELECT * FROM orders ORDER BY id').all() as Row[]).map(rowToOrder);
}

export function getOrderById(id: number): Order | undefined {
  const row = db.prepare('SELECT * FROM orders WHERE id = :id').get({ id }) as Row | undefined;
  return row ? rowToOrder(row) : undefined;
}

export function getCustomerOrderByToken(token: string): CustomerOrder | undefined {
  const row = db.prepare('SELECT * FROM orders WHERE public_token = :token').get({ token }) as
    | Row
    | undefined;
  return row ? rowToCustomerOrder(row) : undefined;
}

export function allLayers(): OvenLayer[] {
  const rows = db.prepare('SELECT * FROM oven_layers ORDER BY position, id').all() as Row[];
  return rows.map(rowToLayer);
}

export function getLayer(id: number): OvenLayer | undefined {
  const row = db.prepare('SELECT * FROM oven_layers WHERE id = :id').get({ id }) as Row | undefined;
  return row ? rowToLayer(row) : undefined;
}

export function allPizzaTypes(): PizzaType[] {
  const rows = db.prepare('SELECT * FROM pizza_types ORDER BY position, id').all() as Row[];
  return rows.map(rowToPizzaType);
}

export function getPizzaType(id: number): PizzaType | undefined {
  const row = db.prepare('SELECT * FROM pizza_types WHERE id = :id').get({ id }) as Row | undefined;
  return row ? rowToPizzaType(row) : undefined;
}

export function readSettings(): Settings {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'orders_open'").get() as
    | { value?: string }
    | undefined;
  return { ordersOpen: (row?.value ?? '1') === '1' };
}

export function writeSetting(key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (:key, :value) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run({ key, value });
}

export function orderCount(): number {
  return (db.prepare('SELECT count(*) AS n FROM orders').get() as { n: number }).n;
}

/** The single payload every crew screen renders from. */
export function buildState(): CrewState {
  return {
    version: stateVersion,
    serverNow: Date.now(),
    orders: allOrders(),
    layers: allLayers(),
    pizzaTypes: allPizzaTypes(),
    settings: readSettings(),
  };
}
