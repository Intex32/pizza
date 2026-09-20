import { Router } from 'express';
import type { Request } from 'express';
import { buildState, getStateVersion } from '../db.ts';
import {
  cancelOrder,
  createLayer,
  createPizzaType,
  createWalkInOrder,
  deleteLayer,
  deletePizzaType,
  patchOrder,
  placeOrder,
  remakeOrder,
  setBakeSeconds,
  setUnpaid,
  transitionOrder,
  uncancelOrder,
  updateLayer,
  updatePizzaType,
  updateSettings,
} from '../orders.ts';
import { asObject, bad, int, nullableInt, optBool, optInt, optStr, optStrArray, oneOf, str, strArray } from '../validate.ts';
import { STATUS_ORDER } from '../../shared/status.ts';

export const crewRouter: Router = Router();

function idParam(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw bad('invalid_id', 'Bad order id.');
  return id;
}

// --- The one read every crew screen uses -------------------------------------------------
/**
 * Polling, not push. A 204 when nothing has changed makes the steady state almost free, and
 * the path that runs at 20:30 on bad wifi is the same one that ran all evening.
 */
crewRouter.get('/state', (req, res) => {
  const since = Number(req.query.since);
  if (Number.isFinite(since) && since === getStateVersion()) {
    res.status(204).end();
    return;
  }
  res.json(buildState());
});

// --- Orders -------------------------------------------------------------------------------

/** Walk-in. Inserts straight into IN_PREPARATION, already paid. Not gated by orders_open. */
crewRouter.post('/orders', (req, res) => {
  const body = asObject(req.body);
  const order = createWalkInOrder({
    customerName: str(body, 'customerName', { max: 60 }),
    pizzaTypeId: int(body, 'pizzaTypeId', { min: 1 }),
    note: optStr(body, 'note', { max: 280 }) ?? '',
  });
  res.status(201).json({ order });
});

crewRouter.post('/orders/:id/transition', (req, res) => {
  const body = asObject(req.body);
  const order = transitionOrder(
    idParam(req),
    oneOf(body, 'expected', STATUS_ORDER),
    oneOf(body, 'next', STATUS_ORDER),
  );
  res.json({ order });
});

/**
 * The only path into BAKING. A deck is a numbered row of slots and order matters, so this
 * takes a PAIR. ovenLayerId null means the Unplaced tray, where positions do not apply.
 */
crewRouter.post('/orders/:id/place', (req, res) => {
  const body = asObject(req.body);
  const order = placeOrder(
    idParam(req),
    nullableInt(body, 'ovenLayerId', { min: 1 }),
    nullableInt(body, 'ovenSlot', { min: 0, max: 11 }),
  );
  res.json({ order });
});

crewRouter.patch('/orders/:id/bake', (req, res) => {
  const body = asObject(req.body);
  const order = setBakeSeconds(idParam(req), int(body, 'bakeSeconds', { min: 1, max: 100000 }));
  res.json({ order });
});

crewRouter.patch('/orders/:id', (req, res) => {
  const body = asObject(req.body);
  const order = patchOrder(idParam(req), {
    customerName: optStr(body, 'customerName', { min: 1, max: 60 }),
    pizzaTypeId: optInt(body, 'pizzaTypeId', { min: 1 }),
    note: optStr(body, 'note', { max: 280 }),
  });
  res.json({ order });
});

crewRouter.post('/orders/:id/unpaid', (req, res) => {
  res.json({ order: setUnpaid(idParam(req)) });
});

crewRouter.post('/orders/:id/cancel', (req, res) => {
  const body = asObject(req.body ?? {});
  const reason = optStr(body, 'reason', { max: 120 }) || 'no-show';
  res.json({ order: cancelOrder(idParam(req), reason) });
});

crewRouter.post('/orders/:id/uncancel', (req, res) => {
  res.json({ order: uncancelOrder(idParam(req)) });
});

crewRouter.post('/orders/:id/remake', (req, res) => {
  const { original, clone } = remakeOrder(idParam(req));
  res.status(201).json({ original, clone });
});

// --- Oven layers ---------------------------------------------------------------------------

crewRouter.post('/layers', (req, res) => {
  const body = asObject(req.body);
  const layer = createLayer(
    str(body, 'name', { max: 40 }),
    optInt(body, 'capacity', { min: 1, max: 12 }) ?? 4,
  );
  res.status(201).json({ layer });
});

crewRouter.patch('/layers/:id', (req, res) => {
  const body = asObject(req.body);
  // `evicted` counts pizzas that were sitting in slots the deck no longer has, so the UI
  // can say where they went instead of letting them appear to vanish.
  const { layer, evicted } = updateLayer(idParam(req), {
    name: optStr(body, 'name', { min: 1, max: 40 }),
    capacity: optInt(body, 'capacity', { min: 1, max: 12 }),
    position: optInt(body, 'position', { min: 0, max: 999 }),
  });
  res.json({ layer, evicted });
});

/**
 * The rehoming heuristic lives here: the crew member deleting the deck names the
 * destination, because they are the only person who knows where those pizzas physically
 * went. They fill the destination's free slots in order; the rest go to Unplaced. Timers
 * keep running throughout.
 */
crewRouter.delete('/layers/:id', (req, res) => {
  const raw = String(req.query.moveTo ?? 'unplaced');
  let moveTo: number | null = null;
  if (raw !== 'unplaced') {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) throw bad('invalid_destination', 'Bad moveTo value.');
    moveTo = n;
  }
  res.json(deleteLayer(idParam(req), moveTo));
});

// --- Pizza types (the menu) -----------------------------------------------------------------

crewRouter.post('/pizza-types', (req, res) => {
  const body = asObject(req.body);
  const pizzaType = createPizzaType({
    name: str(body, 'name', { max: 60 }),
    ingredients: strArray(body, 'ingredients'),
    bakeSeconds: optInt(body, 'bakeSeconds', { min: 1, max: 100000 }) ?? 300,
  });
  res.status(201).json({ pizzaType });
});

crewRouter.patch('/pizza-types/:id', (req, res) => {
  const body = asObject(req.body);
  const pizzaType = updatePizzaType(idParam(req), {
    name: optStr(body, 'name', { min: 1, max: 60 }),
    ingredients: optStrArray(body, 'ingredients'),
    bakeSeconds: optInt(body, 'bakeSeconds', { min: 1, max: 100000 }),
    soldOut: optBool(body, 'soldOut'),
    position: optInt(body, 'position', { min: 0, max: 999 }),
    archived: optBool(body, 'archived'),
  });
  res.json({ pizzaType });
});

/** Refuses while any order references it, and says to retire it instead. */
crewRouter.delete('/pizza-types/:id', (req, res) => {
  deletePizzaType(idParam(req));
  res.status(204).end();
});

// --- Settings ---------------------------------------------------------------------------------

crewRouter.patch('/settings', (req, res) => {
  const body = asObject(req.body);
  updateSettings({ ordersOpen: optBool(body, 'ordersOpen') });
  res.json({ ok: true });
});
