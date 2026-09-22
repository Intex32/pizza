import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { publicApi } from '../api.ts';
import { forgetMyOrder, markMissing, readMyOrders } from '../myOrders.ts';
import type { StoredOrder } from '../myOrders.ts';
import { StatusChip } from '../components.tsx';
import { statusCopy } from '../statusCopy.ts';
import { Brand } from './NewOrder.tsx';
import { STATUS } from '../../../shared/status.ts';
import type { CustomerOrder } from '../../../shared/types.ts';

const POLL_MS = 8000;

export default function CustomerHome() {
  const [stored, setStored] = useState<StoredOrder[]>(() => readMyOrders());
  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [loaded, setLoaded] = useState(false);

  const tokens = stored.filter((s) => !s.missing).map((s) => s.token);
  const tokenKey = tokens.join(',');

  const poll = useCallback(async () => {
    if (tokenKey === '') {
      setOrders([]);
      setLoaded(true);
      return;
    }
    try {
      const res = await publicApi.lookup(tokenKey.split(','));
      setOrders(res.orders);
      // Tombstones are created ONLY from a successful lookup. A network error must never
      // make someone's order look like it vanished.
      if (res.missing.length > 0) setStored(markMissing(res.missing));
      setLoaded(true);
    } catch {
      // Keep showing the last known state; the ticking will pick it back up.
    }
  }, [tokenKey]);

  useEffect(() => {
    void poll();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void poll();
    }, POLL_MS);
    const wake = () => {
      if (document.visibilityState === 'visible') void poll();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('pageshow', wake);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('pageshow', wake);
    };
  }, [poll]);

  const missing = stored.filter((s) => s.missing);
  const byToken = new Map(orders.map((o) => [o.publicToken, o]));
  const mine = stored
    .filter((s) => !s.missing)
    .map((s) => byToken.get(s.token))
    .filter((o): o is CustomerOrder => Boolean(o))
    .sort((a, b) => b.createdAt - a.createdAt);

  return (
    <div className="page">
      <Brand />

      {stored.length === 0 ? (
        <>
          <h1>Hungry?</h1>
          <p className="muted">
            Pick a pizza, leave your name, and come to the counter to pay when you arrive.
          </p>
          <Link className="btn btn-primary btn-lg btn-block" to="/new" style={{ marginTop: 18 }}>
            Order a pizza
          </Link>
        </>
      ) : (
        <>
          <div className="row-between" style={{ marginBottom: 12 }}>
            <h1 style={{ margin: 0 }}>My orders</h1>
            <Link className="btn btn-primary" to="/new">
              + Another
            </Link>
          </div>

          {!loaded && mine.length === 0 ? <p className="muted">Checking…</p> : null}

          <div className="stack">
            {mine.map((order) => (
              <Link
                key={order.publicToken}
                to={`/order/${order.publicToken}`}
                className={`card${order.cancelledAt !== null ? ' cancelled' : ''}`}
                style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
              >
                <div className="row-between" style={{ alignItems: 'flex-start' }}>
                  <div className="row" style={{ gap: 10, alignItems: 'center' }}>
                    <span className="order-emoji" aria-hidden="true">
                      {order.pizzaTypeEmoji}
                    </span>
                    <div className="order-no">
                      <span className="hash">#</span>
                      {order.id}
                    </div>
                  </div>
                  <StatusChip order={order} />
                </div>
                <div className="order-name">{order.customerName}</div>
                <div className="order-type">{order.pizzaTypeName}</div>
                {order.status === STATUS.READY && order.cancelledAt === null ? (
                  <div className="ready-banner" style={{ marginTop: 12 }}>
                    READY — collect it now
                  </div>
                ) : (
                  <div className="status-copy" style={{ marginTop: 8 }}>
                    {statusCopy(order)}
                  </div>
                )}
              </Link>
            ))}
          </div>
        </>
      )}

      {missing.length > 0 ? (
        <div className="card muted" style={{ marginTop: 16 }}>
          <strong className="small">No longer on the system</strong>
          {missing.map((m) => (
            <div key={m.token} className="row-between" style={{ marginTop: 8 }}>
              <span className="small muted">
                {m.name} · {m.typeName}
              </span>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => setStored(forgetMyOrder(m.token))}
              >
                Dismiss
              </button>
            </div>
          ))}
          <div className="hint">
            The crew may have cleared out old orders. Just order again, or ask at the counter.
          </div>
        </div>
      ) : null}
    </div>
  );
}
