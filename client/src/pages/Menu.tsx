import { useState } from 'react';
import { crewApi } from '../api.ts';
import { useLive } from '../live.tsx';
import { Modal, PizzaEmoji } from '../components.tsx';
import { mmss } from '../useNow.ts';
import { DEFAULT_PIZZA_EMOJI } from '../../../shared/payment.ts';
import type { PizzaType } from '../../../shared/types.ts';

/** Matches the oven screen, so one tap means the same thing everywhere. */
const BAKE_STEP_S = 15;

export default function Menu() {
  const { state, orders, run } = useLive();
  const [adding, setAdding] = useState(false);

  const types = state?.pizzaTypes ?? [];
  const live = types.filter((t) => t.archivedAt === null);
  const retired = types.filter((t) => t.archivedAt !== null);

  const usageCount = (id: number) => orders.filter((o) => o.pizzaTypeId === id).length;

  return (
    <div className="maxw">
      <div className="row-between wrap" style={{ marginBottom: 14 }}>
        <p className="muted" style={{ margin: 0 }}>
          Changes here show up on the customer page within a few seconds. Editing a pizza never
          changes an order someone already placed.
        </p>
        <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
          + Add pizza
        </button>
      </div>

      <div className="stack">
        {live.map((t, i) => (
          <TypeRow
            key={t.id}
            type={t}
            uses={usageCount(t.id)}
            canUp={i > 0}
            canDown={i < live.length - 1}
            onUp={() => void run(() => swap(live, i, i - 1))}
            onDown={() => void run(() => swap(live, i, i + 1))}
          />
        ))}
        {live.length === 0 ? (
          <div className="banner banner-warn">
            There are no pizzas on the menu, so nobody can order. Add one.
          </div>
        ) : null}
      </div>

      {retired.length > 0 ? (
        <div className="section" style={{ marginTop: 26 }}>
          <h2>
            Retired <span className="muted small">— hidden from customers, old orders untouched</span>
          </h2>
          <div className="stack">
            {retired.map((t) => (
              <div key={t.id} className="orow" style={{ opacity: 0.75 }}>
                <PizzaEmoji emoji={t.emoji} />
                <div className="orow-main">
                  <div className="orow-name" style={{ fontSize: '1.1rem' }}>
                    {t.name}
                  </div>
                  <div className="orow-sub">{t.ingredients.join(', ') || 'no ingredients listed'}</div>
                </div>
                <div className="orow-actions">
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => void run(() => crewApi.updateType(t.id, { archived: false }))}
                  >
                    Bring back
                  </button>
                  <DeleteTypeButton type={t} uses={usageCount(t.id)} />
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {adding ? <AddTypeModal onClose={() => setAdding(false)} /> : null}
    </div>
  );
}

function swap(list: PizzaType[], i: number, j: number) {
  return Promise.all([
    crewApi.updateType(list[i].id, { position: list[j].position }),
    crewApi.updateType(list[j].id, { position: list[i].position }),
  ]);
}

function TypeRow({
  type,
  uses,
  canUp,
  canDown,
  onUp,
  onDown,
}: {
  type: PizzaType;
  uses: number;
  canUp: boolean;
  canDown: boolean;
  onUp: () => void;
  onDown: () => void;
}) {
  const { run } = useLive();
  const [name, setName] = useState(type.name);
  const [emoji, setEmoji] = useState(type.emoji);
  const [ingredients, setIngredients] = useState(type.ingredients.join(', '));

  const saveName = () => {
    const v = name.trim();
    if (v && v !== type.name) void run(() => crewApi.updateType(type.id, { name: v }));
    else setName(type.name);
  };

  const saveEmoji = () => {
    const v = emoji.trim();
    if (v && v !== type.emoji) void run(() => crewApi.updateType(type.id, { emoji: v }));
    else setEmoji(type.emoji);
  };

  const saveIngredients = () => {
    const list = ingredients
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.join('|') !== type.ingredients.join('|')) {
      void run(() => crewApi.updateType(type.id, { ingredients: list }));
    }
  };

  const bump = (delta: number) => {
    const next = Math.min(3600, Math.max(30, type.bakeSeconds + delta));
    if (next !== type.bakeSeconds) void run(() => crewApi.updateType(type.id, { bakeSeconds: next }));
  };

  return (
    <div className="card" style={{ opacity: type.soldOut ? 0.72 : 1 }}>
      <div className="row wrap" style={{ gap: 10, alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div className="row" style={{ gap: 8 }}>
            {/* The emoji is what the crew actually recognise at a glance on every other
                screen, so it is edited right next to the name rather than buried. */}
            <input
              className="input emoji-input"
              aria-label={`Emoji for ${type.name}`}
              value={emoji}
              maxLength={16}
              onChange={(e) => setEmoji(e.target.value)}
              onBlur={saveEmoji}
            />
            <input
              className="input"
              style={{ fontWeight: 700, fontSize: '1.1rem', flex: 1 }}
              value={name}
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
              onBlur={saveName}
            />
          </div>
          <input
            className="input"
            style={{ marginTop: 8 }}
            value={ingredients}
            placeholder="tomato sauce, mozzarella, basil"
            onChange={(e) => setIngredients(e.target.value)}
            onBlur={saveIngredients}
          />
          <div className="hint">
            Comma separated. Used for the shopping list on the admin screen.
            {uses > 0 ? ` · ${uses} order${uses === 1 ? '' : 's'} so far` : ''}
          </div>
        </div>

        <div style={{ minWidth: 170 }}>
          <span className="field" style={{ display: 'block', fontWeight: 650, marginBottom: 6 }}>
            Bake time
          </span>
          <div className="chipbar">
            <button type="button" className="chipbtn" onClick={() => bump(-BAKE_STEP_S)}>
              −15s
            </button>
            <span
              className="chipbtn"
              style={{ cursor: 'default', minWidth: 62, textAlign: 'center' }}
            >
              {mmss(type.bakeSeconds * 1000)}
            </span>
            <button type="button" className="chipbtn" onClick={() => bump(BAKE_STEP_S)}>
              +15s
            </button>
          </div>
        </div>
      </div>

      <div className="row wrap" style={{ marginTop: 12, gap: 8 }}>
        <button
          type="button"
          className={`btn btn-sm${type.soldOut ? ' btn-danger' : ''}`}
          onClick={() => void run(() => crewApi.updateType(type.id, { soldOut: !type.soldOut }))}
        >
          {type.soldOut ? '● Sold out' : 'Mark sold out'}
        </button>
        <span className="spacer" />
        <button type="button" className="btn btn-sm" disabled={!canUp} onClick={onUp}>
          ▲
        </button>
        <button type="button" className="btn btn-sm" disabled={!canDown} onClick={onDown}>
          ▼
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => void run(() => crewApi.updateType(type.id, { archived: true }))}
          title="Hide from the customer menu. Existing orders keep working."
        >
          Retire
        </button>
      </div>
    </div>
  );
}

/** Only ever offered for a type nothing references; the server refuses otherwise anyway. */
function DeleteTypeButton({ type, uses }: { type: PizzaType; uses: number }) {
  const { run, pushToast } = useLive();
  if (uses > 0) {
    return (
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        onClick={() =>
          pushToast(`${uses} order(s) use ${type.name}. Retired is as far as it goes.`, 'warn')
        }
      >
        Delete
      </button>
    );
  }
  return (
    <button
      type="button"
      className="btn btn-sm btn-danger"
      onClick={() => void run(() => crewApi.deleteType(type.id))}
    >
      Delete
    </button>
  );
}

function AddTypeModal({ onClose }: { onClose: () => void }) {
  const { run } = useLive();
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState(DEFAULT_PIZZA_EMOJI);
  const [ingredients, setIngredients] = useState('');
  const [bakeSeconds, setBakeSeconds] = useState(300);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    const ok = await run(() =>
      crewApi.createType({
        name: name.trim(),
        emoji: emoji.trim() || DEFAULT_PIZZA_EMOJI,
        ingredients: ingredients
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        bakeSeconds,
      }),
    );
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Modal
      title="Add a pizza"
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !name.trim()}
            onClick={() => void submit()}
          >
            {busy ? 'Adding…' : 'Add to menu'}
          </button>
        </>
      }
    >
      <div className="stack">
        <div>
          <label className="field" htmlFor="tname">
            Emoji and name
          </label>
          <div className="row" style={{ gap: 8 }}>
            <input
              className="input emoji-input"
              aria-label="Emoji"
              maxLength={16}
              value={emoji}
              onChange={(e) => setEmoji(e.target.value)}
            />
            <input
              id="tname"
              className="input"
              style={{ flex: 1 }}
              autoFocus
              maxLength={60}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="hint">
            The emoji shows on every crew screen — pick one you can tell apart at a glance.
          </div>
        </div>
        <div>
          <label className="field" htmlFor="ting">
            Ingredients
          </label>
          <input
            id="ting"
            className="input"
            placeholder="tomato sauce, mozzarella, basil"
            value={ingredients}
            onChange={(e) => setIngredients(e.target.value)}
          />
          <div className="hint">Comma separated. Feeds the shopping list.</div>
        </div>
        <div>
          <span className="field" style={{ display: 'block', fontWeight: 650, marginBottom: 6 }}>
            Bake time
          </span>
          <div className="chipbar">
            <button
              type="button"
              className="chipbtn"
              onClick={() => setBakeSeconds((s) => Math.max(30, s - BAKE_STEP_S))}
            >
              −15s
            </button>
            <span className="chipbtn" style={{ cursor: 'default', minWidth: 62, textAlign: 'center' }}>
              {mmss(bakeSeconds * 1000)}
            </span>
            <button
              type="button"
              className="chipbtn"
              onClick={() => setBakeSeconds((s) => Math.min(3600, s + BAKE_STEP_S))}
            >
              +15s
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
