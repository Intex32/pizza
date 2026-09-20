import { useEffect, useMemo, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import { crewApi, serverNow } from '../api.ts';
import { useLive } from '../live.tsx';
import { EmptyState, Modal, useBoardStale } from '../components.tsx';
import { useWakeLock } from '../useWakeLock.ts';
import { bakeState, elapsed, useNow } from '../useNow.ts';
import { audioReady, isMuted, maybeAlarm, setMuted, testSound, unlockAudio } from '../alarm.ts';
import { STATUS } from '../../../shared/status.ts';
import type { Order, OvenLayer } from '../../../shared/types.ts';

const VERY_LATE_MS = 60_000;
/** Below this the crew almost certainly meant to tap it, so no confirmation. */
const NO_CONFIRM_REMAINING_MS = 20_000;

type DropZone = { kind: 'layer'; id: number } | { kind: 'unplaced' };

function zoneId(z: DropZone): string {
  return z.kind === 'unplaced' ? 'zone-unplaced' : `zone-layer-${z.id}`;
}

function parseZone(id: string): DropZone | null {
  if (id === 'zone-unplaced') return { kind: 'unplaced' };
  const m = /^zone-layer-(\d+)$/.exec(id);
  return m ? { kind: 'layer', id: Number(m[1]) } : null;
}

export default function Oven() {
  useWakeLock();
  const now = useNow(500);
  const stale = useBoardStale();
  const { orders, state, mutateOrder, run } = useLive();

  const [selected, setSelected] = useState<number | null>(null);
  const [dragging, setDragging] = useState<Order | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmReady, setConfirmReady] = useState<Order | null>(null);
  const [confirmOut, setConfirmOut] = useState<Order | null>(null);
  const [muted, setMutedState] = useState(() => isMuted());

  const layers = state?.layers ?? [];

  const baking = useMemo(
    () => orders.filter((o) => o.cancelledAt === null && o.status === STATUS.BAKING),
    [orders],
  );
  const waiting = useMemo(
    () =>
      orders
        .filter((o) => o.cancelledAt === null && o.status === STATUS.WAITING_FOR_OVEN)
        .sort((a, b) => (a.queuedAt ?? a.createdAt) - (b.queuedAt ?? b.createdAt)),
    [orders],
  );

  // First in, first out - the only ordering the app can honestly claim to know.
  const sortBake = (list: Order[]) =>
    [...list].sort((a, b) => (a.bakingStartedAt ?? 0) - (b.bakingStartedAt ?? 0));

  const unplaced = sortBake(baking.filter((o) => o.ovenLayerId === null));
  const byLayer = new Map<number, Order[]>();
  for (const l of layers) byLayer.set(l.id, []);
  for (const o of baking) {
    if (o.ovenLayerId === null) continue;
    const bucket = byLayer.get(o.ovenLayerId);
    if (bucket) bucket.push(o);
    else unplaced.push(o); // layer vanished under us; never lose the pizza
  }

  const overdueCount = baking.filter(
    (o) => bakeState(o.bakingStartedAt, o.bakeSeconds, now).expired,
  ).length;

  useEffect(() => {
    maybeAlarm(overdueCount, Date.now());
  }, [overdueCount, now]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      // A short hold before a drag starts, so an ordinary tap stays a tap.
      activationConstraint: { delay: 180, tolerance: 8 },
    }),
  );

  const place = (order: Order, zone: DropZone) => {
    const layerId = zone.kind === 'unplaced' ? null : zone.id;
    setSelected(null);
    void mutateOrder({
      id: order.id,
      patch: {
        status: STATUS.BAKING,
        ovenLayerId: layerId,
        // Only guess a start time for a pizza that is not already baking; moving decks must
        // never look like a reset, even for the half second before the server replies.
        bakingStartedAt: order.status === STATUS.BAKING ? order.bakingStartedAt : serverNow(),
      },
      request: () => crewApi.place(order.id, layerId).then((r) => r.order),
      alreadyDone: (x) => x.status === STATUS.BAKING && x.ovenLayerId === layerId,
    });
  };

  const markReady = (order: Order) => {
    setConfirmReady(null);
    void mutateOrder({
      id: order.id,
      patch: { status: STATUS.READY, ovenLayerId: null, readyAt: serverNow() },
      request: () =>
        crewApi.transition(order.id, STATUS.BAKING, STATUS.READY).then((r) => r.order),
      alreadyDone: (x) => x.status === STATUS.READY,
      undo: {
        text: `#${order.id} ${order.customerName} is ready`,
        label: 'Undo',
        run: () => crewApi.place(order.id, order.ovenLayerId).then((r) => r.order),
      },
    });
  };

  const takeOut = (order: Order) => {
    setConfirmOut(null);
    void mutateOrder({
      id: order.id,
      patch: {
        status: STATUS.WAITING_FOR_OVEN,
        ovenLayerId: null,
        bakingStartedAt: null,
        bakeSeconds: null,
      },
      request: () =>
        crewApi
          .transition(order.id, STATUS.BAKING, STATUS.WAITING_FOR_OVEN)
          .then((r) => r.order),
      alreadyDone: (x) => x.status === STATUS.WAITING_FOR_OVEN,
    });
  };

  const onCardTap = (o: Order) => {
    if (o.status === STATUS.WAITING_FOR_OVEN) {
      setSelected((s) => (s === o.id ? null : o.id));
      return;
    }
    const t = bakeState(o.bakingStartedAt, o.bakeSeconds, now);
    // Expired is the hot path: one tap, no dialog, because that is the tap that saves a pizza.
    if (t.expired || !t.valid || t.remainingMs <= NO_CONFIRM_REMAINING_MS) markReady(o);
    else setConfirmReady(o);
  };

  const adjustBake = (o: Order, deltaS: number) => {
    const current = o.bakeSeconds ?? 300;
    const next = Math.min(3600, Math.max(30, current + deltaS));
    if (next === current) return;
    void mutateOrder({
      id: o.id,
      patch: { bakeSeconds: next },
      // ABSOLUTE, never relative: a "+30" sent twice by a flaky tap would silently add a minute.
      request: () => crewApi.setBake(o.id, next).then((r) => r.order),
      alreadyDone: (x) => x.bakeSeconds === next,
    });
  };

  const onDragStart = (e: DragStartEvent) => {
    const id = Number(String(e.active.id).replace('order-', ''));
    setDragging(orders.find((o) => o.id === id) ?? null);
  };

  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null);
    if (!e.over) return;
    const zone = parseZone(String(e.over.id));
    const id = Number(String(e.active.id).replace('order-', ''));
    const order = orders.find((o) => o.id === id);
    if (zone && order) place(order, zone);
  };

  const selectedOrder = selected === null ? null : orders.find((o) => o.id === selected) ?? null;

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
      <div className={`oven${stale ? ' board-stale' : ''}`}>
        <div className="row wrap" style={{ flex: 'none', gap: 8 }}>
          <button
            type="button"
            className={`btn btn-sm${editing ? ' btn-primary' : ''}`}
            onClick={() => {
              setEditing((v) => !v);
              setSelected(null);
            }}
          >
            {editing ? '✓ Done editing' : '✎ Edit layout'}
          </button>
          {editing ? (
            <span className="small muted">Dragging pizzas is off while you edit the layout.</span>
          ) : null}
          <span className="spacer" />
          {!audioReady() && !muted ? (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                unlockAudio();
                testSound();
                setMutedState(isMuted());
              }}
            >
              🔇 Tap to enable sound
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => {
                const next = !muted;
                setMuted(next);
                setMutedState(next);
                if (!next) {
                  unlockAudio();
                  testSound();
                }
              }}
            >
              {muted ? '🔇 Sound off' : '🔔 Sound on'}
            </button>
          )}
        </div>

        <div className="oven-trays">
          <Tray
            title={`Waiting for oven (${waiting.length})`}
            zone={null}
            empty="Nothing queued"
          >
            {waiting.map((o) => (
              <OvenCard
                key={o.id}
                order={o}
                now={now}
                selected={selected === o.id}
                draggable={!editing}
                onTap={() => onCardTap(o)}
                footer={<span>waiting {elapsed(o.queuedAt ?? o.createdAt, now)}</span>}
              />
            ))}
          </Tray>

          <Tray
            title={`Unplaced (${unplaced.length})`}
            zone={{ kind: 'unplaced' }}
            empty="Baking pizzas with no recorded deck land here"
            placeHere={selectedOrder ? () => place(selectedOrder, { kind: 'unplaced' }) : null}
          >
            {unplaced.map((o) => (
              <OvenCard
                key={o.id}
                order={o}
                now={now}
                selected={selected === o.id}
                draggable={!editing}
                onTap={() => onCardTap(o)}
                onMove={() => setSelected((s) => (s === o.id ? null : o.id))}
                onAdjust={(d) => adjustBake(o, d)}
                onTakeOut={() => setConfirmOut(o)}
              />
            ))}
          </Tray>
        </div>

        <div className="oven-decks">
          {layers.length === 0 ? (
            <div className="deck">
              <EmptyState emoji="🔥">
                <p>No oven layers yet.</p>
                <p className="small">
                  Tap <strong>Edit layout</strong> to add a deck. Pizzas can bake in the Unplaced
                  tray in the meantime.
                </p>
              </EmptyState>
            </div>
          ) : (
            layers.map((layer) => (
              <Deck
                key={layer.id}
                layer={layer}
                orders={sortBake(byLayer.get(layer.id) ?? [])}
                now={now}
                editing={editing}
                selected={selected}
                onPlaceHere={selectedOrder ? () => place(selectedOrder, { kind: 'layer', id: layer.id }) : null}
                onTap={onCardTap}
                onMove={(o) => setSelected((s) => (s === o.id ? null : o.id))}
                onAdjust={adjustBake}
                onTakeOut={(o) => setConfirmOut(o)}
                onRename={(name) => void run(() => crewApi.updateLayer(layer.id, { name }))}
                onCapacity={(capacity) => void run(() => crewApi.updateLayer(layer.id, { capacity }))}
                onMoveUp={
                  layers.indexOf(layer) === 0
                    ? null
                    : () => void run(() => reorder(layers, layer, -1))
                }
                onMoveDown={
                  layers.indexOf(layer) === layers.length - 1
                    ? null
                    : () => void run(() => reorder(layers, layer, +1))
                }
                occupants={(byLayer.get(layer.id) ?? []).length}
              />
            ))
          )}

          {editing ? (
            <button
              type="button"
              className="btn btn-primary"
              style={{ flex: 'none' }}
              onClick={() => {
                const name = window.prompt('Name for the new layer', `Deck ${layers.length + 1}`);
                if (name?.trim()) void run(() => crewApi.createLayer(name.trim(), 4));
              }}
            >
              + Add layer
            </button>
          ) : null}
        </div>

        {selectedOrder ? (
          <div className="banner banner-info" style={{ flex: 'none', padding: 10 }}>
            <div className="row-between">
              <span>
                <strong>
                  #{selectedOrder.id} {selectedOrder.customerName}
                </strong>{' '}
                selected — tap a deck to place it.
              </span>
              <button type="button" className="btn btn-sm" onClick={() => setSelected(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <DragOverlay dropAnimation={null}>
        {dragging ? (
          <div className="pcard drag-overlay" style={{ width: 190 }}>
            <span className="pcard-no">#{dragging.id}</span>
            <span className="pcard-name">{dragging.customerName}</span>
            <span className="pcard-type">{dragging.pizzaTypeName}</span>
          </div>
        ) : null}
      </DragOverlay>

      {confirmReady ? (
        <Modal
          title="Take it out already?"
          onClose={() => setConfirmReady(null)}
          actions={
            <>
              <button type="button" className="btn" onClick={() => setConfirmReady(null)}>
                Leave it in
              </button>
              <button
                type="button"
                className="btn btn-ok"
                onClick={() => markReady(confirmReady)}
              >
                Yes, it’s ready
              </button>
            </>
          }
        >
          <p>
            #{confirmReady.id} {confirmReady.customerName} still has{' '}
            <strong>{bakeState(confirmReady.bakingStartedAt, confirmReady.bakeSeconds, now).label}</strong>{' '}
            left.
          </p>
        </Modal>
      ) : null}

      {confirmOut ? (
        <Modal
          title="Take this pizza out of the oven?"
          onClose={() => setConfirmOut(null)}
          actions={
            <>
              <button type="button" className="btn" onClick={() => setConfirmOut(null)}>
                Keep baking
              </button>
              <button type="button" className="btn btn-danger" onClick={() => takeOut(confirmOut)}>
                Take it out
              </button>
            </>
          }
        >
          <p>
            #{confirmOut.id} {confirmOut.customerName} goes back to the oven queue and its{' '}
            <strong>{bakeState(confirmOut.bakingStartedAt, confirmOut.bakeSeconds, now).label}</strong>{' '}
            timer is cleared. It restarts from zero when you put it back in.
          </p>
        </Modal>
      ) : null}
    </DndContext>
  );
}

function reorder(layers: OvenLayer[], layer: OvenLayer, delta: number) {
  const i = layers.indexOf(layer);
  const j = i + delta;
  const other = layers[j];
  return Promise.all([
    crewApi.updateLayer(layer.id, { position: other.position }),
    crewApi.updateLayer(other.id, { position: layer.position }),
  ]);
}

// --- Trays and decks ---------------------------------------------------------------------------

function Tray({
  title,
  zone,
  empty,
  children,
  placeHere,
}: {
  title: string;
  zone: DropZone | null;
  empty: string;
  children: React.ReactNode;
  placeHere?: (() => void) | null;
}) {
  const droppable = useDroppable({ id: zone ? zoneId(zone) : 'zone-none', disabled: !zone });
  const count = Array.isArray(children) ? children.length : children ? 1 : 0;

  return (
    <div
      ref={zone ? droppable.setNodeRef : undefined}
      className={`tray${zone && droppable.isOver ? ' drop-target' : ''}`}
    >
      <div className="tray-head">
        <span className="tray-title">{title}</span>
      </div>
      <div className="slot-row">
        {count === 0 ? <span className="small muted">{empty}</span> : children}
        {placeHere ? (
          <button type="button" className="place-here" onClick={placeHere}>
            ▸ PLACE HERE
          </button>
        ) : null}
      </div>
    </div>
  );
}

function Deck({
  layer,
  orders,
  now,
  editing,
  selected,
  occupants,
  onPlaceHere,
  onTap,
  onMove,
  onAdjust,
  onTakeOut,
  onRename,
  onCapacity,
  onMoveUp,
  onMoveDown,
}: {
  layer: OvenLayer;
  orders: Order[];
  now: number;
  editing: boolean;
  selected: number | null;
  occupants: number;
  onPlaceHere: (() => void) | null;
  onTap: (o: Order) => void;
  onMove: (o: Order) => void;
  onAdjust: (o: Order, delta: number) => void;
  onTakeOut: (o: Order) => void;
  onRename: (name: string) => void;
  onCapacity: (capacity: number) => void;
  onMoveUp: (() => void) | null;
  onMoveDown: (() => void) | null;
}) {
  const { run } = useLive();
  const droppable = useDroppable({ id: zoneId({ kind: 'layer', id: layer.id }) });
  const [deleting, setDeleting] = useState(false);
  const over = occupants > layer.capacity;

  return (
    <div
      ref={droppable.setNodeRef}
      className={`deck${droppable.isOver ? ' drop-target' : ''}`}
    >
      <div className="deck-head">
        {editing ? (
          <input
            className="input"
            style={{ maxWidth: 220, minHeight: 42 }}
            defaultValue={layer.name}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v && v !== layer.name) onRename(v);
            }}
          />
        ) : (
          <span className="deck-title">{layer.name}</span>
        )}
        <span className={`cap${over ? ' over' : ''}`}>
          {occupants} / {layer.capacity}
        </span>
        <span className="spacer" />
        {editing ? (
          <div className="chipbar">
            <button
              type="button"
              className="chipbtn"
              disabled={layer.capacity <= 1}
              onClick={() => onCapacity(layer.capacity - 1)}
            >
              −
            </button>
            <button
              type="button"
              className="chipbtn"
              disabled={layer.capacity >= 12}
              onClick={() => onCapacity(layer.capacity + 1)}
            >
              +
            </button>
            <button type="button" className="chipbtn" disabled={!onMoveUp} onClick={() => onMoveUp?.()}>
              ▲
            </button>
            <button
              type="button"
              className="chipbtn"
              disabled={!onMoveDown}
              onClick={() => onMoveDown?.()}
            >
              ▼
            </button>
            <button
              type="button"
              className="chipbtn"
              style={{ color: 'var(--danger)' }}
              onClick={() => setDeleting(true)}
            >
              Delete
            </button>
          </div>
        ) : null}
      </div>

      <div className="slot-row">
        {orders.length === 0 && !onPlaceHere ? (
          <span className="small muted">Empty</span>
        ) : null}
        {orders.map((o) => (
          <OvenCard
            key={o.id}
            order={o}
            now={now}
            selected={selected === o.id}
            draggable={!editing}
            onTap={() => onTap(o)}
            onMove={() => onMove(o)}
            onAdjust={(d) => onAdjust(o, d)}
            onTakeOut={() => onTakeOut(o)}
          />
        ))}
        {onPlaceHere ? (
          <button type="button" className="place-here" onClick={onPlaceHere}>
            ▸ PLACE HERE
          </button>
        ) : null}
      </div>

      {deleting ? (
        <DeleteLayerModal
          layer={layer}
          occupants={occupants}
          onClose={() => setDeleting(false)}
          onDelete={async (moveTo) => {
            setDeleting(false);
            await run(() => crewApi.deleteLayer(layer.id, moveTo));
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * The rehoming heuristic IS this dialog. The person deleting the layer is the only one who
 * knows where those pizzas physically went, and they are standing at the oven - so they
 * choose, rather than the app inventing a plausible lie. Timers keep running either way.
 */
function DeleteLayerModal({
  layer,
  occupants,
  onClose,
  onDelete,
}: {
  layer: OvenLayer;
  occupants: number;
  onClose: () => void;
  onDelete: (moveTo: number | 'unplaced') => void;
}) {
  const { state } = useLive();
  const others = (state?.layers ?? []).filter((l) => l.id !== layer.id);
  const [dest, setDest] = useState<string>('unplaced');

  return (
    <Modal
      title={`Delete “${layer.name}”?`}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Keep it
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => onDelete(dest === 'unplaced' ? 'unplaced' : Number(dest))}
          >
            Delete layer
          </button>
        </>
      }
    >
      {occupants > 0 ? (
        <>
          <p>
            It still holds <strong>{occupants}</strong> baking pizza{occupants === 1 ? '' : 's'}.
            They move to:
          </p>
          <select className="select" value={dest} onChange={(e) => setDest(e.target.value)}>
            <option value="unplaced">Unplaced tray</option>
            {others.map((l) => (
              <option key={l.id} value={String(l.id)}>
                {l.name}
              </option>
            ))}
          </select>
          <p className="hint">Their timers keep running. Nothing is deleted except the layer.</p>
        </>
      ) : (
        <p>It is empty, so nothing moves.</p>
      )}
    </Modal>
  );
}

// --- Card -------------------------------------------------------------------------------------

function OvenCard({
  order,
  now,
  selected,
  draggable,
  onTap,
  onMove,
  onAdjust,
  onTakeOut,
  footer,
}: {
  order: Order;
  now: number;
  selected: boolean;
  draggable: boolean;
  onTap: () => void;
  onMove?: () => void;
  onAdjust?: (delta: number) => void;
  onTakeOut?: () => void;
  footer?: React.ReactNode;
}) {
  const { pending } = useLive();
  const p = pending[order.id];
  const t = bakeState(order.bakingStartedAt, order.bakeSeconds, now);
  const isBaking = order.status === STATUS.BAKING;

  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `order-${order.id}`,
    disabled: !draggable,
  });

  const cls = [
    'pcard',
    draggable ? 'draggable' : '',
    selected ? 'selected' : '',
    p && !p.failed ? 'pending' : '',
    p && p.failed ? 'failed' : '',
    isBaking && t.expired ? 'expired' : '',
    isBaking && t.expired && -t.remainingMs > VERY_LATE_MS ? 'very-late' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      ref={setNodeRef}
      className={cls}
      style={{ visibility: isDragging ? 'hidden' : undefined }}
      onClick={onTap}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onTap();
        }
      }}
      // dnd-kit's attributes supply role="button" and tabIndex; ours would be overwritten.
      {...attributes}
      {...listeners}
    >
      {p?.failed ? <span className="badge-unsaved">not saved</span> : null}
      <span className="pcard-no">#{order.id}</span>
      <span className="pcard-name">{order.customerName}</span>
      <span className="pcard-type">{order.pizzaTypeName}</span>
      {order.note.trim() ? <span className="note">{order.note}</span> : null}

      {isBaking ? (
        <>
          <span className="pcard-meta">
            <span
              className={`timer${!t.valid ? ' timer-invalid' : t.expired ? ' timer-over' : t.warning ? ' timer-warn' : ''}`}
            >
              {t.label}
            </span>
            {t.expired && t.valid ? <span style={{ fontWeight: 800 }}>OVER</span> : null}
          </span>
          <span
            className="chipbar"
            // These live inside the card's tap area, which advances the pizza. Stop the
            // event here or every timer nudge would also send it to the Ready board.
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="chipbtn"
              disabled={(order.bakeSeconds ?? 0) <= 30}
              onClick={() => onAdjust?.(-60)}
            >
              −1:00
            </button>
            <button
              type="button"
              className="chipbtn"
              disabled={(order.bakeSeconds ?? 0) >= 3600}
              onClick={() => onAdjust?.(30)}
            >
              +0:30
            </button>
            {onMove ? (
              <button type="button" className="chipbtn" title="Move to another deck" onClick={onMove}>
                ⇄
              </button>
            ) : null}
            {onTakeOut ? (
              <button type="button" className="chipbtn" title="Take it back out" onClick={onTakeOut}>
                ↩
              </button>
            ) : null}
          </span>
        </>
      ) : (
        <span className="pcard-meta">{footer}</span>
      )}
    </div>
  );
}
