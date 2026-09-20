import { Router } from 'express';
import {
  allPizzaTypes,
  getCustomerOrderByToken,
  orderCount,
  readSettings,
} from '../db.ts';
import { cancelByToken, createCustomerOrder } from '../orders.ts';
import { asObject, bad, int, notFound, optStr, str } from '../validate.ts';
import {
  clearSessionCookie,
  createSession,
  destroySession,
  isAuthenticated,
  loginDelayMs,
  noteLoginFailure,
  noteLoginSuccess,
  passwordMatches,
  setSessionCookie,
  sleep,
  COOKIE_NAME,
} from '../auth.ts';
import type { PublicPizzaType } from '../../shared/types.ts';

export const publicRouter: Router = Router();

// =========================================================================================
// THE ENTIRE UNAUTHENTICATED SURFACE. It should stay readable in fifteen seconds.
// Note what is NOT here: there is no GET /api/orders. The only unauthenticated read of an
// order is by its own 128-bit token.
// =========================================================================================

const startedAt = Date.now();

publicRouter.get('/health', (_req, res) => {
  res.json({
    ok: true,
    serverNow: Date.now(),
    uptimeS: Math.round((Date.now() - startedAt) / 1000),
    orderCount: orderCount(),
  });
});

publicRouter.get('/config', (_req, res) => {
  const pizzaTypes: PublicPizzaType[] = allPizzaTypes()
    .filter((t) => t.archivedAt === null)
    .map((t) => ({ id: t.id, name: t.name, ingredients: t.ingredients, soldOut: t.soldOut }));
  res.json({ ordersOpen: readSettings().ordersOpen, pizzaTypes, serverNow: Date.now() });
});

publicRouter.post('/orders', (req, res) => {
  const body = asObject(req.body);
  const { order, created } = createCustomerOrder({
    customerName: str(body, 'customerName', { max: 60 }),
    pizzaTypeId: int(body, 'pizzaTypeId', { min: 1 }),
    note: optStr(body, 'note', { max: 280 }) ?? '',
    clientRequestId: str(body, 'clientRequestId', { max: 64 }),
  });
  // 200 rather than 201 when the same clientRequestId comes back: a double-tapped Submit
  // returns the SAME order instead of making a second pizza.
  res.status(created ? 201 : 200).json({ order, serverNow: Date.now() });
});

/** POST, not GET: a batch of capability tokens must never land in a URL or a server log. */
publicRouter.post('/orders/lookup', (req, res) => {
  const body = asObject(req.body);
  const raw = body.tokens;
  if (!Array.isArray(raw)) throw bad('invalid_field', 'tokens must be an array');
  if (raw.length > 25) throw bad('too_many_tokens', 'At most 25 orders per lookup');

  const orders = [];
  const missing: string[] = [];
  for (const t of raw) {
    if (typeof t !== 'string') continue;
    const found = getCustomerOrderByToken(t);
    if (found) orders.push(found);
    else missing.push(t);
  }
  res.json({ orders, missing, serverNow: Date.now() });
});

publicRouter.get('/orders/:token', (req, res) => {
  const order = getCustomerOrderByToken(req.params.token);
  if (!order) throw notFound('order_not_found', 'We could not find that order.');
  res.json({ order, serverNow: Date.now() });
});

/**
 * The ONE public mutation. Guarded server-side to status=ORDERED and unpaid, so a guest can
 * never cancel a pizza that is already being made or baking.
 */
publicRouter.post('/orders/:token/cancel', (req, res) => {
  const order = cancelByToken(req.params.token);
  res.json({ order, serverNow: Date.now() });
});

// --- Auth --------------------------------------------------------------------------------

publicRouter.post('/auth/login', async (req, res) => {
  const body = asObject(req.body);
  const password = str(body, 'password', { max: 200, trim: false });
  const ip = req.ip ?? 'unknown';

  const delay = loginDelayMs(ip);
  if (delay > 0) await sleep(delay);

  if (!passwordMatches(password)) {
    noteLoginFailure(ip);
    res.status(401).json({ error: { code: 'bad_password', message: 'Wrong password.' } });
    return;
  }

  noteLoginSuccess(ip);
  setSessionCookie(res, createSession());
  res.status(204).end();
});

publicRouter.post('/auth/logout', (req, res) => {
  const header = req.headers.cookie ?? '';
  const match = header.split(';').find((p) => p.trim().startsWith(`${COOKIE_NAME}=`));
  if (match) destroySession(match.slice(match.indexOf('=') + 1).trim());
  clearSessionCookie(res);
  res.status(204).end();
});

/** Never 401s - the client uses it to decide what to render, not whether it may proceed. */
publicRouter.get('/auth/session', (req, res) => {
  res.json({ authenticated: isAuthenticated(req) });
});
