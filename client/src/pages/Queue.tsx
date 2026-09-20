import { useMemo, useState } from 'react';
import { crewApi, serverNow } from '../api.ts';
import { useLive } from '../live.tsx';
import { EmptyState, Modal, PizzaCard, useBoardStale } from '../components.tsx';
import { useWakeLock } from '../useWakeLock.ts';
import { elapsed, useNow } from '../useNow.ts';
import { STATUS } from '../../../shared/status.ts';
import type { Order } from '../../../shared/types.ts';

export default function Queue() {
  useWakeLock();
  const now = useNow(1000);
  const stale = useBoardStale();
  const { orders, state, mutateOrder } = useLive();
  const [placing, setPlacing] = useState<Order | null>(null);

  const list = useMemo(
    () =>
      orders
        .filter((o) => o.cancelledAt === null && o.status === STATUS.WAITING_FOR_OVEN)
        .sort((a, b) => (a.queuedAt ?? a.createdAt) - (b.queuedAt ?? b.createdAt)),
    [orders],
  );

  const place = (order: Order, layerId: number | null) => {
    setPlacing(null);
    void mutateOrder({
      id: order.id,
      patch: {
        status: STATUS.BAKING,
        ovenLayerId: layerId,
        bakingStartedAt: serverNow(),
      },
      request: () => crewApi.place(order.id, layerId).then((r) => r.order),
      alreadyDone: (x) => x.status === STATUS.BAKING,
    });
  };

  return (
    <>
      {list.length === 0 ? (
        <EmptyState emoji="⏳">
          <p>No pizzas waiting for the oven.</p>
        </EmptyState>
      ) : (
        <div className={`board${stale ? ' board-stale' : ''}`}>
          {list.map((o) => (
            <PizzaCard
              key={o.id}
              order={o}
              footer={<span>waiting {elapsed(o.queuedAt ?? o.createdAt, now)}</span>}
              onClick={() => setPlacing(o)}
            />
          ))}
        </div>
      )}

      {placing ? (
        <Modal
          title={`Put #${placing.id} in the oven`}
          onClose={() => setPlacing(null)}
          actions={
            <button type="button" className="btn" onClick={() => setPlacing(null)}>
              Cancel
            </button>
          }
        >
          <p className="muted" style={{ marginTop: -6 }}>
            {placing.customerName} · {placing.pizzaTypeName}
          </p>
          <div className="stack">
            {/* ALWAYS first, so having no layers configured can never block the oven. */}
            <button
              type="button"
              className="btn btn-primary btn-lg btn-block"
              onClick={() => place(placing, null)}
            >
              Unplaced — start the timer now
            </button>
            {(state?.layers ?? []).map((l) => (
              <button
                key={l.id}
                type="button"
                className="btn btn-lg btn-block"
                onClick={() => place(placing, l.id)}
              >
                {l.name}
              </button>
            ))}
          </div>
          <div className="hint">
            You can drag it to the right deck on the oven screen afterwards — the timer keeps
            running either way.
          </div>
        </Modal>
      ) : null}
    </>
  );
}
