import { useEffect, useMemo, useState } from 'react';
import { crewApi, serverNow } from '../api.ts';
import { useLive } from '../live.tsx';
import { useFocusCard, useFocusedOrderId } from '../useFocusOrder.ts';
import { EmptyState, useBoardStale } from '../components.tsx';
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
   * It goes back to the Unplaced tray rather than its old slot: leaving the oven freed that
   * slot, and something else may well be in it by now. The oven crew give it a real slot on
   * the oven screen. Within two minutes the server resumes the original countdown, so an
   * accidental tap costs nothing.
   */
  const backToOven = (o: Order) => {
    void mutateOrder({
      id: o.id,
      patch: { status: STATUS.BAKING, ovenLayerId: null, ovenSlot: null },
      request: () => crewApi.place(o.id, null, null).then((r) => r.order),
      alreadyDone: (x) => x.status === STATUS.BAKING,
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
    <div ref={ref} style={{ position: 'relative', opacity: p && !p.failed ? 0.6 : 1 }}>
      <button
        type="button"
        className={`ready-card${tone}${focused ? ' focused' : ''}`}
        onClick={onCollect}
        disabled={Boolean(p && !p.failed)}
      >
        <span className="ready-no">#{order.id}</span>
        <span className="ready-name">{order.customerName}</span>
        <span className="ready-sub">{order.pizzaTypeName}</span>
        <span className="ready-sub">ready {elapsed(order.readyAt, now)}</span>
      </button>
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        style={{ position: 'absolute', top: 8, right: 8 }}
        title="Raw in the middle - put it back in the oven"
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
