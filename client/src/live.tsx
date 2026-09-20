import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { ApiError, crewApi } from './api.ts';
import type { CrewState, Order } from '../../shared/types.ts';

const POLL_MS = 1000;

export type ConnState = 'connecting' | 'live' | 'offline';

export type PendingEntry = {
  id: number;
  patch: Partial<Order>;
  /** The request never reached the server. NOTHING is known to have happened. */
  failed: boolean;
};

export type Toast = {
  key: number;
  text: string;
  tone: 'info' | 'warn' | 'error';
  action?: { label: string; run: () => void };
};

export type OrderMutation = {
  id: number;
  /** Applied immediately so the card moves under the finger. */
  patch: Partial<Order>;
  request: () => Promise<Order>;
  /**
   * If a 409 comes back and the authoritative row ALREADY satisfies this, the request was
   * a lost response or a duplicate tap - not a colleague. Treated as success, silently.
   * This is what keeps "Someone else already handled this one" TRUE, which is what keeps
   * the crew trusting it at 20:30.
   */
  alreadyDone?: (order: Order) => boolean;
  undo?: { text: string; label: string; run: () => Promise<Order> };
};

type LiveValue = {
  state: CrewState | null;
  /** Server orders with any optimistic patch applied. Cancelled orders are NOT filtered
   *  here - each screen decides, and the admin screen wants them. */
  orders: Order[];
  lastFrameAt: number;
  conn: ConnState;
  pending: Record<number, PendingEntry>;
  toasts: Toast[];
  dismissToast: (key: number) => void;
  pushToast: (text: string, tone?: Toast['tone'], action?: Toast['action']) => void;
  refresh: () => Promise<void>;
  mutateOrder: (m: OrderMutation) => Promise<void>;
  run: (fn: () => Promise<unknown>) => Promise<boolean>;
};

const LiveContext = createContext<LiveValue | null>(null);

export function useLive(): LiveValue {
  const ctx = useContext(LiveContext);
  if (!ctx) throw new Error('useLive must be used inside <LiveProvider>');
  return ctx;
}

function messageOf(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return 'Not sent - tap to retry';
}

export function LiveProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<CrewState | null>(null);
  const [lastFrameAt, setLastFrameAt] = useState(0);
  const [conn, setConn] = useState<ConnState>('connecting');
  const [pending, setPending] = useState<Record<number, PendingEntry>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);

  const versionRef = useRef<number | null>(null);
  const inFlight = useRef(false);
  const navigate = useNavigate();
  const location = useLocation();
  const pathRef = useRef(location.pathname);
  pathRef.current = location.pathname;

  const toastKey = useRef(1);
  const pushToast = useCallback(
    (text: string, tone: Toast['tone'] = 'info', action?: Toast['action']) => {
      const key = toastKey.current;
      toastKey.current += 1;
      setToasts((t) => [...t.slice(-3), { key, text, tone, action }]);
      // 10s, long enough to actually reach for Undo with an oven mitt on.
      setTimeout(() => setToasts((t) => t.filter((x) => x.key !== key)), 10_000);
    },
    [],
  );
  const dismissToast = useCallback((key: number) => {
    setToasts((t) => t.filter((x) => x.key !== key));
  }, []);

  const applySnapshot = useCallback((next: CrewState | null) => {
    if (next) {
      versionRef.current = next.version;
      setState(next);
    }
    setLastFrameAt(Date.now());
    setConn('live');
  }, []);

  const onPollError = useCallback(
    (e: unknown) => {
      // A 401 is not a retry case: the session is gone (revoked, or the db was recreated).
      // Sitting on a red banner forever would be a lie.
      if (e instanceof ApiError && e.status === 401) {
        navigate(`/crew/login?next=${encodeURIComponent(pathRef.current)}`, { replace: true });
        return;
      }
      setConn('offline');
    },
    [navigate],
  );

  const poll = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      applySnapshot(await crewApi.state(versionRef.current));
    } catch (e) {
      onPollError(e);
    } finally {
      inFlight.current = false;
    }
  }, [applySnapshot, onPollError]);

  /** Forces a full snapshot, used right after a write and by the Retry button. */
  const refresh = useCallback(async () => {
    try {
      applySnapshot(await crewApi.state(null));
    } catch (e) {
      onPollError(e);
    }
  }, [applySnapshot, onPollError]);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;

    const tick = async () => {
      // Paused while hidden: a tablet in a pocket should not poll all evening. Waking is
      // handled by the listeners below, so sleep/reboot/wifi-loss all converge with no
      // special-case code.
      if (document.visibilityState === 'visible') await poll();
      if (alive) timer = window.setTimeout(tick, POLL_MS);
    };

    const wake = () => {
      if (document.visibilityState === 'visible') void poll();
    };

    void tick();
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    window.addEventListener('pageshow', wake);

    return () => {
      alive = false;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
      window.removeEventListener('pageshow', wake);
    };
  }, [poll]);

  const mergeOrder = useCallback((order: Order) => {
    setState((prev) => {
      if (!prev) return prev;
      const idx = prev.orders.findIndex((o) => o.id === order.id);
      if (idx === -1) return { ...prev, orders: [...prev.orders, order] };
      // A slow response must never flip a card BACKWARDS to a stale status that then sticks
      // until the next snapshot.
      if (order.updatedAt < prev.orders[idx].updatedAt) return prev;
      const orders = prev.orders.slice();
      orders[idx] = order;
      return { ...prev, orders };
    });
  }, []);

  const clearPending = useCallback((id: number) => {
    setPending((p) => {
      if (!(id in p)) return p;
      const next = { ...p };
      delete next[id];
      return next;
    });
  }, []);

  const mutateOrder = useCallback(
    async (m: OrderMutation): Promise<void> => {
      setPending((p) => ({ ...p, [m.id]: { id: m.id, patch: m.patch, failed: false } }));
      try {
        const order = await m.request();
        mergeOrder(order);
        clearPending(m.id);
        if (m.undo) {
          const undo = m.undo;
          pushToast(undo.text, 'info', {
            label: undo.label,
            run: () => {
              void mutateOrder({ id: m.id, patch: {}, request: undo.run });
            },
          });
        }
      } catch (e) {
        if (e instanceof ApiError) {
          const authoritative = e.conflictOrder;
          if (authoritative) mergeOrder(authoritative);
          clearPending(m.id);
          if (e.status === 409 && authoritative && m.alreadyDone?.(authoritative)) return;
          if (e.status === 401) {
            navigate(`/crew/login?next=${encodeURIComponent(pathRef.current)}`, { replace: true });
            return;
          }
          pushToast(e.message, 'warn');
          return;
        }
        // Network failure: the request may or may not have landed. HOLD the optimistic state
        // and say so honestly - never imply a colleague acted.
        setPending((p) => ({ ...p, [m.id]: { id: m.id, patch: m.patch, failed: true } }));
        pushToast(messageOf(e), 'error', {
          label: 'Retry',
          run: () => {
            void mutateOrder(m);
          },
        });
      }
    },
    [clearPending, mergeOrder, navigate, pushToast],
  );

  /** For writes that are not a single order: layers, menu, settings, admin. */
  const run = useCallback(
    async (fn: () => Promise<unknown>): Promise<boolean> => {
      try {
        await fn();
        await refresh();
        return true;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          navigate(`/crew/login?next=${encodeURIComponent(pathRef.current)}`, { replace: true });
          return false;
        }
        pushToast(messageOf(e), 'error');
        return false;
      }
    },
    [navigate, pushToast, refresh],
  );

  const orders = useMemo(() => {
    const base = state?.orders ?? [];
    const keys = Object.keys(pending);
    if (keys.length === 0) return base;
    return base.map((o) => (pending[o.id] ? { ...o, ...pending[o.id].patch } : o));
  }, [state, pending]);

  const value = useMemo<LiveValue>(
    () => ({
      state,
      orders,
      lastFrameAt,
      conn,
      pending,
      toasts,
      dismissToast,
      pushToast,
      refresh,
      mutateOrder,
      run,
    }),
    [state, orders, lastFrameAt, conn, pending, toasts, dismissToast, pushToast, refresh, mutateOrder, run],
  );

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}
