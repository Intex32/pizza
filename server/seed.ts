import { randomBytes } from 'node:crypto';
import { allLayers, allPizzaTypes, db, orderCount, tx } from './db.ts';
import { STATUS } from '../shared/status.ts';

const args = new Set(process.argv.slice(2));
const wantOrders = args.has('--orders');
const force = args.has('--force');

const now = Date.now();
const token = (): string => randomBytes(16).toString('base64url');

// --- Starter menu ----------------------------------------------------------------------
// Only if the table is empty: this script is safe to run against the real database, and
// the menu is meant to be edited from /crew/menu afterwards, not here.
const STARTER_MENU = [
  { name: 'Margherita', ingredients: ['tomato sauce', 'mozzarella', 'basil'], bakeSeconds: 300 },
  { name: 'Salami', ingredients: ['tomato sauce', 'mozzarella', 'salami'], bakeSeconds: 300 },
  { name: 'Funghi', ingredients: ['tomato sauce', 'mozzarella', 'mushrooms'], bakeSeconds: 330 },
  { name: 'Diavola', ingredients: ['tomato sauce', 'mozzarella', 'spicy salami', 'chilli'], bakeSeconds: 300 },
  { name: 'Quattro Formaggi', ingredients: ['mozzarella', 'gorgonzola', 'parmesan', 'pecorino'], bakeSeconds: 270 },
];

if (allPizzaTypes().length === 0) {
  tx(() => {
    const ins = db.prepare(
      'INSERT INTO pizza_types (name, ingredients, bake_seconds, position, created_at, updated_at) ' +
        'VALUES (:name, :ingredients, :bakeSeconds, :position, :now, :now)',
    );
    STARTER_MENU.forEach((t, i) => {
      ins.run({
        name: t.name,
        ingredients: JSON.stringify(t.ingredients),
        bakeSeconds: t.bakeSeconds,
        position: i,
        now,
      });
    });
  });
  console.log(`seed: inserted ${STARTER_MENU.length} pizza types`);
} else {
  console.log('seed: pizza types already present, left alone');
}

// --- Oven layers -----------------------------------------------------------------------
if (allLayers().length === 0) {
  tx(() => {
    const ins = db.prepare(
      'INSERT INTO oven_layers (name, capacity, position, created_at, updated_at) ' +
        'VALUES (:name, :capacity, :position, :now, :now)',
    );
    ins.run({ name: 'Deck 1', capacity: 4, position: 0, now });
    ins.run({ name: 'Deck 2', capacity: 4, position: 1, now });
  });
  console.log('seed: inserted 2 oven layers');
} else {
  console.log('seed: oven layers already present, left alone');
}

// --- Fake orders (opt-in) --------------------------------------------------------------
if (!wantOrders) {
  console.log('seed: done. Pass --orders --force to add test orders across every status.');
  process.exit(0);
}

// This guard is deliberately NOT conditioned on NODE_ENV: a manual shell on the Pi has no
// NODE_ENV set, which is precisely where destroying a real evening's orders would hurt.
if (orderCount() > 0) {
  console.error(`seed: refusing to add test orders - ${orderCount()} order(s) already exist.`);
  console.error('seed: wipe them from the admin screen first if this is really what you want.');
  process.exit(1);
}
if (!force) {
  console.error('seed: --orders also requires --force. Nothing was written.');
  process.exit(1);
}

const types = allPizzaTypes();
const layers = allLayers();
const pick = (i: number) => types[i % types.length];

type Fake = {
  name: string;
  typeIndex: number;
  status: string;
  note?: string;
  paid?: boolean;
  /** seconds of bake already elapsed - negative values are not allowed */
  bakedForS?: number;
  layerIndex?: number | null;
  slot?: number;
  cancelled?: string;
};

const FAKES: Fake[] = [
  { name: 'Anna Berger', typeIndex: 0, status: STATUS.ORDERED },
  { name: 'Anna Schmidt', typeIndex: 3, status: STATUS.ORDERED, note: 'no chilli please' },
  { name: 'Tomás Řezník', typeIndex: 1, status: STATUS.ORDERED },
  { name: 'Bea Lindqvist', typeIndex: 2, status: STATUS.IN_PREPARATION, paid: true, note: 'mushroom allergy - extra careful' },
  { name: 'Chris Okafor', typeIndex: 4, status: STATUS.WAITING_FOR_OVEN, paid: true },
  { name: 'Dana Ivanova', typeIndex: 0, status: STATUS.WAITING_FOR_OVEN, paid: true },
  // one about to expire, one already overdue - these are what the oven screen is for
  { name: 'Eli Tanaka', typeIndex: 1, status: STATUS.BAKING, paid: true, bakedForS: 270, layerIndex: 0, slot: 0 },
  { name: 'Fran Mbeki', typeIndex: 3, status: STATUS.BAKING, paid: true, bakedForS: 420, layerIndex: 0, slot: 2 },
  // one baking with no recorded position, to exercise the Unplaced tray
  { name: 'Gio Rossi', typeIndex: 2, status: STATUS.BAKING, paid: true, bakedForS: 60, layerIndex: null },
  // a second deck in use, so the seeded board exercises more than one row of slots
  { name: 'Kai Lindholm', typeIndex: 0, status: STATUS.BAKING, paid: true, bakedForS: 150, layerIndex: 1, slot: 1 },
  { name: 'Hana Novak', typeIndex: 0, status: STATUS.READY, paid: true },
  { name: 'Ivo Petrov', typeIndex: 4, status: STATUS.PICKED_UP, paid: true },
  { name: 'Jo Müller', typeIndex: 1, status: STATUS.ORDERED, cancelled: 'no-show' },
];

tx(() => {
  const ins = db.prepare(`
    INSERT INTO orders (
      public_token, client_request_id, customer_name, note, pizza_type_id, pizza_type_name,
      status, cancelled_at, cancel_reason, paid_at, created_at, updated_at, queued_at,
      baking_started_at, bake_seconds, ready_at, picked_up_at, oven_layer_id, oven_slot
    ) VALUES (
      :token, :requestId, :name, :note, :typeId, :typeName,
      :status, :cancelledAt, :cancelReason, :paidAt, :createdAt, :updatedAt, :queuedAt,
      :bakingStartedAt, :bakeSeconds, :readyAt, :pickedUpAt, :ovenLayerId, :ovenSlot
    )
  `);

  FAKES.forEach((f, i) => {
    const type = pick(f.typeIndex);
    const createdAt = now - (FAKES.length - i) * 60_000;
    const baking = f.status === STATUS.BAKING;
    const layerId =
      baking && f.layerIndex !== null && f.layerIndex !== undefined
        ? (layers[f.layerIndex]?.id ?? null)
        : null;

    ins.run({
      token: token(),
      requestId: null,
      name: f.name,
      note: f.note ?? '',
      typeId: type.id,
      typeName: type.name,
      status: f.status,
      cancelledAt: f.cancelled ? now : null,
      cancelReason: f.cancelled ?? '',
      paidAt: f.paid ? createdAt + 30_000 : null,
      createdAt,
      updatedAt: now,
      queuedAt: [STATUS.WAITING_FOR_OVEN].includes(f.status as never) ? now - 200_000 : null,
      bakingStartedAt: baking ? now - (f.bakedForS ?? 0) * 1000 : null,
      bakeSeconds: baking ? type.bakeSeconds : null,
      readyAt: f.status === STATUS.READY || f.status === STATUS.PICKED_UP ? now - 300_000 : null,
      pickedUpAt: f.status === STATUS.PICKED_UP ? now - 60_000 : null,
      ovenLayerId: layerId,
      ovenSlot: layerId === null ? null : (f.slot ?? 0),
    });
  });
});

console.log(`seed: inserted ${FAKES.length} test orders across every status`);
console.log('seed: one baking pizza expires in ~30s, one is already overdue');
