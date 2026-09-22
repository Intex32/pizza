import { useEffect, useMemo, useState } from 'react';
import { crewApi, serverNow } from '../api.ts';
import { useLive } from '../live.tsx';
import { useFocusCard, useFocusedOrderId } from '../useFocusOrder.ts';
import { EmptyState, PizzaEmoji, useBoardStale } from '../components.tsx';
import { useWakeLock } from '../useWakeLock.ts';
import { elapsed, useNow } from '../useNow.ts';
import { STATUS } from '../../../shared/status.ts';
import type { Order } from '../../../shared/types.ts';

const COLD_MS = 10 * 60_000;
const VERY_COLD_MS = 15 * 60_000;
const OLD_MS = 20 * 60_000;

export default function Ready() {
  useWakeLock();
  const now = useNow(1000);
  const stale = useBoardStale();
  const { orders, mutateOrder } = useLive();
  const [showOld, setShowOld] = useState(false);
  const focusId = useFocusedOrderId();

  const all = useMemo(
    () =>
      orders
        .filter((o) => o.cancelledAt === null && o.status === STATUS.READY)
        .sort((a, b) => (a.readyAt ?? 0) - (b.readyAt ?? 0)),
    [orders],
  );

  const fresh = all.filter((o) => now - (o.readyAt ?? now) < OLD_MS);
  const old = all.filter((o) => now - (o.readyAt ?? now) >= OLD_MS);

  // A scanned order is DISPROPORTIONATELY likely to be in the collapsed >20-minute bucket -
  // that is exactly the pizza someone comes back to ask about. Without this the scan would
  // report success and highlight a card that is not on screen.
  //
  // This sits ABOVE the empty-board early return, not next to the markup it affects: a hook
  // after that return runs on some renders and not others, which React rejects outright.
  // The dependency is a boolean rather than `old`, which is a fresh array every second.
  const focusIsOld = focusId !== null && old.some((o) => o.id === focusId);
  useEffect(() => {
    if (focusIsOld) setShowOld(true);
  }, [focusIsOld]);

  const collect = (o: Order) => {
    void mutateOrder({
      id: o.id,
      patch: { status: STATUS.PICKED_UP, pickedUpAt: serverNow() },
      request: () => crewApi.transition(o.id, STATUS.READY, STATUS.PICKED_UP).then((r) => r.order),
      alreadyDone: (x) => x.status === STATUS.PICKED_UP,
      undo: {
        text: `#${o.id} ${o.customerName} collected`,
        label: 'Undo',
        run: () => crewApi.transition(o.id, STATUS.PICKED_UP, STATUS.READY).then((r) => r.order),
      },
    });
  };

  /**
   * Raw in the middle. The most common backward move at a real pizza night.
   *
   * It lands in "To go in", NOT in the Unplaced tray. Unplaced means "baking, but nobody
   * recorded where" - and this pizza is not baking, it is in somebody's hand on the way
   * back to the oven. Somebody has to physically slide it in and say which slot, and the
   * queue is the state that says exactly that. It is the same reasoning as the undo of
   * "mark ready" on the oven screen, which lands in the same place.
   *
   * The consequence is that the bake timer is discarded rather than resumed. That is right
   * for this button: a pizza that came out raw is going back in for a fresh amount of time
   * that the oven crew choose, not for the remainder of a countdown that already expired.
   */
  const backToOven = (o: Order) => {
    void mutateOrder({
      id: o.id,
      patch: {
        status: STATUS.WAITING_FOR_OVEN,
        ovenLayerId: null,
        ovenSlot: null,
        bakingStartedAt: null,
        bakeSeconds: null,
      },
      request: () => crewApi.requeue(o.id).then((r) => r.order),
      alreadyDone: (x) => x.status === STATUS.WAITING_FOR_OVEN,
      undo: {
        text: `#${o.id} ${o.customerName} → back in the oven`,
        label: 'Undo',
        /**
         * This button sits on a card whose whole job is to be tapped, so a thumb that lands
         * a little low sends a collected pizza back to the queue - with the guest standing
         * right there. One tap puts it back on the board.
         *
         * The "ready N minutes ago" clock restarts: requeue cleared ready_at and nothing
         * remembers the old value. Worth it against a mis-tap that could otherwise only be
         * walked back by re-baking the pizza.
         */
        run: () => crewApi.ready(o.id).then((r) => r.order),
      },
    });
  };

  if (all.length === 0) {
    return (
      <EmptyState emoji="✅">
        <p>Nothing ready for collection yet.</p>
      </EmptyState>
    );
  }

  return (
    <div className={stale ? 'board-stale' : ''}>
      <div className="ready-grid">
        {fresh.map((o) => (
          <ReadyCard
            key={o.id}
            order={o}
            now={now}
            focusId={focusId}
            onCollect={() => collect(o)}
            onBack={() => backToOven(o)}
          />
        ))}
      </div>

      {old.length > 0 ? (
        <div style={{ marginTop: 18 }}>
          <button type="button" className="btn btn-ghost" onClick={() => setShowOld((v) => !v)}>
            {showOld ? 'Hide' : 'Show'} older ({old.length})
          </button>
          {showOld ? (
            <div className="ready-grid" style={{ marginTop: 12 }}>
              {old.map((o) => (
                <ReadyCard
                  key={o.id}
                  order={o}
                  now={now}
                  focusId={focusId}
                  onCollect={() => collect(o)}
                  onBack={() => backToOven(o)}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ReadyCard({
  order,
  now,
  focusId,
  onCollect,
  onBack,
}: {
  order: Order;
  now: number;
  focusId: number | null;
  onCollect: () => void;
  onBack: () => void;
}) {
  const { pending } = useLive();
  const p = pending[order.id];
  const age = now - (order.readyAt ?? now);
  // A cold uncollected pizza is a signal to call the name out loud, not a design accident.
  const tone = age >= VERY_COLD_MS ? ' very-cold' : age >= COLD_MS ? ' cold' : '';
  const { ref, focused } = useFocusCard<HTMLDivElement>(order.id, focusId);

  return (
    <div ref={ref} className="ready-cell" style={{ opacity: p && !p.failed ? 0.6 : 1 }}>
      <button
        type="button"
        className={`ready-card${tone}${focused ? ' focused' : ''}`}
        onClick={onCollect}
        disabled={Boolean(p && !p.failed)}
      >
        {/* Emoji beside the number, the same pairing the oven screen uses - whoever is
            handing pizzas out is matching what is in their hand against the board, and the
            picture is quicker to match than the type name underneath. */}
        <span className="ready-head">
          <PizzaEmoji emoji={order.pizzaTypeEmoji} className="ready-emoji" />
          <span className="ready-no">#{order.id}</span>
        </span>
        <span className="ready-name">{order.customerName}</span>
        <span className="ready-sub">{order.pizzaTypeName}</span>
        <span className="ready-sub">ready {elapsed(order.readyAt, now)}</span>
      </button>
      <button
        type="button"
        className="btn btn-sm btn-ghost ready-back"
        title="Raw in the middle - send it back to the oven queue"
        onClick={(e) => {
          e.stopPropagation();
          onBack();
        }}
      >
        ↩ oven
      </button>
    </div>
  );
}
