/**
 * The customer's own orders, kept in localStorage.
 *
 * An ARRAY from day one, because one order is one pizza: wanting a second pizza means a
 * second order, and the home screen has to show both.
 *
 * Every access is wrapped: Safari in private mode THROWS on localStorage rather than
 * returning null, and a thrown exception here would blank the whole page.
 */
const KEY = 'pizza.myOrders';
const MAX = 20;

export type StoredOrder = {
  token: string;
  name: string;
  typeName: string;
  createdAt: number;
  /** Set when a successful lookup reported the order as gone, so the card becomes a
   *  dismissible tombstone rather than silently vanishing. NEVER set on a network error. */
  missing?: boolean;
};

export function readMyOrders(): StoredOrder[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (o): o is StoredOrder =>
        typeof o === 'object' && o !== null && typeof (o as StoredOrder).token === 'string',
    );
  } catch {
    return [];
  }
}

function write(orders: StoredOrder[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(orders.slice(-MAX)));
  } catch {
    // Out of quota, or private mode. The order still exists on the server and the counter
    // can find it by name - which is exactly the recovery path this app is built around.
  }
}

export function addMyOrder(entry: StoredOrder): StoredOrder[] {
  const existing = readMyOrders().filter((o) => o.token !== entry.token);
  const next = [...existing, entry];
  write(next);
  return next;
}

export function hasMyOrder(token: string): boolean {
  return readMyOrders().some((o) => o.token === token);
}

/** Only ever called with tokens a SUCCESSFUL lookup reported as missing. */
export function markMissing(tokens: string[]): StoredOrder[] {
  if (tokens.length === 0) return readMyOrders();
  const next = readMyOrders().map((o) => (tokens.includes(o.token) ? { ...o, missing: true } : o));
  write(next);
  return next;
}

export function forgetMyOrder(token: string): StoredOrder[] {
  const next = readMyOrders().filter((o) => o.token !== token);
  write(next);
  return next;
}

/** One per form fill, so a double-tapped Submit on bad wifi returns the SAME order. */
export function newClientRequestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}
