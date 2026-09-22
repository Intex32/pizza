import type {
  CrewState,
  CustomerOrder,
  Order,
  OvenLayer,
  PizzaType,
  PublicConfig,
} from '../../shared/types.ts';
import type { PaymentMethod } from '../../shared/payment.ts';

export class ApiError extends Error {
  status: number;
  code: string;
  details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** A 409 hands back the authoritative row so the screen can self-correct immediately. */
  get conflictOrder(): Order | undefined {
    const d = this.details as { order?: Order } | undefined;
    return d?.order;
  }
}

/** Thrown when the request never reached the server, as opposed to being rejected by it.
 *  The difference matters: one means "someone else got there first", the other means
 *  "nothing happened, tap again" - and telling a cook the wrong one destroys their trust. */
export class NetworkError extends Error {
  constructor(message = 'Could not reach the server') {
    super(message);
    this.name = 'NetworkError';
  }
}

// --- Server clock ------------------------------------------------------------------------
// Every API response carries X-Server-Now, so the offset stays fresh even across the 204s
// that make up the steady state. Timer code NEVER uses a raw Date.now(): a tablet whose
// clock is 40 seconds fast would otherwise blink 40 seconds early, and burn the pizza.
let clockOffset = 0;
let clockSeen = false;

export function noteServerNow(serverMs: number): void {
  if (!Number.isFinite(serverMs)) return;
  clockOffset = serverMs - Date.now();
  clockSeen = true;
}

export function serverNow(): number {
  return Date.now() + clockOffset;
}

export function clockIsSynced(): boolean {
  return clockSeen;
}

const TIMEOUT_MS = 8000;

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; data: T }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      credentials: 'same-origin',
    });
  } catch {
    throw new NetworkError();
  } finally {
    clearTimeout(timer);
  }

  const headerNow = res.headers.get('x-server-now');
  if (headerNow) noteServerNow(Number(headerNow));

  if (res.status === 204) return { status: 204, data: undefined as T };

  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!res.ok) {
    const err = (parsed as { error?: { code?: string; message?: string; details?: unknown } })?.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'unknown',
      err?.message ?? `Request failed (${res.status})`,
      err?.details,
    );
  }

  return { status: res.status, data: parsed as T };
}

export const api = {
  get: <T,>(path: string) => request<T>('GET', path).then((r) => r.data),
  post: <T,>(path: string, body?: unknown, headers?: Record<string, string>) =>
    request<T>('POST', path, body, headers).then((r) => r.data),
  patch: <T,>(path: string, body?: unknown) => request<T>('PATCH', path, body).then((r) => r.data),
  del: <T,>(path: string, headers?: Record<string, string>) =>
    request<T>('DELETE', path, undefined, headers).then((r) => r.data),
};

// --- Public ---------------------------------------------------------------------------------
export const publicApi = {
  config: () => api.get<PublicConfig>('/api/config'),
  createOrder: (body: {
    customerName: string;
    pizzaTypeId: number;
    note: string;
    clientRequestId: string;
  }) => api.post<{ order: CustomerOrder }>('/api/orders', body),
  lookup: (tokens: string[]) =>
    api.post<{ orders: CustomerOrder[]; missing: string[] }>('/api/orders/lookup', { tokens }),
  byToken: (token: string) =>
    api.get<{ order: CustomerOrder }>(`/api/orders/${encodeURIComponent(token)}`),
  cancel: (token: string) =>
    api.post<{ order: CustomerOrder }>(`/api/orders/${encodeURIComponent(token)}/cancel`),
  login: (password: string) => api.post<void>('/api/auth/login', { password }),
  logout: () => api.post<void>('/api/auth/logout'),
  session: () => api.get<{ authenticated: boolean }>('/api/auth/session'),
};

// --- Crew -----------------------------------------------------------------------------------
export const crewApi = {
  /** Returns null when the server says "nothing has changed since your version". */
  state: async (since: number | null): Promise<CrewState | null> => {
    const path = since === null ? '/api/crew/state' : `/api/crew/state?since=${since}`;
    const { status, data } = await request<CrewState>('GET', path);
    return status === 204 ? null : data;
  },
  /**
   * Scanned QR (token) or typed pickup code -> the order it names. A READ: it never moves a
   * pizza. POST with the value in the BODY, not the path, so a capability token cannot end
   * up in a server log.
   */
  resolve: (body: { token: string } | { code: string }) =>
    api.post<{ order: Order }>('/api/crew/resolve', body),
  walkIn: (body: {
    customerName: string;
    pizzaTypeId: number;
    note: string;
    paymentMethod: PaymentMethod;
  }) => api.post<{ order: Order }>('/api/crew/orders', body),
  /** `paymentMethod` is only meaningful on the ORDERED -> IN_PREPARATION step. */
  transition: (id: number, expected: string, next: string, paymentMethod?: PaymentMethod) =>
    api.post<{ order: Order }>(`/api/crew/orders/${id}/transition`, {
      expected,
      next,
      ...(paymentMethod ? { paymentMethod } : {}),
    }),
  /** A deck is a numbered row of slots and order matters, so placement is a PAIR.
   *  Both null means the Unplaced tray. */
  place: (id: number, ovenLayerId: number | null, ovenSlot: number | null) =>
    api.post<{ order: Order }>(`/api/crew/orders/${id}/place`, { ovenLayerId, ovenSlot }),
  setBake: (id: number, bakeSeconds: number) =>
    api.patch<{ order: Order }>(`/api/crew/orders/${id}/bake`, { bakeSeconds }),
  edit: (id: number, body: { customerName?: string; pizzaTypeId?: number; note?: string }) =>
    api.patch<{ order: Order }>(`/api/crew/orders/${id}`, body),
  markUnpaid: (id: number) => api.post<{ order: Order }>(`/api/crew/orders/${id}/unpaid`),
  cancel: (id: number, reason?: string) =>
    api.post<{ order: Order }>(`/api/crew/orders/${id}/cancel`, { reason }),
  uncancel: (id: number) => api.post<{ order: Order }>(`/api/crew/orders/${id}/uncancel`),
  remake: (id: number) => api.post<{ original: Order; clone: Order }>(`/api/crew/orders/${id}/remake`),

  createLayer: (name: string, capacity: number) =>
    api.post<{ layer: OvenLayer }>('/api/crew/layers', { name, capacity }),
  /** `evicted` counts pizzas that were sitting in slots a shrunk deck no longer has. */
  updateLayer: (id: number, body: { name?: string; capacity?: number; position?: number }) =>
    api.patch<{ layer: OvenLayer; evicted: number }>(`/api/crew/layers/${id}`, body),
  deleteLayer: (id: number, moveTo: number | 'unplaced') =>
    api.del<{ moved: number; toUnplaced: number; to: number | null }>(
      `/api/crew/layers/${id}?moveTo=${moveTo}`,
    ),

  createType: (body: {
    name: string;
    emoji: string;
    ingredients: string[];
    bakeSeconds: number;
  }) => api.post<{ pizzaType: PizzaType }>('/api/crew/pizza-types', body),
  updateType: (
    id: number,
    body: {
      name?: string;
      emoji?: string;
      ingredients?: string[];
      bakeSeconds?: number;
      soldOut?: boolean;
      position?: number;
      archived?: boolean;
    },
  ) => api.patch<{ pizzaType: PizzaType }>(`/api/crew/pizza-types/${id}`, body),
  deleteType: (id: number) => api.del<void>(`/api/crew/pizza-types/${id}`),

  settings: (body: { ordersOpen?: boolean }) => api.patch<void>('/api/crew/settings', body),

  deleteOrder: (id: number) =>
    api.del<void>(`/api/crew/admin/orders/${id}`, { 'x-confirm': 'delete-order' }),
  purge: () => api.post<{ deleted: number; backupFile: string }>('/api/crew/admin/purge', {
    confirm: 'DELETE ALL ORDERS',
  }),
  backup: () => api.post<{ file: string }>('/api/crew/admin/backup'),
  backups: () =>
    api.get<{ files: { name: string; size: number; mtime: number }[] }>('/api/crew/admin/backups'),
};
