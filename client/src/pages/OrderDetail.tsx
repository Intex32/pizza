import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { ApiError, publicApi } from '../api.ts';
import { addMyOrder, hasMyOrder } from '../myOrders.ts';
import { Modal, NoteBadge, StatusChip } from '../components.tsx';
import { canCustomerCancel, statusCopy } from '../statusCopy.ts';
import { Brand } from './NewOrder.tsx';
import { STATUS, STATUS_ORDER } from '../../../shared/status.ts';
import type { CustomerOrder } from '../../../shared/types.ts';

const POLL_MS = 8000;

export default function OrderDetail() {
  const { token = '' } = useParams();
  const [params] = useSearchParams();
  const isNew = params.get('new') === '1';

  const [order, setOrder] = useState<CustomerOrder | null>(null);
  const [gone, setGone] = useState(false);
  const [saved, setSaved] = useState(() => hasMyOrder(token));
  const [confirming, setConfirming] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [error, setError] = useState('');

  const poll = useCallback(async () => {
    try {
      const res = await publicApi.byToken(token);
      setOrder(res.order);
      setGone(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setGone(true);
      // Any other failure: keep showing what we have.
    }
  }, [token]);

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

  const doCancel = async () => {
    if (!order) return;
    setCancelBusy(true);
    setError('');
    try {
      const res = await publicApi.cancel(token);
      setOrder(res.order);
      setConfirming(false);
    } catch (e) {
      setConfirming(false);
      if (e instanceof ApiError) {
        // too_late hands back the authoritative row, so the page corrects itself as it
        // explains why the button did not work.
        const authoritative = (e.details as { order?: CustomerOrder } | undefined)?.order;
        if (authoritative) setOrder(authoritative);
        setError(e.message);
      } else {
        setError('Could not reach the kitchen. Try again.');
      }
    } finally {
      setCancelBusy(false);
    }
  };

  if (gone) {
    return (
      <div className="page">
        <Brand />
        <div className="empty">
          <span className="empty-emoji">🤷</span>
          <p>We could not find that order.</p>
          <p className="small muted">
            It may have been cleared after a previous pizza night. Ask at the counter, or order
            again.
          </p>
          <Link className="btn btn-primary" to="/new" style={{ marginTop: 12 }}>
            Order a pizza
          </Link>
        </div>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="page">
        <Brand />
        <p className="muted">Loading your order…</p>
      </div>
    );
  }

  const cancelled = order.cancelledAt !== null;
  const stepIndex = STATUS_ORDER.indexOf(order.status);

  return (
    <div className="page">
      <Brand />

      {isNew ? (
        <div className="banner banner-info" style={{ marginBottom: 14 }}>
          <strong>Order placed.</strong> Come to the counter and pay when you arrive — we start
          making it then.
        </div>
      ) : null}

      <div className={`card${cancelled ? ' cancelled' : ''}`}>
        <div className="row-between" style={{ alignItems: 'flex-start' }}>
          <div className="row" style={{ gap: 12, alignItems: 'center' }}>
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
        <div className="order-name" style={{ fontSize: '1.3rem' }}>
          {order.customerName}
        </div>
        <div className="order-type" style={{ marginBottom: 10 }}>
          {order.pizzaTypeName}
        </div>
        <NoteBadge note={order.note} />

        {order.status === STATUS.READY && !cancelled ? (
          <div className="ready-banner" style={{ marginTop: 14 }}>
            READY — collect it now
          </div>
        ) : (
          <p className="status-copy" style={{ marginTop: 12, marginBottom: 0 }}>
            {statusCopy(order)}
          </p>
        )}

        {!cancelled ? (
          <div className="row" style={{ gap: 4, marginTop: 14 }}>
            {STATUS_ORDER.map((s, i) => (
              <span
                key={s}
                title={s}
                style={{
                  flex: 1,
                  height: 6,
                  borderRadius: 3,
                  background: i <= stepIndex ? 'var(--accent)' : 'var(--border)',
                }}
              />
            ))}
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="banner banner-warn" style={{ marginTop: 12 }}>
          {error}
        </div>
      ) : null}

      {canCustomerCancel(order) ? (
        <button
          type="button"
          className="btn btn-ghost btn-block"
          style={{ marginTop: 14 }}
          onClick={() => setConfirming(true)}
        >
          Cancel this order
        </button>
      ) : null}

      {cancelled ? (
        <Link className="btn btn-primary btn-block" to="/new" style={{ marginTop: 14 }}>
          Order another pizza
        </Link>
      ) : null}

      {!saved ? (
        <button
          type="button"
          className="btn btn-block"
          style={{ marginTop: 10 }}
          onClick={() => {
            addMyOrder({
              token,
              name: order.customerName,
              typeName: order.pizzaTypeName,
              createdAt: order.createdAt,
            });
            setSaved(true);
          }}
        >
          Add to this device
        </button>
      ) : null}

      <div className="card muted" style={{ marginTop: 16 }}>
        <div className="small" style={{ fontWeight: 650, marginBottom: 4 }}>
          Keep this link
        </div>
        <div className="mono">{`${window.location.origin}/order/${token}`}</div>
        <div className="hint">
          Bookmark it to check your order from any device. If you lose it, just tell the crew your
          name at the counter.
        </div>
      </div>

      <p style={{ marginTop: 16 }}>
        <Link className="link" to="/">
          ← All my orders
        </Link>
      </p>

      {confirming ? (
        <Modal
          title="Cancel this order?"
          onClose={() => setConfirming(false)}
          actions={
            <>
              <button type="button" className="btn" onClick={() => setConfirming(false)}>
                Keep it
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={cancelBusy}
                onClick={() => void doCancel()}
              >
                {cancelBusy ? 'Cancelling…' : 'Yes, cancel'}
              </button>
            </>
          }
        >
          <p>
            Cancel your <strong>{order.pizzaTypeName}</strong> (#{order.id})? You will have to
            order again if you change your mind.
          </p>
        </Modal>
      ) : null}
    </div>
  );
}
