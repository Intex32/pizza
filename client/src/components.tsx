import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import { useLive } from './live.tsx';
import { useNow } from './useNow.ts';
import { STATUS, STATUS_LABEL } from '../../shared/status.ts';
import type { Status } from '../../shared/status.ts';
import type { Order } from '../../shared/types.ts';

// --- Status chip ---------------------------------------------------------------------------

export function StatusChip({ order }: { order: Order }) {
  if (order.cancelledAt !== null) {
    return <span className="chip chip-cancelled">Cancelled</span>;
  }
  return <span className={`chip chip-${order.status}`}>{STATUS_LABEL[order.status]}</span>;
}

export function NoteBadge({ note }: { note: string }) {
  if (!note.trim()) return null;
  return <div className="note">{note}</div>;
}

// --- Toasts ---------------------------------------------------------------------------------

export function Toasts() {
  const { toasts, dismissToast } = useLive();
  if (toasts.length === 0) return null;
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.key} className={`toast toast-${t.tone}`} role="status">
          <span style={{ flex: 1 }}>{t.text}</span>
          {t.action ? (
            <button
              type="button"
              className="btn"
              onClick={() => {
                t.action?.run();
                dismissToast(t.key);
              }}
            >
              {t.action.label}
            </button>
          ) : null}
          <button
            type="button"
            className="btn"
            aria-label="Dismiss"
            onClick={() => dismissToast(t.key)}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

// --- Modal ------------------------------------------------------------------------------------

export function Modal({
  title,
  children,
  onClose,
  actions,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  actions: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
        <div className="modal-actions">{actions}</div>
      </div>
    </div>
  );
}

// --- Connection bar ---------------------------------------------------------------------------

/** Seconds since the last frame from the server, 204s included. */
export function useSecondsSinceFrame(): number {
  const { lastFrameAt } = useLive();
  const now = useNow(1000);
  if (lastFrameAt === 0) return -1;
  return Math.max(0, Math.round((now - lastFrameAt) / 1000));
}

/**
 * A green dot is painted by the same JavaScript that might be dead. A TICKING number is
 * self-verifying, which is why the count is the point and the dot is decoration.
 */
export function ConnectionBar() {
  const secs = useSecondsSinceFrame();
  if (secs < 0) {
    return (
      <span className="conn conn-stale">
        <span className="conn-dot" />
        connecting…
      </span>
    );
  }
  const cls = secs >= 30 ? 'conn-dead' : secs >= 5 ? 'conn-stale' : 'conn-live';
  return (
    <span className={`conn ${cls}`} title="Seconds since the last update from the server">
      <span className="conn-dot" />
      Live · {secs}s
    </span>
  );
}

export function OfflineBanner() {
  const secs = useSecondsSinceFrame();
  const { refresh } = useLive();
  if (secs < 30) return null;
  const mins = Math.floor(secs / 60);
  const rest = secs % 60;
  return (
    <div className="offline-banner">
      <span style={{ flex: 1 }}>
        NOT LIVE — last update {mins > 0 ? `${mins} m ` : ''}
        {rest}s ago
      </span>
      <button type="button" className="btn btn-sm" onClick={() => void refresh()}>
        Retry
      </button>
    </div>
  );
}

/** Past a minute the board is not merely late, it is untrustworthy. */
export function useBoardStale(): boolean {
  return useSecondsSinceFrame() >= 60;
}

// --- Counts strip -------------------------------------------------------------------------------

export function countByStatus(orders: Order[]): Record<Status, number> {
  const counts: Record<Status, number> = {
    ORDERED: 0,
    IN_PREPARATION: 0,
    WAITING_FOR_OVEN: 0,
    BAKING: 0,
    READY: 0,
    PICKED_UP: 0,
  };
  for (const o of orders) {
    if (o.cancelledAt !== null) continue;
    counts[o.status] += 1;
  }
  return counts;
}

/**
 * Answers the one question no single-status screen can: how far behind are we? It is also
 * what makes a baking-but-unplaced pizza impossible to lose.
 */
export function CountsStrip() {
  const { orders, state } = useLive();
  const counts = countByStatus(orders);
  const ovenCapacity = (state?.layers ?? []).reduce((sum, l) => sum + l.capacity, 0);

  // One chip per screen. There is deliberately no QUEUE chip: the queue is part of the oven
  // screen now, and a second chip pointing at the same place was just clutter. How many are
  // waiting is on that screen, in the "To go in" tray and the line above the decks.
  const items: { to: string; label: string; value: string }[] = [
    { to: '/crew/orders', label: 'ORD', value: String(counts[STATUS.ORDERED]) },
    { to: '/crew/prep', label: 'PREP', value: String(counts[STATUS.IN_PREPARATION]) },
    {
      to: '/crew/oven',
      label: 'OVEN',
      value: `${counts[STATUS.BAKING]}${ovenCapacity ? `/${ovenCapacity}` : ''}`,
    },
    { to: '/crew/ready', label: 'READY', value: String(counts[STATUS.READY]) },
  ];

  return (
    <div className="counts">
      {items.map((it) => (
        <NavLink
          key={it.to}
          to={it.to}
          className={({ isActive }) => `count${isActive ? ' active' : ''}`}
        >
          {it.label} <b>{it.value}</b>
        </NavLink>
      ))}
    </div>
  );
}

// --- Pizza card ----------------------------------------------------------------------------------

export function PizzaCard({
  order,
  onClick,
  children,
  className = '',
  footer,
}: {
  order: Order;
  onClick?: () => void;
  children?: ReactNode;
  className?: string;
  footer?: ReactNode;
}) {
  const { pending } = useLive();
  const p = pending[order.id];
  const cls = [
    'pcard',
    p && !p.failed ? 'pending' : '',
    p && p.failed ? 'failed' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button type="button" className={cls} onClick={onClick} disabled={!onClick}>
      {p?.failed ? <span className="badge-unsaved">not saved</span> : null}
      <span className="pcard-no">#{order.id}</span>
      <span className="pcard-name">{order.customerName}</span>
      <span className="pcard-type">{order.pizzaTypeName}</span>
      {order.note.trim() ? <span className="note">{order.note}</span> : null}
      {children}
      {footer ? <span className="pcard-meta">{footer}</span> : null}
    </button>
  );
}

export function EmptyState({ emoji, children }: { emoji: string; children: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-emoji">{emoji}</span>
      {children}
    </div>
  );
}
