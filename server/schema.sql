-- Executed verbatim at every boot. CREATE TABLE IF NOT EXISTS silently no-ops on an
-- ADDED COLUMN, so db.ts runs a column-set drift check right after this and refuses to
-- start on a mismatch. Schema changes between events are: backup, delete data/pizza.db*,
-- restart, re-seed.

CREATE TABLE IF NOT EXISTS pizza_types (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 60),
  ingredients  TEXT    NOT NULL DEFAULT '[]',   -- JSON array of strings
  bake_seconds INTEGER NOT NULL DEFAULT 300 CHECK (bake_seconds BETWEEN 30 AND 3600),
  sold_out     INTEGER NOT NULL DEFAULT 0 CHECK (sold_out IN (0,1)),
  archived_at  INTEGER,          -- retired: hidden from the order form, placed orders unaffected
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS oven_layers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 40),
  capacity   INTEGER NOT NULL DEFAULT 4 CHECK (capacity BETWEEN 1 AND 12),
  position   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS orders (
  -- AUTOINCREMENT is load-bearing: a plain INTEGER PRIMARY KEY is a reusable rowid
  -- (1,2,3 -> delete 3 -> the next insert is 3 again). The id is BOTH the number shouted
  -- across the room AND the key every crew mutation targets, so reuse is not acceptable.
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  public_token      TEXT    NOT NULL UNIQUE,   -- 16 random bytes b64url; the ONLY thing a
                                               --   customer's browser ever stores
  client_request_id TEXT    UNIQUE,            -- idempotency for a double-tapped Submit
  customer_name     TEXT    NOT NULL CHECK (length(trim(customer_name)) BETWEEN 1 AND 60),
  note              TEXT    NOT NULL DEFAULT '' CHECK (length(note) <= 280),

  pizza_type_id     INTEGER REFERENCES pizza_types(id) ON DELETE SET NULL,
  pizza_type_name   TEXT    NOT NULL,          -- SNAPSHOT at submit: every screen renders
                                               --   THIS, so renaming or retiring a type never
                                               --   rewrites an order that was already placed

  status            TEXT    NOT NULL DEFAULT 'ORDERED' CHECK (status IN
                      ('ORDERED','IN_PREPARATION','WAITING_FOR_OVEN','BAKING','READY','PICKED_UP')),

  cancelled_at      INTEGER,                   -- no-show / customer cancel / remade. A FLAG.
  cancel_reason     TEXT    NOT NULL DEFAULT '' CHECK (length(cancel_reason) <= 120),
  remade_from       INTEGER,                   -- deliberately NOT a foreign key: nothing may
                                               --   ever couple one order's lifetime to another's
  paid_at           INTEGER,                   -- NULL => unpaid
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  queued_at         INTEGER,                   -- powers "waiting 3:40" on the queue screen
  baking_started_at INTEGER,                   -- THE bake-timer anchor
  bake_seconds      INTEGER CHECK (bake_seconds IS NULL OR bake_seconds BETWEEN 30 AND 3600),
  ready_at          INTEGER,
  picked_up_at      INTEGER,
  oven_layer_id     INTEGER REFERENCES oven_layers(id) ON DELETE SET NULL,

  -- A BAKING row must always be able to render a timer; a NULL bake_seconds would render
  -- NaN:NaN, never blink, and burn the pizza silently.
  CHECK (status <> 'BAKING' OR (baking_started_at IS NOT NULL AND bake_seconds IS NOT NULL)),
  -- The oven slot frees itself when the pizza leaves the oven. This REQUIRES that status and
  -- placement always change in the SAME UPDATE. Every statement in orders.ts does.
  CHECK (oven_layer_id IS NULL OR status = 'BAKING')
) STRICT;

CREATE INDEX IF NOT EXISTS idx_orders_status  ON orders(status, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT    PRIMARY KEY,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
