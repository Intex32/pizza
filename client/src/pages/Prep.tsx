import { useMemo } from 'react';
import { crewApi, serverNow } from '../api.ts';
import { useLive } from '../live.tsx';
import { EmptyState, PizzaCard, useBoardStale } from '../components.tsx';
import { useWakeLock } from '../useWakeLock.ts';
import { useNow, elapsed } from '../useNow.ts';
import { STATUS } from '../../../shared/status.ts';

export default function Prep() {
  useWakeLock();
  const now = useNow(1000);
  const stale = useBoardStale();
  const { orders, mutateOrder } = useLive();

  // Oldest first: whoever has been waiting longest gets made next.
  const list = useMemo(
    () =>
      orders
        .filter((o) => o.cancelledAt === null && o.status === STATUS.IN_PREPARATION)
        .sort((a, b) => a.createdAt - b.createdAt),
    [orders],
  );

  if (list.length === 0) {
    return (
      <EmptyState emoji="🧑‍🍳">
        <p>Nothing to prepare right now.</p>
        <p className="small">Pizzas appear here the moment the counter takes payment.</p>
      </EmptyState>
    );
  }

  return (
    <div className={`board${stale ? ' board-stale' : ''}`}>
      {list.map((o) => (
        <PizzaCard
          key={o.id}
          order={o}
          footer={<span>waiting {elapsed(o.paidAt ?? o.createdAt, now)}</span>}
          onClick={() =>
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
            })
          }
        />
      ))}
    </div>
  );
}
