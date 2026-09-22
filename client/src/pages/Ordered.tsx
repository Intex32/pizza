import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { crewApi, serverNow } from '../api.ts';
import { useLive } from '../live.tsx';
import { useFocusCard, useFocusedOrderId } from '../useFocusOrder.ts';
import { EmptyState, Modal, NoteBadge } from '../components.tsx';
import { STATUS } from '../../../shared/status.ts';
import {
  PAYMENT_EMOJI,
  PAYMENT_HINT,
  PAYMENT_LABEL,
  PAYMENT_METHODS,
} from '../../../shared/payment.ts';
import type { PaymentMethod } from '../../../shared/payment.ts';
import type { Order, PizzaType } from '../../../shared/types.ts';

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
  const focusId = useFocusedOrderId();
  const [walkIn, setWalkIn] = useState(false);
  const [payFor, setPayFor] = useState<Order | null>(null);
  const [noShowFor, setNoShowFor] = useState<Order | null>(null);

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

  // A scan means "show me this one", so a search term still sitting in the box - which would
  // filter the scanned order straight back out of `shown` - is cleared rather than worked
  // around. Surgically force-including it would leave the crew looking at a filtered list
  // with one inexplicable extra row in it.
  useEffect(() => {
    if (focusId !== null) setQuery('');
  }, [focusId]);

  /** The counter's whole job in one step: record how they paid, and send it to the kitchen. */
  const takePayment = (o: Order, method: PaymentMethod) => {
    setPayFor(null);
    void mutateOrder({
      id: o.id,
      patch: {
        status: STATUS.IN_PREPARATION,
        paidAt: o.paidAt ?? serverNow(),
        paymentMethod: method,
      },
      request: () =>
        crewApi
          .transition(o.id, STATUS.ORDERED, STATUS.IN_PREPARATION, method)
          .then((r) => r.order),
      alreadyDone: (x) => x.status === STATUS.IN_PREPARATION,
      undo: {
        text: `#${o.id} ${o.customerName} → preparation (${PAYMENT_LABEL[method]})`,
        label: 'Undo',
        run: () =>
          crewApi.transition(o.id, STATUS.IN_PREPARATION, STATUS.ORDERED).then((r) => r.order),
      },
    });
  };

  const cancel = (o: Order) => {
    setNoShowFor(null);
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

  const sellableTypes = (state?.pizzaTypes ?? []).filter(
    (t) => t.archivedAt === null && !t.soldOut,
  );

  return (
    <div className="maxw">
      <div className="row wrap" style={{ marginBottom: 12 }}>
        {/* Deliberately NOT autoFocus. This fires on screen mount, and on a phone or a
            counter tablet that throws the on-screen keyboard up over the very list the
            crew opened the screen to read - before anyone has asked to search anything.
            The other autoFocus attributes in this app are all inside dialogs someone
            opened in order to type; this one was not. */}
        <input
          className="input search"
          style={{ flex: 1, minWidth: 200 }}
          placeholder="Search by name…"
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
            <OrderRow
              key={o.id}
              order={o}
              focusId={focusId}
              onPay={() => setPayFor(o)}
              onCancel={() => setNoShowFor(o)}
            />
          ))}
        </div>
      )}

      {payFor ? (
        <PaymentModal
          order={payFor}
          onClose={() => setPayFor(null)}
          onChoose={(m) => takePayment(payFor, m)}
        />
      ) : null}

      {noShowFor ? (
        <Modal
          title="Mark as a no-show?"
          onClose={() => setNoShowFor(null)}
          actions={
            <>
              <button type="button" className="btn" onClick={() => setNoShowFor(null)}>
                Keep waiting
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => cancel(noShowFor)}
              >
                Yes, no-show
              </button>
            </>
          }
        >
          <p>
            <span aria-hidden="true">{noShowFor.pizzaTypeEmoji} </span>
            <strong>
              #{noShowFor.id} {noShowFor.customerName}
            </strong>{' '}
            · {noShowFor.pizzaTypeName}
          </p>
          <p className="small muted">
            It comes off this screen but is not deleted — you can put it back from the admin
            screen, or with the Undo button on the toast.
          </p>
        </Modal>
      ) : null}

      {walkIn ? (
        <WalkInSheet
          onClose={() => setWalkIn(false)}
          onCreated={(order) => pushToast(`Walk-in created — #${order.id} ${order.customerName}`)}
          run={run}
          types={sellableTypes}
        />
      ) : null}
    </div>
  );
}

/** Three ways to have paid, one tap each. No default is pre-selected: the crew member has
 *  to say which, because guessing would silently corrupt the end-of-night reckoning. */
function PaymentModal({
  order,
  onClose,
  onChoose,
}: {
  order: Order;
  onClose: () => void;
  onChoose: (method: PaymentMethod) => void;
}) {
  return (
    <Modal
      title={`How did #${order.id} pay?`}
      onClose={onClose}
      actions={
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
      }
    >
      <p className="muted" style={{ marginTop: -6 }}>
        <span aria-hidden="true">{order.pizzaTypeEmoji} </span>
        <strong>{order.customerName}</strong> · {order.pizzaTypeName}
      </p>
      <div className="stack">
        {PAYMENT_METHODS.map((m) => (
          <button
            key={m}
            type="button"
            className="btn btn-lg btn-block pay-option"
            onClick={() => onChoose(m)}
          >
            <span className="pay-emoji" aria-hidden="true">
              {PAYMENT_EMOJI[m]}
            </span>
            <span className="pay-text">
              <span className="pay-label">{PAYMENT_LABEL[m]}</span>
              <span className="pay-hint">{PAYMENT_HINT[m]}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="hint">This goes on the order and shows up on the admin screen.</div>
    </Modal>
  );
}

function OrderRow({
  order,
  focusId,
  onPay,
  onCancel,
}: {
  order: Order;
  focusId: number | null;
  onPay: () => void;
  onCancel: () => void;
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
          {order.pizzaTypeName} · ordered {whenLabel(order.createdAt)}
          {p?.failed ? ' · NOT SAVED' : ''}
        </div>
        <NoteBadge note={order.note} />
      </div>
      <div className="orow-actions">
        <button type="button" className="btn btn-ghost btn-sm" disabled={locked} onClick={onCancel}>
          No-show
        </button>
        <button type="button" className="btn btn-ok btn-advance" disabled={locked} onClick={onPay}>
          MOVE TO PREP
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
  types: PizzaType[];
}) {
  const [name, setName] = useState('');
  const [typeId, setTypeId] = useState<number | null>(types[0]?.id ?? null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Order | null>(null);

  const submit = async (paymentMethod: PaymentMethod) => {
    if (!name.trim() || typeId === null || busy) return;
    setBusy(true);
    let made: Order | null = null;
    const okResult = await run(async () => {
      // Deliberately does NOT write to localStorage: a wall tablet must never accumulate
      // strangers' order tokens on its own customer home screen.
      const res = await crewApi.walkIn({
        customerName: name.trim(),
        pizzaTypeId: typeId,
        note: note.trim(),
        paymentMethod,
      });
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
          <div style={{ fontSize: '2.6rem', lineHeight: 1 }} aria-hidden="true">
            {created.pizzaTypeEmoji}
          </div>
          <div className="order-no">
            <span className="hash">#</span>
            {created.id}
          </div>
          <p style={{ fontSize: '1.2rem', fontWeight: 700, margin: '6px 0 2px' }}>
            {created.customerName}
          </p>
          <p className="muted">{created.pizzaTypeName}</p>
          <p className="small muted">
            {created.paymentMethod ? PAYMENT_LABEL[created.paymentMethod] : 'Paid'} · sent to
            preparation.
          </p>
        </div>
      </Modal>
    );
  }

  const ready = Boolean(name.trim()) && typeId !== null && !busy;

  return (
    <Modal
      title="New walk-in order"
      onClose={onClose}
      actions={
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
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
                  <span className="choice-emoji" aria-hidden="true">
                    {t.emoji}
                  </span>
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

        {/* Creating and paying are one moment at the counter, so the payment buttons ARE
            the submit buttons - one tap rather than two. */}
        <div>
          <span className="field" style={{ display: 'block', fontWeight: 650, marginBottom: 6 }}>
            How are they paying?
          </span>
          <div className="stack">
            {PAYMENT_METHODS.map((m) => (
              <button
                key={m}
                type="button"
                className="btn btn-lg btn-block pay-option"
                disabled={!ready}
                onClick={() => void submit(m)}
              >
                <span className="pay-emoji" aria-hidden="true">
                  {PAYMENT_EMOJI[m]}
                </span>
                <span className="pay-text">
                  <span className="pay-label">{busy ? 'Adding…' : PAYMENT_LABEL[m]}</span>
                  <span className="pay-hint">{PAYMENT_HINT[m]}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
