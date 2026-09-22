import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ApiError, publicApi } from '../api.ts';
import { addMyOrder, newClientRequestId } from '../myOrders.ts';
import type { PublicConfig } from '../../../shared/types.ts';

export default function NewOrder() {
  const navigate = useNavigate();
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [name, setName] = useState('');
  const [typeId, setTypeId] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // ONE id per form fill. A double-tapped Submit on bad wifi then returns the SAME order
  // rather than making a second pizza - which is also what makes a retry safe.
  const requestId = useRef(newClientRequestId());

  useEffect(() => {
    publicApi
      .config()
      .then(setConfig)
      .catch(() => setLoadError(true));
  }, []);

  if (loadError) {
    return (
      <div className="page">
        <Brand />
        <div className="banner banner-error">
          Could not reach the kitchen. Check you are on the right Wi-Fi, then reload.
        </div>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="page">
        <Brand />
        <p className="muted">Loading the menu…</p>
      </div>
    );
  }

  if (!config.ordersOpen) {
    return (
      <div className="page">
        <Brand />
        <div className="banner banner-warn">
          <strong>Orders are closed for tonight.</strong>
          <div className="small">Come and talk to the crew — they may still be able to help.</div>
        </div>
        <p style={{ marginTop: 16 }}>
          <Link className="link" to="/">
            ← Back to my orders
          </Link>
        </p>
      </div>
    );
  }

  const selectable = config.pizzaTypes.filter((t) => !t.soldOut);
  const canSubmit = name.trim().length > 0 && typeId !== null && !busy;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || typeId === null) return;
    setBusy(true);
    setError('');
    try {
      const { order } = await publicApi.createOrder({
        customerName: name.trim(),
        pizzaTypeId: typeId,
        note: note.trim(),
        clientRequestId: requestId.current,
      });
      addMyOrder({
        token: order.publicToken,
        name: order.customerName,
        typeName: order.pizzaTypeName,
        createdAt: order.createdAt,
      });
      navigate(`/order/${order.publicToken}?new=1`, { replace: true });
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError) {
        setError(err.message);
        // The menu may have changed under us - sold out, or retired.
        if (err.code === 'sold_out' || err.code === 'unknown_type' || err.code === 'orders_closed') {
          publicApi.config().then(setConfig).catch(() => {});
          setTypeId(null);
        }
        return;
      }
      setError('Could not reach the kitchen. Tap Submit again — you will not get two pizzas.');
    }
  };

  return (
    <div className="page">
      <Brand />
      <h1>Order a pizza</h1>
      <p className="muted" style={{ marginTop: -4 }}>
        No account needed. Pay in cash at the counter when you arrive.
      </p>

      <form className="stack" onSubmit={submit} style={{ marginTop: 18 }}>
        <div>
          <span className="field" style={{ display: 'block', fontWeight: 650, marginBottom: 8 }}>
            Which pizza?
          </span>
          <div className="choices">
            {config.pizzaTypes.map((t) => (
              <label key={t.id} className={`choice${t.soldOut ? ' sold-out' : ''}`}>
                <input
                  type="radio"
                  name="pizzaType"
                  value={t.id}
                  disabled={t.soldOut}
                  checked={typeId === t.id}
                  onChange={() => setTypeId(t.id)}
                />
                <span className="choice-emoji" aria-hidden="true">
                  {t.emoji}
                </span>
                <span>
                  <span className="choice-name">{t.name}</span>
                  {t.soldOut ? <span className="sold-out-tag"> · sold out</span> : null}
                  {t.ingredients.length > 0 ? (
                    <span className="choice-ing" style={{ display: 'block' }}>
                      {t.ingredients.join(', ')}
                    </span>
                  ) : null}
                </span>
              </label>
            ))}
          </div>
          {selectable.length === 0 ? (
            <div className="banner banner-warn" style={{ marginTop: 10 }}>
              Everything is sold out right now.
            </div>
          ) : null}
        </div>

        <div>
          <label className="field" htmlFor="name">
            Your name
          </label>
          <input
            id="name"
            className="input"
            value={name}
            maxLength={60}
            autoComplete="name"
            placeholder="The name we will call out"
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div>
          <label className="field" htmlFor="note">
            Anything else? <span className="muted">(optional)</span>
          </label>
          <textarea
            id="note"
            className="textarea"
            value={note}
            maxLength={280}
            placeholder="e.g. no onions, extra crispy, nut allergy"
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="counter">{note.length}/280</div>
        </div>

        {error ? <div className="banner banner-error">{error}</div> : null}

        <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={!canSubmit}>
          {busy ? 'Sending…' : 'Place order'}
        </button>
        <Link className="btn btn-ghost btn-block" to="/">
          Cancel
        </Link>
      </form>
    </div>
  );
}

export function Brand() {
  return (
    <Link to="/" className="brand" style={{ textDecoration: 'none', color: 'inherit' }}>
      <span className="brand-mark">🍕</span>
      <span>
        <span className="brand-name" style={{ display: 'block' }}>
          Pizza Night
        </span>
        <span className="brand-sub">order ahead, pay at the counter</span>
      </span>
    </Link>
  );
}
