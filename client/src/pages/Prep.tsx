import { useEffect, useMemo, useRef } from 'react';
import { crewApi, serverNow } from '../api.ts';
import { useLive } from '../live.tsx';
import { useFocusCard, useFocusedOrderId } from '../useFocusOrder.ts';
import { EmptyState, NoteBadge, SoundToggle, useBoardStale } from '../components.tsx';
import { useWakeLock } from '../useWakeLock.ts';
import { useNow, elapsed } from '../useNow.ts';
import { playPrepArrival } from '../alarm.ts';
import { STATUS } from '../../../shared/status.ts';
import type { Order } from '../../../shared/types.ts';

export default function Prep() {
  useWakeLock();
  const now = useNow(1000);
  const stale = useBoardStale();
  const { orders, mutateOrder } = useLive();
  const focusId = useFocusedOrderId();

  // Oldest first: whoever has been waiting longest gets made next, and a list that only
  // ever grows downwards means the top of the screen is stable to work from.
  const list = useMemo(
    () =>
      orders
        .filter((o) => o.cancelledAt === null && o.status === STATUS.IN_PREPARATION)
        .sort((a, b) => (a.paidAt ?? a.createdAt) - (b.paidAt ?? b.createdAt)),
    [orders],
  );

  /**
   * Ding when a NEW pizza lands here. The first snapshot is recorded silently - otherwise
   * opening the screen with eight pizzas already queued would sound like eight new orders.
   */
  const seenRef = useRef<Set<number> | null>(null);
  useEffect(() => {
    const ids = new Set(list.map((o) => o.id));
    if (seenRef.current === null) {
      seenRef.current = ids;
      return;
    }
    const previous = seenRef.current;
    const arrived = [...ids].some((id) => !previous.has(id));
    seenRef.current = ids;
    if (arrived) playPrepArrival();
  }, [list]);

  const toOven = (o: Order) => {
    void mutateOrder({
      id: o.id,
      patch: { status: STATUS.WAITING_FOR_OVEN, queuedAt: serverNow() },
      request: () =>
        crewApi
          .transition(o.id, STATUS.IN_PREPARATION, STATUS.WAITING_FOR_OVEN)
          .then((r) => r.order),
      alreadyDone: (x) => x.status === STATUS.WAITING_FOR_OVEN,
      undo: {
        text: `#${o.id} ${o.customerName} → oven queue`,
        label: 'Undo',
        run: () =>
          crewApi
            .transition(o.id, STATUS.WAITING_FOR_OVEN, STATUS.IN_PREPARATION)
            .then((r) => r.order),
      },
    });
  };

  return (
    <div className="maxw">
      <div className="row wrap" style={{ marginBottom: 12, gap: 8 }}>
        <span className="small muted">
          {list.length === 0
            ? 'Nothing to make'
            : `${list.length} to make · oldest first`}
        </span>
        <span className="spacer" />
        <SoundToggle kind="prep" />
      </div>

      {list.length === 0 ? (
        <EmptyState emoji="🧑‍🍳">
          <p>Nothing to prepare right now.</p>
          <p className="small">Pizzas appear here the moment the counter takes payment.</p>
        </EmptyState>
      ) : (
        <div className={`olist${stale ? ' board-stale' : ''}`}>
          {list.map((o) => (
            <PrepRow key={o.id} order={o} now={now} focusId={focusId} onToOven={() => toOven(o)} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Extracted from the list only because useFocusCard is a hook and cannot run inside .map(). */
function PrepRow({
  order,
  now,
  focusId,
  onToOven,
}: {
  order: Order;
  now: number;
  focusId: number | null;
  onToOven: () => void;
}) {
  const { pending } = useLive();
  const p = pending[order.id];
  const locked = Boolean(p && !p.failed);
  const { ref, focused } = useFocusCard<HTMLDivElement>(order.id, focusId);

  return (
    <div
      ref={ref}
      className={`orow${focused ? ' focused' : ''}`}
      style={{
        opacity: locked ? 0.6 : 1,
        borderColor: p?.failed ? 'var(--warn)' : undefined,
      }}
    >
      <span className="orow-emoji" aria-hidden="true">
        {order.pizzaTypeEmoji}
      </span>
      <span className="orow-no">#{order.id}</span>
      <div className="orow-main">
        <div className="orow-name">{order.customerName}</div>
        <div className="orow-sub">
          {order.pizzaTypeName} · waiting {elapsed(order.paidAt ?? order.createdAt, now)}
          {p?.failed ? ' · NOT SAVED' : ''}
        </div>
        <NoteBadge note={order.note} />
      </div>
      <div className="orow-actions">
        {/* Advancing is a deliberate button press, never a tap on the row: a sleeve brushing
            a card should not send a pizza to the oven. */}
        <button type="button" className="btn btn-ok btn-advance" disabled={locked} onClick={onToOven}>
          MOVE TO OVEN
        </button>
      </div>
    </div>
  );
}
