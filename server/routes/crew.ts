import { Router } from 'express';
import type { Request } from 'express';
import { buildState, findOrdersByPickupCode, getOrderByToken, getStateVersion } from '../db.ts';
import {
  cancelOrder,
  createLayer,
  createPizzaType,
  createWalkInOrder,
  deleteLayer,
  deletePizzaType,
  patchOrder,
  placeOrder,
  requestPayment,
  readyOrder,
  requeueOrder,
  remakeOrder,
  setBakeSeconds,
  setUnpaid,
  transitionOrder,
  uncancelOrder,
  updateLayer,
  updatePizzaType,
  updateSettings,
} from '../orders.ts';
import {
  asObject,
  bad,
  conflict,
  int,
  notFound,
  nullableInt,
  oneOf,
  optBool,
  optEmoji,
  optInt,
  optPayLink,
  optStr,
  optStrArray,
  str,
  strArray,
} from '../validate.ts';
import { STATUS_ORDER } from '../../shared/status.ts';
import { looksLikePickupCode, normalizePickupCode } from '../../shared/pickupCode.ts';
import { PAYMENT_METHODS } from '../../shared/payment.ts';
import type { PaymentMethod } from '../../shared/payment.ts';

/** Optional on a transition: only the ORDERED -> IN_PREPARATION step carries one. */
function optPayment(body: Record<string, unknown>): PaymentMethod | null {
  if (body.paymentMethod === undefined || body.paymentMethod === null) return null;
  return oneOf(body, 'paymentMethod', PAYMENT_METHODS);
}

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

// --- Finding an order from a ticket ------------------------------------------------------

/**
 * Resolve a scanned QR (a public token) or a typed pickup code to an order, so a crew screen
 * can jump to it.
 *
 * This is a READ. It never transitions anything and never bumps the state version - finding
 * a pizza must not be able to move one. The caller navigates; the crew still taps the button.
 *
 * POST, not GET, for the same reason /api/orders/lookup is a POST: a capability token must
 * never land in a URL or a server log. index.ts's redactUrl only covers ^/api/orders/..., and
 * keeping the token in the BODY means that regex never has to grow to cover this route.
 */
crewRouter.post('/resolve', (req, res) => {
  const body = asObject(req.body);
  const token = optStr(body, 'token', { max: 64 });
  const rawCode = optStr(body, 'code', { max: 16 });

  // Exactly one. Accepting both would make the precedence a silent implementation detail.
  if ((token === undefined) === (rawCode === undefined)) {
    throw bad('invalid_body', 'Send exactly one of token or code.');
  }

  if (token !== undefined) {
    const order = getOrderByToken(token);
    if (!order) throw notFound('order_not_found', 'That ticket does not match any order.');
    res.json({ order, serverNow: Date.now() });
    return;
  }

  const code = normalizePickupCode(rawCode ?? '');
  if (!looksLikePickupCode(code)) {
    throw bad('invalid_code', 'A pickup code is 5 characters. There is no O, I, 0 or 1 in one.');
  }

  const { orders } = findOrdersByPickupCode(code);
  if (orders.length === 0) throw notFound('order_not_found', `No order matches ${code}.`);

  // A 5-char code collides about once in 6,800 evenings, and the live-first search in
  // findOrdersByPickupCode makes that rarer still - but the widened search can legitimately
  // return two old rows, and picking one at random is exactly the "it found the wrong Anna"
  // failure this feature exists to prevent. Hand both back and let the crew choose.
  //
  // NOTE the key is `orders`, PLURAL, on purpose: ApiError.conflictOrder on the client reads
  // details.order, and a singular key here would make it think a mutation had conflicted.
  if (orders.length > 1) {
    throw conflict('ambiguous_code', `More than one order matches ${code}.`, { orders });
  }

  res.json({ order: orders[0], serverNow: Date.now() });
});

// --- Orders -------------------------------------------------------------------------------

/** Walk-in. Inserts straight into IN_PREPARATION, already paid. Not gated by orders_open. */
crewRouter.post('/orders', (req, res) => {
  const body = asObject(req.body);
  const order = createWalkInOrder({
    customerName: str(body, 'customerName', { max: 60 }),
    pizzaTypeId: int(body, 'pizzaTypeId', { min: 1 }),
    note: optStr(body, 'note', { max: 280 }) ?? '',
    // A walk-in is paid for at the counter in the same breath as being created, so the
    // method is part of creating it rather than a separate step.
    paymentMethod: oneOf(body, 'paymentMethod', PAYMENT_METHODS),
  });
  res.status(201).json({ order });
});

crewRouter.post('/orders/:id/transition', (req, res) => {
  const body = asObject(req.body);
  const order = transitionOrder(
    idParam(req),
    oneOf(body, 'expected', STATUS_ORDER),
    oneOf(body, 'next', STATUS_ORDER),
    optPayment(body),
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

/**
 * Back to the "To go in" queue. Separate from /transition because READY -> WAITING_FOR_OVEN
 * is two steps on the status line and must happen as one.
 */
crewRouter.post('/orders/:id/requeue', (req, res) => {
  res.json({ order: requeueOrder(idParam(req)) });
});

/** The mirror of /requeue, so an accidental "back to the oven" is one tap to walk back. */
crewRouter.post('/orders/:id/ready', (req, res) => {
  res.json({ order: readyOrder(idParam(req)) });
});

/**
 * Reveal the payment links on the guest's own order page. NOT a status change: the pizza
 * stays put until a crew member confirms the money actually arrived.
 */
crewRouter.post('/orders/:id/payment-request', (req, res) => {
  res.json({ order: requestPayment(idParam(req)) });
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
    emoji: optEmoji(body, 'emoji') ?? '',
    ingredients: strArray(body, 'ingredients'),
    bakeSeconds: optInt(body, 'bakeSeconds', { min: 1, max: 100000 }) ?? 300,
  });
  res.status(201).json({ pizzaType });
});

crewRouter.patch('/pizza-types/:id', (req, res) => {
  const body = asObject(req.body);
  const pizzaType = updatePizzaType(idParam(req), {
    name: optStr(body, 'name', { min: 1, max: 60 }),
    emoji: optEmoji(body, 'emoji'),
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
  updateSettings({
    ordersOpen: optBool(body, 'ordersOpen'),
    paypalLink: optPayLink(body, 'paypalLink'),
    weroLink: optPayLink(body, 'weroLink'),
  });
  res.json({ ok: true });
});
