import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { crewApi, serverNow } from '../api.ts';
import { useLive } from '../live.tsx';
import { EmptyState, Modal, NoteBadge } from '../components.tsx';
import { STATUS } from '../../../shared/status.ts';
import type { Order } from '../../../shared/types.ts';

export function whenLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return sameDay ? time : `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`;
}

export default function Ordered() {
  const { orders, state, mutateOrder, run, pushToast } = useLive();
  const [query, setQuery] = useState('');
  const [walkIn, setWalkIn] = useState(false);

  const waiting = useMemo(
    () => orders.filter((o) => o.cancelledAt === null && o.status === STATUS.ORDERED),
    [orders],
  );

  const cancelledCount = useMemo(
    () => orders.filter((o) => o.cancelledAt !== null && o.status === STATUS.ORDERED).length,
    [orders],
  );

  const shown = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    const filtered = q
      ? waiting.filter(
          (o) =>
            o.customerName.toLocaleLowerCase().includes(q) ||
            o.pizzaTypeName.toLocaleLowerCase().includes(q) ||
            String(o.id) === q.replace('#', ''),
        )
      : waiting;
    // Sorted by NAME, not time: the access pattern is always "find the human standing in
    // front of me". localeCompare so Müller sorts where a German speaker expects.
    return [...filtered].sort((a, b) => a.customerName.localeCompare(b.customerName));
  }, [waiting, query]);

  const toPrep = (o: Order) => {
    void mutateOrder({
      id: o.id,
      patch: { status: STATUS.IN_PREPARATION, paidAt: o.paidAt ?? serverNow() },
      request: () => crewApi.transition(o.id, STATUS.ORDERED, STATUS.IN_PREPARATION).then((r) => r.order),
      alreadyDone: (x) => x.status === STATUS.IN_PREPARATION,
      undo: {
        text: `#${o.id} ${o.customerName} → preparation`,
        label: 'Undo',
        run: () =>
          crewApi.transition(o.id, STATUS.IN_PREPARATION, STATUS.ORDERED).then((r) => r.order),
      },
    });
  };

  const cancel = (o: Order) => {
    void mutateOrder({
      id: o.id,
      patch: { cancelledAt: serverNow(), cancelReason: 'no-show' },
      request: () => crewApi.cancel(o.id, 'no-show').then((r) => r.order),
      alreadyDone: (x) => x.cancelledAt !== null,
      undo: {
        text: `#${o.id} ${o.customerName} marked no-show`,
        label: 'Undo',
        run: () => crewApi.uncancel(o.id).then((r) => r.order),
      },
    });
  };

  return (
    <div className="maxw">
      <div className="row wrap" style={{ marginBottom: 12 }}>
        <input
          className="input search"
          style={{ flex: 1, minWidth: 220 }}
          placeholder="Search by name…"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query ? (
          <button type="button" className="btn" onClick={() => setQuery('')}>
            Clear
          </button>
        ) : null}
        <button type="button" className="btn btn-primary" onClick={() => setWalkIn(true)}>
          + Walk-in
        </button>
      </div>

      <div className="row-between small muted" style={{ marginBottom: 10 }}>
        <span>
          {shown.length} of {waiting.length} waiting to pay
        </span>
        {cancelledCount > 0 ? (
          <Link className="link small" to="/crew/admin">
            {cancelledCount} cancelled
          </Link>
        ) : null}
      </div>

      {shown.length === 0 ? (
        <EmptyState emoji={waiting.length === 0 ? '🎉' : '🔍'}>
          {waiting.length === 0 ? (
            <p>Nobody is waiting to pay.</p>
          ) : (
            <p>No order matches “{query}”.</p>
          )}
        </EmptyState>
      ) : (
        <div className="olist">
          {shown.map((o) => (
            <OrderRow key={o.id} order={o} onPay={() => toPrep(o)} onCancel={() => cancel(o)} />
          ))}
        </div>
      )}

      {walkIn ? (
        <WalkInSheet
          onClose={() => setWalkIn(false)}
          onCreated={(order) => pushToast(`Walk-in created — #${order.id} ${order.customerName}`)}
          run={run}
          types={(state?.pizzaTypes ?? []).filter((t) => t.archivedAt === null && !t.soldOut)}
        />
      ) : null}
    </div>
  );
}

function OrderRow({
  order,
  onPay,
  onCancel,
}: {
  order: Order;
  onPay: () => void;
  onCancel: () => void;
}) {
  const { pending } = useLive();
  const p = pending[order.id];
  const locked = Boolean(p && !p.failed);

  return (
    <div
      className="orow"
      style={{
        opacity: locked ? 0.6 : 1,
        borderColor: p?.failed ? 'var(--warn)' : undefined,
      }}
    >
      <span className="orow-no">#{order.id}</span>
      <div className="orow-main">
        <div className="orow-name">{order.customerName}</div>
        <div className="orow-sub">
          {order.pizzaTypeName} · ordered {whenLabel(order.createdAt)}
          {p?.failed ? ' · NOT SAVED' : ''}
        </div>
        <NoteBadge note={order.note} />
      </div>
      <div className="orow-actions">
        <button type="button" className="btn btn-ghost btn-sm" disabled={locked} onClick={onCancel}>
          No-show
        </button>
        <button
          type="button"
          className="btn btn-ok"
          style={{ minHeight: 64, minWidth: 150, fontSize: '1.05rem' }}
          disabled={locked}
          onClick={onPay}
        >
          PAID → PREP
        </button>
      </div>
    </div>
  );
}

function WalkInSheet({
  onClose,
  onCreated,
  run,
  types,
}: {
  onClose: () => void;
  onCreated: (order: Order) => void;
  run: (fn: () => Promise<unknown>) => Promise<boolean>;
  types: { id: number; name: string; ingredients: string[] }[];
}) {
  const [name, setName] = useState('');
  const [typeId, setTypeId] = useState<number | null>(types[0]?.id ?? null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Order | null>(null);

  const submit = async () => {
    if (!name.trim() || typeId === null || busy) return;
    setBusy(true);
    let made: Order | null = null;
    const okResult = await run(async () => {
      // Deliberately does NOT write to localStorage: a wall tablet must never accumulate
      // strangers' order tokens on its own customer home screen.
      const res = await crewApi.walkIn({ customerName: name.trim(), pizzaTypeId: typeId, note: note.trim() });
      made = res.order;
      return res;
    });
    setBusy(false);
    if (okResult && made) {
      setCreated(made);
      onCreated(made);
    }
  };

  if (created) {
    return (
      <Modal
        title="Walk-in added"
        onClose={onClose}
        actions={
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        }
      >
        <div className="center">
          <div className="order-no">
            <span className="hash">#</span>
            {created.id}
          </div>
          <p style={{ fontSize: '1.2rem', fontWeight: 700, margin: '6px 0 2px' }}>
            {created.customerName}
          </p>
          <p className="muted">{created.pizzaTypeName}</p>
          <p className="small muted">Already marked paid and sent to preparation.</p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title="New walk-in order"
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !name.trim() || typeId === null}
            onClick={() => void submit()}
          >
            {busy ? 'Adding…' : 'Add (paid)'}
          </button>
        </>
      }
    >
      <div className="stack">
        <div>
          <label className="field" htmlFor="wname">
            Name
          </label>
          <input
            id="wname"
            className="input"
            autoFocus
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <span className="field" style={{ display: 'block', fontWeight: 650, marginBottom: 6 }}>
            Pizza
          </span>
          {types.length === 0 ? (
            <div className="banner banner-warn">
              Everything is sold out or retired. Fix that on the Menu screen first.
            </div>
          ) : (
            <div className="choices">
              {types.map((t) => (
                <label key={t.id} className="choice">
                  <input
                    type="radio"
                    name="walkInType"
                    checked={typeId === t.id}
                    onChange={() => setTypeId(t.id)}
                  />
                  <span>
                    <span className="choice-name">{t.name}</span>
                    {t.ingredients.length ? (
                      <span className="choice-ing" style={{ display: 'block' }}>
                        {t.ingredients.join(', ')}
                      </span>
                    ) : null}
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>
        <div>
          <label className="field" htmlFor="wnote">
            Note <span className="muted">(optional)</span>
          </label>
          <input
            id="wnote"
            className="input"
            maxLength={280}
            placeholder="allergies, no onions…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <div className="hint">Cash is taken now — this goes straight into preparation.</div>
      </div>
    </Modal>
  );
}
