import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import { useLive } from './live.tsx';
import { useNow } from './useNow.ts';
import {
  audioReady,
  isMuted,
  setMuted,
  testPrepSound,
  testSound,
  unlockAudio,
} from './alarm.ts';
import { STATUS, STATUS_LABEL } from '../../shared/status.ts';
import type { Status } from '../../shared/status.ts';
import { PAYMENT_EMOJI, PAYMENT_LABEL } from '../../shared/payment.ts';
import type { PaymentMethod } from '../../shared/payment.ts';
import type { Order } from '../../shared/types.ts';
import { glyphBucket } from './glyphs.ts';

// --- Pizza emoji ---------------------------------------------------------------------------

/**
 * A pizza's emoji in a FIXED-WIDTH cell, so every row in a list starts its name at the same x.
 *
 * A menu that mixes 🍕 with 🍕🌿 was pushing the number and the name of that row sideways by
 * the width of a second glyph, which down a long board reads as a wobbling left edge. The
 * cell is a constant width and the glyphs step down a size to fit inside it, rather than the
 * cell growing to fit them. See glyphs.ts for why counting them is not as simple as .length.
 */
export function PizzaEmoji({
  emoji,
  className = 'orow-emoji',
}: {
  emoji: string;
  className?: string;
}) {
  return (
    <span className={className} data-glyphs={glyphBucket(emoji)} aria-hidden="true">
      {emoji}
    </span>
  );
}

// --- Status chip ---------------------------------------------------------------------------

export function StatusChip({ order }: { order: Order }) {
  if (order.cancelledAt !== null) {
    return <span className="chip chip-cancelled">Cancelled</span>;
  }
  return <span className={`chip chip-${order.status}`}>{STATUS_LABEL[order.status]}</span>;
}

/** What the counter recorded. `unpaid` is rendered plainly rather than hidden, because
 *  an order that reached the kitchen without a payment recorded is worth noticing. */
export function PaymentChip({ method }: { method: PaymentMethod | null }) {
  if (method === null) return <span className="chip chip-unpaid">unpaid</span>;
  return (
    <span className={`chip chip-pay-${method}`}>
      {PAYMENT_EMOJI[method]} {PAYMENT_LABEL[method]}
    </span>
  );
}

/**
 * Tablets refuse audio until a real gesture starts it, and whether that has happened is
 * not something React re-renders on - hence the slow poll. Shared by the oven and prep
 * screens so both stations get the same control in the same place.
 */
export function SoundToggle({ kind }: { kind: 'oven' | 'prep' }) {
  const [muted, setMutedState] = useState(() => isMuted());
  const [ready, setReady] = useState(() => audioReady());

  useEffect(() => {
    const t = setInterval(() => setReady(audioReady()), 2000);
    return () => clearInterval(t);
  }, []);

  const demo = kind === 'prep' ? testPrepSound : testSound;

  if (!ready && !muted) {
    return (
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => {
          unlockAudio();
          demo();
          setReady(audioReady());
          setMutedState(isMuted());
        }}
      >
        🔇 Tap to enable sound
      </button>
    );
  }

  return (
    <button
      type="button"
      className="btn btn-sm btn-ghost"
      onClick={() => {
        const next = !muted;
        setMuted(next);
        setMutedState(next);
        if (!next) {
          unlockAudio();
          demo();
          setReady(audioReady());
        }
      }}
    >
      {muted ? '🔇 Sound off' : '🔔 Sound on'}
    </button>
  );
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
  // A screen that has NEVER had a frame is a screen that is down - not a separate state - so
  // it counts from when it mounted. Previously this returned -1 forever, which meant a tablet
  // that could not reach the server at all sat on "connecting…" and never tripped the offline
  // banner or the stale board.
  const mountedAt = useRef(Date.now());
  const since = lastFrameAt === 0 ? mountedAt.current : lastFrameAt;
  return Math.max(0, Math.round((now - since) / 1000));
}

/** How long the board has to go quiet before it is worth saying so. Polling is every 1s, so
 *  this is ten missed frames - past any single slow request, short of a real problem. */
const QUIET_BEFORE_WARNING_S = 10;

/**
 * Silent while it is working.
 *
 * There is no "Live" badge: a permanent green thing in the corner is noise, and worse, it
 * trains people to stop looking at the one spot that has to be believed when it does speak
 * up. So this renders NOTHING until the board has gone quiet, and then it is unmissable.
 *
 * The count is still the point and the dot is still decoration - a dot is painted by the same
 * JavaScript that might be dead, whereas a ticking number is self-verifying.
 */
export function ConnectionBar() {
  const secs = useSecondsSinceFrame();
  if (secs < QUIET_BEFORE_WARNING_S) return null;

  const mins = Math.floor(secs / 60);
  const rest = secs % 60;
  return (
    <span
      className={`conn ${secs >= 30 ? 'conn-dead' : 'conn-stale'}`}
      title="Nothing has arrived from the server for this long. Check the Wi-Fi."
    >
      <span className="conn-dot" />
      {/* "Not live" rather than "offline": it is also what you see for a second on a tablet
          you have just woken, where the connection is fine and only the data is old. */}
      Not live · {mins > 0 ? `${mins}m ` : ''}
      {rest}s
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
      <span className="pcard-head">
        <span className="pcard-emoji" aria-hidden="true">
          {order.pizzaTypeEmoji}
        </span>
        <span className="pcard-no">#{order.id}</span>
      </span>
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
