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
import { useFocusCard, useFocusParam, useFocusedOrderId } from '../useFocusOrder.ts';
import { EmptyState, Modal, SoundToggle, useBoardStale } from '../components.tsx';
import { useWakeLock } from '../useWakeLock.ts';
import { bakeState, elapsed, useNow } from '../useNow.ts';
import { maybeAlarm } from '../alarm.ts';
import { STATUS } from '../../../shared/status.ts';
import type { Order, OvenLayer } from '../../../shared/types.ts';

const VERY_LATE_MS = 60_000;
/** How much one tap of a timer chip is worth. Fine-grained on purpose: the adjustment
 *  that actually gets used is "a bit longer", not "a whole minute longer". */
const BAKE_STEP_S = 15;

/** Where a pizza can be dropped. A deck is a numbered row, so a target is deck + position. */
type Zone = { kind: 'slot'; layerId: number; slot: number } | { kind: 'unplaced' };

const UNPLACED: Zone = { kind: 'unplaced' };

function zoneId(z: Zone): string {
  return z.kind === 'unplaced' ? 'zone-unplaced' : `zone-slot-${z.layerId}-${z.slot}`;
}

function parseZone(id: string): Zone | null {
  if (id === 'zone-unplaced') return UNPLACED;
  const m = /^zone-slot-(\d+)-(\d+)$/.exec(id);
  return m ? { kind: 'slot', layerId: Number(m[1]), slot: Number(m[2]) } : null;
}

const sameZone = (a: Zone, b: Zone): boolean =>
  a.kind === 'unplaced'
    ? b.kind === 'unplaced'
    : b.kind === 'slot' && a.layerId === b.layerId && a.slot === b.slot;

function zoneOf(order: Order): Zone {
  return order.ovenLayerId !== null && order.ovenSlot !== null
    ? { kind: 'slot', layerId: order.ovenLayerId, slot: order.ovenSlot }
    : UNPLACED;
}

export default function Oven() {
  // Called once here purely to schedule the highlight's self-clear. The cards read the param
  // themselves rather than take a prop, because they sit three components deep behind the
  // deck and slot layout.
  useFocusedOrderId();
  useWakeLock();
  const now = useNow(500);
  const stale = useBoardStale();
  const { orders, state, mutateOrder, run, pushToast } = useLive();

  const [selected, setSelected] = useState<number | null>(null);
  const [dragging, setDragging] = useState<Order | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmReady, setConfirmReady] = useState<Order | null>(null);
  const [confirmOut, setConfirmOut] = useState<Order | null>(null);

  const layers = state?.layers ?? [];

  const baking = useMemo(
    () => orders.filter((o) => o.cancelledAt === null && o.status === STATUS.BAKING),
    [orders],
  );

  /** The old QUEUE screen, folded in: the person loading the oven is the person who needs
   *  to see what is waiting for it. Oldest first. */
  const waiting = useMemo(
    () =>
      orders
        .filter((o) => o.cancelledAt === null && o.status === STATUS.WAITING_FOR_OVEN)
        .sort((a, b) => (a.queuedAt ?? a.createdAt) - (b.queuedAt ?? b.createdAt)),
    [orders],
  );

  /** Baking, but nobody recorded where. Always visible so such a pizza cannot be lost. */
  const unplaced = useMemo(
    () =>
      baking
        .filter((o) => o.ovenLayerId === null || o.ovenSlot === null)
        .sort((a, b) => (a.bakingStartedAt ?? 0) - (b.bakingStartedAt ?? 0)),
    [baking],
  );

  /** layerId -> slotIndex -> order. The single lookup every deck renders from. */
  const bySlot = useMemo(() => {
    const map = new Map<number, Map<number, Order>>();
    for (const l of layers) map.set(l.id, new Map());
    for (const o of baking) {
      if (o.ovenLayerId === null || o.ovenSlot === null) continue;
      map.get(o.ovenLayerId)?.set(o.ovenSlot, o);
    }
    return map;
  }, [baking, layers]);

  // How many are over, and how far gone the worst one is - the alarm nags faster once
  // something has been ignored for a while.
  const { overdueCount, maxOverdueMs } = useMemo(() => {
    let count = 0;
    let worst = 0;
    for (const o of baking) {
      const t = bakeState(o.bakingStartedAt, o.bakeSeconds, now);
      if (!t.expired) continue;
      count += 1;
      worst = Math.max(worst, -t.remainingMs);
    }
    return { overdueCount: count, maxOverdueMs: worst };
  }, [baking, now]);

  useEffect(() => {
    maybeAlarm(overdueCount, maxOverdueMs, Date.now());
  }, [overdueCount, maxOverdueMs, now]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      // A short hold before a drag starts, so an ordinary tap stays a tap.
      activationConstraint: { delay: 180, tolerance: 8 },
    }),
  );

  const selectedOrder = selected === null ? null : orders.find((o) => o.id === selected) ?? null;
  /** A pizza already in a deck has a slot to hand back, so it may swap into an occupied one. */
  const selectedCanSwap =
    selectedOrder !== null &&
    selectedOrder.ovenLayerId !== null &&
    selectedOrder.ovenSlot !== null;

  const place = (order: Order, zone: Zone) => {
    setSelected(null);
    if (sameZone(zoneOf(order), zone) && order.status === STATUS.BAKING) return;

    const layerId = zone.kind === 'unplaced' ? null : zone.layerId;
    const slot = zone.kind === 'unplaced' ? null : zone.slot;

    void mutateOrder({
      id: order.id,
      patch: {
        status: STATUS.BAKING,
        ovenLayerId: layerId,
        ovenSlot: slot,
        // Only guess a start time for a pizza that is not already baking; moving slots must
        // never look like a reset, even for the half second before the server replies.
        bakingStartedAt: order.status === STATUS.BAKING ? order.bakingStartedAt : serverNow(),
      },
      request: () => crewApi.place(order.id, layerId, slot).then((r) => r.order),
      alreadyDone: (x) =>
        x.status === STATUS.BAKING && x.ovenLayerId === layerId && x.ovenSlot === slot,
    });
  };

  const markReady = (order: Order) => {
    setConfirmReady(null);
    const from = zoneOf(order);
    void mutateOrder({
      id: order.id,
      patch: { status: STATUS.READY, ovenLayerId: null, ovenSlot: null, readyAt: serverNow() },
      request: () =>
        crewApi.transition(order.id, STATUS.BAKING, STATUS.READY).then((r) => r.order),
      alreadyDone: (x) => x.status === STATUS.READY,
      undo: {
        text: `#${order.id} ${order.customerName} is ready`,
        label: 'Undo',
        // Puts it back in the slot it came out of, and within two minutes the server
        // resumes the original countdown rather than starting a fresh bake.
        run: () =>
          crewApi
            .place(
              order.id,
              from.kind === 'unplaced' ? null : from.layerId,
              from.kind === 'unplaced' ? null : from.slot,
            )
            .then((r) => r.order),
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
        ovenSlot: null,
        bakingStartedAt: null,
        bakeSeconds: null,
      },
      request: () =>
        crewApi.transition(order.id, STATUS.BAKING, STATUS.WAITING_FOR_OVEN).then((r) => r.order),
      alreadyDone: (x) => x.status === STATUS.WAITING_FOR_OVEN,
    });
  };

  const onCardTap = (o: Order) => {
    if (editing) return;
    if (o.status === STATUS.WAITING_FOR_OVEN) {
      setSelected((s) => (s === o.id ? null : o.id));
      return;
    }
    // ALWAYS confirm. Taking a pizza out is the one irreversible-feeling move on this
    // screen, and a card that is blinking for attention is exactly the one a sleeve is
    // most likely to brush against.
    setConfirmReady(o);
  };

  /** Tapping a slot is the reliable half of the interaction; dragging is the enhancement. */
  const onZoneTap = (zone: Zone, occupant: Order | undefined) => {
    if (!selectedOrder || editing) return;
    if (occupant && occupant.id !== selectedOrder.id) {
      if (!selectedCanSwap) {
        pushToast(
          `Slot ${zone.kind === 'slot' ? zone.slot + 1 : ''} has #${occupant.id} ${occupant.customerName} in it. Pick an empty slot.`,
          'warn',
        );
        return;
      }
    }
    place(selectedOrder, zone);
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
    const order = dragging;
    setDragging(null);
    if (!e.over || !order) return;
    const zone = parseZone(String(e.over.id));
    if (zone) place(order, zone);
  };

  const totalSlots = layers.reduce((n, l) => n + l.capacity, 0);

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
            {editing ? '✓ Done editing' : '✎ Edit decks'}
          </button>
          {editing ? (
            <span className="small muted">Moving pizzas is off while you edit the decks.</span>
          ) : (
            <span className="small muted">
              {baking.length} baking in {totalSlots} slots · {waiting.length} waiting
            </span>
          )}
          <span className="spacer" />
          <SoundToggle kind="oven" />
        </div>

        <div className="oven-trays">
          {/* The merged queue. Tap one, then tap the slot you are putting it in. */}
          <div className="tray">
            <div className="tray-head">
              <span className="tray-title">To go in ({waiting.length})</span>
              {waiting.length > 0 && !selectedOrder ? (
                <span className="small muted">tap one, then tap a slot</span>
              ) : null}
            </div>
            <div className="slot-row">
              {waiting.length === 0 ? (
                <span className="small muted">Nothing waiting for the oven</span>
              ) : (
                waiting.map((o) => (
                  <OvenCard
                    key={o.id}
                    order={o}
                    now={now}
                    selected={selected === o.id}
                    draggable={!editing}
                    onTap={() => onCardTap(o)}
                    footer={<span>waiting {elapsed(o.queuedAt ?? o.createdAt, now)}</span>}
                  />
                ))
              )}
            </div>
          </div>

          <UnplacedTray
            orders={unplaced}
            now={now}
            selected={selected}
            editing={editing}
            canDrop={Boolean(selectedOrder)}
            onTap={onCardTap}
            onMove={(o) => setSelected((s) => (s === o.id ? null : o.id))}
            onAdjust={adjustBake}
            onTakeOut={(o) => setConfirmOut(o)}
            onZoneTap={() => onZoneTap(UNPLACED, undefined)}
          />
        </div>

        <div className="oven-decks">
          {layers.length === 0 ? (
            <div className="deck">
              <EmptyState emoji="🔥">
                <p>No oven decks yet.</p>
                <p className="small">
                  Tap <strong>Edit decks</strong> to add one. Pizzas can bake in the Unplaced tray
                  in the meantime.
                </p>
              </EmptyState>
            </div>
          ) : (
            layers.map((layer, i) => (
              <Deck
                key={layer.id}
                layer={layer}
                slots={bySlot.get(layer.id) ?? new Map()}
                now={now}
                editing={editing}
                selected={selected}
                selectedOrder={selectedOrder}
                selectedCanSwap={selectedCanSwap}
                onCardTap={onCardTap}
                onZoneTap={onZoneTap}
                onMove={(o) => setSelected((s) => (s === o.id ? null : o.id))}
                onAdjust={adjustBake}
                onTakeOut={(o) => setConfirmOut(o)}
                onRename={(name) => void run(() => crewApi.updateLayer(layer.id, { name }))}
                onCapacity={(capacity) =>
                  void run(async () => {
                    const r = await crewApi.updateLayer(layer.id, { capacity });
                    if (r.evicted > 0) {
                      pushToast(
                        `${r.evicted} pizza${r.evicted === 1 ? '' : 's'} moved to Unplaced — that slot is gone`,
                        'warn',
                      );
                    }
                    return r;
                  })
                }
                onMoveUp={i === 0 ? null : () => void run(() => reorder(layers, i, i - 1))}
                onMoveDown={
                  i === layers.length - 1 ? null : () => void run(() => reorder(layers, i, i + 1))
                }
              />
            ))
          )}

          {editing ? (
            <button
              type="button"
              className="btn btn-primary"
              style={{ flex: 'none' }}
              onClick={() => {
                const name = window.prompt('Name for the new deck', `Deck ${layers.length + 1}`);
                if (name?.trim()) void run(() => crewApi.createLayer(name.trim(), 4));
              }}
            >
              + Add deck
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
                selected — tap {selectedCanSwap ? 'a slot (tap a full one to swap)' : 'an empty slot'}.
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
          <div className="pcard drag-overlay" style={{ width: 185 }}>
            <span className="pcard-no">#{dragging.id}</span>
            <span className="pcard-name">{dragging.customerName}</span>
            <span className="pcard-type">{dragging.pizzaTypeName}</span>
          </div>
        ) : null}
      </DragOverlay>

      {confirmReady ? (
        <ReadyConfirm
          order={confirmReady}
          now={now}
          onClose={() => setConfirmReady(null)}
          onConfirm={() => markReady(confirmReady)}
        />
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
            #{confirmOut.id} {confirmOut.customerName} goes back to “to go in”, its slot frees up
            and its{' '}
            <strong>{bakeState(confirmOut.bakingStartedAt, confirmOut.bakeSeconds, now).label}</strong>{' '}
            timer is cleared. It restarts from zero when you put it back in.
          </p>
        </Modal>
      ) : null}
    </DndContext>
  );
}

function reorder(layers: OvenLayer[], i: number, j: number) {
  return Promise.all([
    crewApi.updateLayer(layers[i].id, { position: layers[j].position }),
    crewApi.updateLayer(layers[j].id, { position: layers[i].position }),
  ]);
}

// --- Unplaced tray -------------------------------------------------------------------------

function UnplacedTray({
  orders,
  now,
  selected,
  editing,
  canDrop,
  onTap,
  onMove,
  onAdjust,
  onTakeOut,
  onZoneTap,
}: {
  orders: Order[];
  now: number;
  selected: number | null;
  editing: boolean;
  canDrop: boolean;
  onTap: (o: Order) => void;
  onMove: (o: Order) => void;
  onAdjust: (o: Order, delta: number) => void;
  onTakeOut: (o: Order) => void;
  onZoneTap: () => void;
}) {
  const droppable = useDroppable({ id: zoneId(UNPLACED) });
  return (
    <div
      ref={droppable.setNodeRef}
      className={`tray${droppable.isOver ? ' drop-target' : ''}`}
    >
      <div className="tray-head">
        <span className="tray-title">Unplaced ({orders.length})</span>
      </div>
      <div className="slot-row">
        {orders.length === 0 ? (
          <span className="small muted">Baking pizzas with no recorded slot land here</span>
        ) : (
          orders.map((o) => (
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
          ))
        )}
        {canDrop ? (
          <button type="button" className="place-here" onClick={onZoneTap}>
            ▸ PUT HERE
          </button>
        ) : null}
      </div>
    </div>
  );
}

// --- Deck ----------------------------------------------------------------------------------

function Deck({
  layer,
  slots,
  now,
  editing,
  selected,
  selectedOrder,
  selectedCanSwap,
  onCardTap,
  onZoneTap,
  onMove,
  onAdjust,
  onTakeOut,
  onRename,
  onCapacity,
  onMoveUp,
  onMoveDown,
}: {
  layer: OvenLayer;
  slots: Map<number, Order>;
  now: number;
  editing: boolean;
  selected: number | null;
  selectedOrder: Order | null;
  selectedCanSwap: boolean;
  onCardTap: (o: Order) => void;
  onZoneTap: (zone: Zone, occupant: Order | undefined) => void;
  onMove: (o: Order) => void;
  onAdjust: (o: Order, delta: number) => void;
  onTakeOut: (o: Order) => void;
  onRename: (name: string) => void;
  onCapacity: (capacity: number) => void;
  onMoveUp: (() => void) | null;
  onMoveDown: (() => void) | null;
}) {
  const { run } = useLive();
  const [deleting, setDeleting] = useState(false);
  const used = slots.size;
  const indexes = Array.from({ length: layer.capacity }, (_, i) => i);

  return (
    <div className="deck">
      <div className="deck-head">
        {editing ? (
          <input
            className="input"
            style={{ maxWidth: 200, minHeight: 42 }}
            defaultValue={layer.name}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v && v !== layer.name) onRename(v);
            }}
          />
        ) : (
          <span className="deck-title">{layer.name}</span>
        )}
        <span className={`cap${used === layer.capacity ? ' full' : ''}`}>
          {used} / {layer.capacity}
        </span>
        <span className="spacer" />
        {editing ? (
          <div className="chipbar">
            <span className="small muted" style={{ alignSelf: 'center', marginRight: 4 }}>
              slots
            </span>
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
        {indexes.map((i) => (
          <Slot
            key={i}
            zone={{ kind: 'slot', layerId: layer.id, slot: i }}
            index={i}
            occupant={slots.get(i)}
            now={now}
            editing={editing}
            selected={selected}
            selectedOrder={selectedOrder}
            selectedCanSwap={selectedCanSwap}
            onCardTap={onCardTap}
            onZoneTap={onZoneTap}
            onMove={onMove}
            onAdjust={onAdjust}
            onTakeOut={onTakeOut}
          />
        ))}
      </div>

      {deleting ? (
        <DeleteDeckModal
          layer={layer}
          occupants={used}
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

// --- One slot --------------------------------------------------------------------------------

function Slot({
  zone,
  index,
  occupant,
  now,
  editing,
  selected,
  selectedOrder,
  selectedCanSwap,
  onCardTap,
  onZoneTap,
  onMove,
  onAdjust,
  onTakeOut,
}: {
  zone: Zone;
  index: number;
  occupant: Order | undefined;
  now: number;
  editing: boolean;
  selected: number | null;
  selectedOrder: Order | null;
  selectedCanSwap: boolean;
  onCardTap: (o: Order) => void;
  onZoneTap: (zone: Zone, occupant: Order | undefined) => void;
  onMove: (o: Order) => void;
  onAdjust: (o: Order, delta: number) => void;
  onTakeOut: (o: Order) => void;
}) {
  const droppable = useDroppable({ id: zoneId(zone), disabled: editing });

  const isSelf = occupant && selectedOrder && occupant.id === selectedOrder.id;
  // An empty slot always accepts. A full one only accepts a pizza that has a slot of its
  // own to give back, because there is nowhere else to put the occupant.
  const offering = Boolean(selectedOrder) && !isSelf && (!occupant || selectedCanSwap);
  const blocked = Boolean(selectedOrder) && !isSelf && Boolean(occupant) && !selectedCanSwap;

  const cls = [
    'slot',
    occupant ? 'slot-full' : 'slot-empty',
    droppable.isOver && !editing ? 'drop-target' : '',
    offering ? 'slot-offering' : '',
    blocked ? 'slot-blocked' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div ref={droppable.setNodeRef} className={cls}>
      <span className="slot-no">{index + 1}</span>
      {occupant ? (
        <OvenCard
          order={occupant}
          now={now}
          selected={selected === occupant.id}
          draggable={!editing}
          onTap={() => (offering ? onZoneTap(zone, occupant) : onCardTap(occupant))}
          onMove={() => onMove(occupant)}
          onAdjust={(d) => onAdjust(occupant, d)}
          onTakeOut={() => onTakeOut(occupant)}
        />
      ) : (
        <button
          type="button"
          className="slot-body"
          disabled={!offering}
          onClick={() => onZoneTap(zone, undefined)}
        >
          {offering ? <span className="slot-cta">▸ PUT HERE</span> : null}
        </button>
      )}
    </div>
  );
}

// --- Delete a deck ----------------------------------------------------------------------------

/**
 * The rehoming heuristic IS this dialog. The person deleting the deck is the only one who
 * knows where those pizzas physically went, and they are standing at the oven - so they
 * choose, rather than the app inventing a plausible lie. Timers keep running either way.
 */
function DeleteDeckModal({
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
  const { state, orders } = useLive();
  const others = (state?.layers ?? []).filter((l) => l.id !== layer.id);
  const [dest, setDest] = useState<string>('unplaced');

  const freeInDest =
    dest === 'unplaced'
      ? Infinity
      : (others.find((l) => l.id === Number(dest))?.capacity ?? 0) -
        orders.filter(
          (o) => o.ovenLayerId === Number(dest) && o.status === STATUS.BAKING && o.cancelledAt === null,
        ).length;
  const overflow = Math.max(0, occupants - freeInDest);

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
            Delete deck
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
          <p className="hint">
            {dest === 'unplaced'
              ? 'Their timers keep running. Nothing is deleted except the deck.'
              : overflow > 0
                ? `They fill the free slots in order — ${overflow} will not fit and go to Unplaced. Timers keep running.`
                : 'They fill the free slots in order. Timers keep running.'}
          </p>
        </>
      ) : (
        <p>It is empty, so nothing moves.</p>
      )}
    </Modal>
  );
}

// --- Confirm taking a pizza out ----------------------------------------------------------------

function ReadyConfirm({
  order,
  now,
  onClose,
  onConfirm,
}: {
  order: Order;
  now: number;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const t = bakeState(order.bakingStartedAt, order.bakeSeconds, now);
  return (
    <Modal
      title={t.expired ? 'Take it out?' : 'Take it out early?'}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Leave it in
          </button>
          <button type="button" className="btn btn-ok" onClick={onConfirm}>
            Yes, it’s ready
          </button>
        </>
      }
    >
      <p>
        <span aria-hidden="true">{order.pizzaTypeEmoji} </span>
        <strong>
          #{order.id} {order.customerName}
        </strong>{' '}
        · {order.pizzaTypeName}
      </p>
      <p>
        {!t.valid ? (
          'This pizza has no timer running.'
        ) : t.expired ? (
          <>
            It is <strong>{t.label} over</strong> its bake time.
          </>
        ) : (
          <>
            It still has <strong>{t.label}</strong> left.
          </>
        )}
      </p>
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
  const focusId = useFocusParam();
  const { ref: focusRef, focused } = useFocusCard<HTMLDivElement>(order.id, focusId);

  /**
   * The root already carries dnd-kit's setNodeRef. Overwriting it would silently stop this
   * card being draggable, so both refs are fed from one callback.
   */
  const setRefs = (el: HTMLDivElement | null) => {
    focusRef.current = el;
    setNodeRef(el);
  };

  const cls = [
    'pcard',
    draggable ? 'draggable' : '',
    selected ? 'selected' : '',
    // NOT folded into 'selected'. On this screen .selected also means "armed - tap a slot to
    // move it", so reusing it would make a scanned pizza arrive armed and the next tap would
    // silently relocate it. Finding a pizza must never be able to move one.
    focused ? 'focused' : '',
    p && !p.failed ? 'pending' : '',
    p && p.failed ? 'failed' : '',
    isBaking && t.expired ? 'expired' : '',
    isBaking && t.expired && -t.remainingMs > VERY_LATE_MS ? 'very-late' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      ref={setRefs}
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
      <span className="pcard-head">
        <span className="pcard-emoji" aria-hidden="true">
          {order.pizzaTypeEmoji}
        </span>
        <span className="pcard-no">#{order.id}</span>
      </span>
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
              onClick={() => onAdjust?.(-BAKE_STEP_S)}
            >
              −0:15
            </button>
            <button
              type="button"
              className="chipbtn"
              disabled={(order.bakeSeconds ?? 0) >= 3600}
              onClick={() => onAdjust?.(BAKE_STEP_S)}
            >
              +0:15
            </button>
            {onMove ? (
              <button type="button" className="chipbtn" title="Move to another slot" onClick={onMove}>
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
