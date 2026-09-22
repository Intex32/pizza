import { randomBytes } from 'node:crypto';
import {
  allLayers,
  bumpVersion,
  db,
  getCustomerOrderByToken,
  getLayer,
  getOrderById,
  getPizzaType,
  log,
  readSettings,
  rowToCustomerOrder,
  rowToLayer,
  rowToOrder,
  rowToPizzaType,
  tx,
  writeSetting,
} from './db.ts';
import { ApiError, bad, clamp, conflict, notFound } from './validate.ts';
import { CUSTOMER_CANCEL_REASON, STATUS, canTransition } from '../shared/status.ts';
import type { Status } from '../shared/status.ts';
import { DEFAULT_BAKE_SECONDS } from '../shared/menu.ts';
import { DEFAULT_PIZZA_EMOJI } from '../shared/payment.ts';
import type { PaymentMethod } from '../shared/payment.ts';
import type { CustomerOrder, Order, OvenLayer, PizzaType } from '../shared/types.ts';

type Row = Record<string, unknown>;

/** 128 bits. The only thing a customer's browser ever stores, and the only thing that
 *  addresses their order - so it must not be guessable or enumerable. */
function newToken(): string {
  return randomBytes(16).toString('base64url');
}

/**
 * Run a write and publish it. bumpVersion() happens strictly AFTER the commit, so a poll
 * that observes the new version can never read pre-commit state.
 */
function mutate<T>(fn: () => T): T {
  const result = tx(fn);
  bumpVersion();
  return result;
}

/** A 409 that hands the client the authoritative row so it can self-correct immediately. */
function staleConflict(code: string, message: string, order: Order): ApiError {
  return new ApiError(409, code, message, { order });
}

function requireOrder(id: number): Order {
  const order = getOrderById(id);
  if (!order) throw notFound('order_not_found', `No order #${id}.`);
  return order;
}

function requireLiveType(id: number): PizzaType {
  const type = getPizzaType(id);
  if (!type || type.archivedAt !== null) {
    throw bad('unknown_type', 'That pizza is not on the menu.');
  }
  return type;
}

// ===========================================================================================
// Customer-facing
// ===========================================================================================

export function createCustomerOrder(input: {
  customerName: string;
  pizzaTypeId: number;
  note: string;
  clientRequestId: string;
}): { order: CustomerOrder; created: boolean } {
  return mutate(() => {
    // Idempotency first: a double-tapped Submit on bad wifi must return the SAME order,
    // which is also what makes the client safe to auto-retry on a network error.
    const existing = db
      .prepare('SELECT * FROM orders WHERE client_request_id = :rid')
      .get({ rid: input.clientRequestId }) as Row | undefined;
    if (existing) return { order: rowToCustomerOrder(existing), created: false };

    if (!readSettings().ordersOpen) {
      throw conflict('orders_closed', 'Orders are closed for tonight.');
    }

    const type = requireLiveType(input.pizzaTypeId);
    if (type.soldOut) {
      throw conflict('sold_out', `${type.name} is sold out.`);
    }

    const now = Date.now();
    const result = db
      .prepare(
        'INSERT INTO orders (public_token, client_request_id, customer_name, note, ' +
          'pizza_type_id, pizza_type_name, pizza_type_emoji, status, created_at, updated_at) ' +
          'VALUES (:token, :rid, :name, :note, :typeId, :typeName, :emoji, :status, :now, :now)',
      )
      .run({
        token: newToken(),
        rid: input.clientRequestId,
        name: input.customerName,
        note: input.note,
        typeId: type.id,
        // Snapshotted, so renaming or retiring the type never rewrites a placed order.
        typeName: type.name,
        emoji: type.emoji,
        status: STATUS.ORDERED,
        now,
      });

    const id = Number(result.lastInsertRowid);
    log(`ORDER #${id} created "${input.customerName}" ${type.name}`);
    const row = db.prepare('SELECT * FROM orders WHERE id = :id').get({ id }) as Row;
    return { order: rowToCustomerOrder(row), created: true };
  });
}

/**
 * The ONE public mutation. The `status='ORDERED' AND paid_at IS NULL` guard is the whole
 * safety story: the moment the crew take cash and tap PAID -> PREP the button is gone, so a
 * pizza can never be cancelled out from under the prep table or the oven.
 */
export function cancelByToken(token: string): CustomerOrder {
  return mutate(() => {
    const now = Date.now();
    const result = db
      .prepare(
        'UPDATE orders SET cancelled_at = :now, cancel_reason = :reason, updated_at = :now ' +
          "WHERE public_token = :token AND status = 'ORDERED' " +
          'AND paid_at IS NULL AND cancelled_at IS NULL',
      )
      .run({ now, reason: CUSTOMER_CANCEL_REASON, token });

    const order = getCustomerOrderByToken(token);
    if (!order) throw notFound('order_not_found', 'We could not find that order.');

    if (Number(result.changes) === 0) {
      // Already cancelled is a SUCCESS, not an error: a double tap on bad wifi is harmless.
      if (order.cancelledAt !== null) return order;
      throw staleConflict(
        'too_late',
        'Your pizza is already being made - please talk to the crew.',
        order,
      );
    }

    log(`ORDER #${order.id} cancelled by customer`);
    return order;
  });
}

// ===========================================================================================
// Crew: orders
// ===========================================================================================

/** Walk-in: an INSERT, not a transition. Already paid, straight into prep, and deliberately
 *  NOT gated by orders_open - the person is standing at the counter. */
export function createWalkInOrder(input: {
  customerName: string;
  pizzaTypeId: number;
  note: string;
  paymentMethod: PaymentMethod;
}): Order {
  return mutate(() => {
    const type = requireLiveType(input.pizzaTypeId);
    const now = Date.now();
    const result = db
      .prepare(
        'INSERT INTO orders (public_token, customer_name, note, pizza_type_id, ' +
          'pizza_type_name, pizza_type_emoji, payment_method, status, paid_at, ' +
          'created_at, updated_at) ' +
          'VALUES (:token, :name, :note, :typeId, :typeName, :emoji, :payment, :status, ' +
          ':now, :now, :now)',
      )
      .run({
        token: newToken(),
        name: input.customerName,
        note: input.note,
        typeId: type.id,
        typeName: type.name,
        emoji: type.emoji,
        payment: input.paymentMethod,
        status: STATUS.IN_PREPARATION,
        now,
      });
    const id = Number(result.lastInsertRowid);
    log(`ORDER #${id} walk-in "${input.customerName}" ${type.name}`);
    return requireOrder(id);
  });
}

/**
 * Compare-and-swap on the status the client is currently rendering. Every side effect of a
 * move lives in this one statement, so both table CHECKs hold at every instant.
 */
export function transitionOrder(
  id: number,
  expected: Status,
  next: Status,
  paymentMethod: PaymentMethod | null = null,
): Order {
  // Checked BEFORE adjacency so the one move a crew member would actually attempt
  // (WAITING_FOR_OVEN -> BAKING) gets the useful message rather than a generic rejection.
  if (next === STATUS.BAKING) {
    throw new ApiError(
      422,
      'use_place',
      'Putting a pizza in the oven goes through /place so the timer is set exactly once.',
    );
  }
  if (!canTransition(expected, next)) {
    throw new ApiError(422, 'illegal_transition', `${expected} cannot move to ${next}.`);
  }

  return mutate(() => {
    const now = Date.now();
    const result = db
      .prepare(`
        UPDATE orders SET
          status     = :next,
          updated_at = :now,
          paid_at    = CASE WHEN :next = 'IN_PREPARATION' AND :expected = 'ORDERED'
                            THEN COALESCE(paid_at, :now) ELSE paid_at END,
          -- Recorded only on the way FORWARD out of ORDERED. A backward move deliberately
          -- keeps it, along with paid_at: by then the money really has changed hands.
          payment_method = CASE WHEN :next = 'IN_PREPARATION' AND :expected = 'ORDERED'
                                THEN COALESCE(:payment, payment_method)
                                ELSE payment_method END,
          queued_at  = CASE WHEN :next = 'WAITING_FOR_OVEN' AND :expected = 'IN_PREPARATION'
                              THEN :now
                            WHEN :next = 'IN_PREPARATION' AND :expected = 'WAITING_FOR_OVEN'
                              THEN NULL
                            ELSE queued_at END,
          -- Only the BACKWARD move out of the oven destroys the timer. Moving forward to
          -- READY keeps baking_started_at as a record, which is also what makes the
          -- "back to the oven" undo able to resume the original countdown.
          baking_started_at = CASE WHEN :expected = 'BAKING' AND :next = 'WAITING_FOR_OVEN'
                                   THEN NULL ELSE baking_started_at END,
          bake_seconds      = CASE WHEN :expected = 'BAKING' AND :next = 'WAITING_FOR_OVEN'
                                   THEN NULL ELSE bake_seconds END,
          oven_layer_id     = NULL,
          oven_slot         = NULL,
          ready_at     = CASE WHEN :next = 'READY' THEN COALESCE(ready_at, :now) ELSE ready_at END,
          picked_up_at = CASE WHEN :next = 'PICKED_UP' THEN :now
                              WHEN :expected = 'PICKED_UP' THEN NULL
                              ELSE picked_up_at END
        WHERE id = :id AND status = :expected AND cancelled_at IS NULL
      `)
      .run({ id, expected, next, now, payment: paymentMethod });

    const order = requireOrder(id);
    if (Number(result.changes) === 0) {
      if (order.cancelledAt !== null) {
        throw staleConflict('order_cancelled', 'That order was cancelled.', order);
      }
      throw staleConflict(
        'stale_status',
        'Someone else already handled this one.',
        order,
      );
    }
    log(`TRANSITION #${id} ${expected} -> ${next}`);
    return order;
  });
}

/**
 * The ONLY way into BAKING - first insertion, moving between slots, and dragging to the
 * Unplaced tray all come through here. One path into the oven means exactly one place where
 * baking_started_at can ever be written, which is what guarantees that moving a pizza
 * between slots never resets a six-minute-old timer.
 *
 * A deck is a numbered row of slots, and slot order matters (slot 1 is nearest the door),
 * so placement is a PAIR: which deck, and which position in it.
 */
export function placeOrder(
  id: number,
  ovenLayerId: number | null,
  ovenSlot: number | null,
): Order {
  return mutate(() => {
    const before = requireOrder(id);
    if (before.cancelledAt !== null) {
      throw staleConflict('order_cancelled', 'That order was cancelled.', before);
    }

    let layerId = ovenLayerId;
    let slot = ovenSlot;
    if (layerId === null) {
      slot = null; // the Unplaced tray has no positions
    } else {
      const layer = getLayer(layerId);
      if (!layer) {
        throw new ApiError(409, 'layer_gone', 'That oven layer no longer exists.');
      }
      if (slot === null || slot < 0 || slot >= layer.capacity) {
        throw bad('invalid_slot', `${layer.name} has slots 1-${layer.capacity}.`);
      }
    }

    // Resolved BEFORE binding: binding undefined to a named parameter throws on this Node,
    // and the pizza type may legitimately have been deleted since the order was placed.
    const fallback =
      before.bakeSeconds ??
      (before.pizzaTypeId !== null ? getPizzaType(before.pizzaTypeId)?.bakeSeconds : undefined) ??
      DEFAULT_BAKE_SECONDS;

    const now = Date.now();

    const occupantRow =
      layerId === null
        ? undefined
        : (db
            .prepare(
              "SELECT * FROM orders WHERE oven_layer_id = :l AND oven_slot = :s " +
                "AND status = 'BAKING' AND cancelled_at IS NULL",
            )
            .get({ l: layerId, s: slot }) as Row | undefined);
    const occupant = occupantRow ? rowToOrder(occupantRow) : undefined;
    const swapping = Boolean(occupant && occupant.id !== id);

    if (occupant && swapping) {
      // A swap only makes sense when the mover has a slot of its own to hand back. Coming
      // off the queue there is nowhere to put the occupant, so say so rather than quietly
      // bumping someone else's pizza out of the oven.
      if (before.ovenLayerId === null || before.ovenSlot === null) {
        throw staleConflict(
          'slot_taken',
          `Slot ${(slot ?? 0) + 1} already has #${occupant.id} ${occupant.customerName} in it.`,
          before,
        );
      }
      // Vacate first: the unique index rejects two pizzas sharing a slot even for the
      // instant in the middle of a swap.
      db.prepare(
        'UPDATE orders SET oven_layer_id = NULL, oven_slot = NULL, updated_at = :now WHERE id = :oid',
      ).run({ oid: occupant.id, now });
    }

    const result = db
      .prepare(`
        UPDATE orders SET
          status        = 'BAKING',
          oven_layer_id = :layerId,
          oven_slot     = :slot,
          baking_started_at = CASE
              WHEN status = 'BAKING' THEN COALESCE(baking_started_at, :now)
              WHEN status = 'READY' AND :now - COALESCE(ready_at, 0) <= 120000
                THEN COALESCE(baking_started_at, :now)
              ELSE :now END,
          bake_seconds  = COALESCE(bake_seconds, :fallback),
          ready_at      = NULL,
          updated_at    = :now
        WHERE id = :id
          AND cancelled_at IS NULL
          AND status IN ('WAITING_FOR_OVEN', 'BAKING', 'READY')
      `)
      .run({ id, layerId, slot, now, fallback });

    if (Number(result.changes) === 0) {
      // Throwing rolls the whole transaction back, so the vacated occupant returns with it.
      throw staleConflict(
        'not_placeable',
        'That pizza is no longer in the oven queue.',
        requireOrder(id),
      );
    }

    if (occupant && swapping) {
      db.prepare(
        'UPDATE orders SET oven_layer_id = :l, oven_slot = :s, updated_at = :now WHERE id = :oid',
      ).run({ l: before.ovenLayerId, s: before.ovenSlot, now, oid: occupant.id });
      log(`SWAP #${id} <-> #${occupant.id}`);
    }

    const where = layerId === null ? 'unplaced' : `layer=${layerId} slot=${(slot ?? 0) + 1}`;
    log(`PLACE #${id} ${before.status} -> BAKING ${where}`);
    return requireOrder(id);
  });
}

/**
 * Send a pizza back to the "To go in" queue, from READY or from BAKING.
 *
 * READY -> WAITING_FOR_OVEN is TWO steps on the status line, and canTransition() deliberately
 * only ever allows one. Doing it as two client calls would leave the pizza sitting in the
 * Unplaced tray if the second one failed - visibly in the oven, when it is in fact in
 * somebody's hand. One statement in one transaction has no such middle state.
 *
 * The timer is destroyed on the way out, exactly as the BAKING -> WAITING_FOR_OVEN step does:
 * this pizza is out of the oven and on a counter, so whatever the old countdown said about
 * when it would be done is now a lie. It gets a fresh bake when someone places it again.
 */
export function requeueOrder(id: number): Order {
  return mutate(() => {
    const now = Date.now();
    const result = db
      .prepare(`
        UPDATE orders SET
          status            = 'WAITING_FOR_OVEN',
          oven_layer_id     = NULL,
          oven_slot         = NULL,
          baking_started_at = NULL,
          bake_seconds      = NULL,
          ready_at          = NULL,
          updated_at        = :now
        WHERE id = :id
          AND cancelled_at IS NULL
          AND status IN ('READY', 'BAKING')
      `)
      .run({ id, now });

    const order = requireOrder(id);
    if (Number(result.changes) === 0) {
      if (order.cancelledAt !== null) {
        throw staleConflict('order_cancelled', 'That order was cancelled.', order);
      }
      throw staleConflict(
        'not_requeueable',
        'That pizza is not in the oven or on the ready board.',
        order,
      );
    }
    log(`REQUEUE #${id} -> WAITING_FOR_OVEN`);
    return order;
  });
}

/**
 * Straight onto the ready board, from the queue or from the oven. The mirror of
 * requeueOrder(), and it exists for exactly one reason: to undo it.
 *
 * WAITING_FOR_OVEN -> READY skips BAKING, which the one-step-at-a-time rule in
 * canTransition() forbids on purpose. That rule is about the FORWARD path, where skipping
 * the oven would mean handing someone raw dough. Undoing a mis-tap is the other direction:
 * the pizza never moved, only the record of it did, and the record has to be able to move
 * back in one go for the same reason requeue does - two calls means a visible wrong state
 * in the middle if the second one fails.
 */
export function readyOrder(id: number): Order {
  return mutate(() => {
    const now = Date.now();
    const result = db
      .prepare(`
        UPDATE orders SET
          status        = 'READY',
          oven_layer_id = NULL,
          oven_slot     = NULL,
          ready_at      = COALESCE(ready_at, :now),
          updated_at    = :now
        WHERE id = :id
          AND cancelled_at IS NULL
          AND status IN ('WAITING_FOR_OVEN', 'BAKING')
      `)
      .run({ id, now });

    const order = requireOrder(id);
    if (Number(result.changes) === 0) {
      if (order.cancelledAt !== null) {
        throw staleConflict('order_cancelled', 'That order was cancelled.', order);
      }
      throw staleConflict(
        'not_readyable',
        'That pizza is not in the oven queue.',
        order,
      );
    }
    log(`READY #${id} (undo of requeue)`);
    return order;
  });
}

/** Absolute, never relative: a "+30" sent twice by a flaky tap would silently add a minute. */
export function setBakeSeconds(id: number, bakeSeconds: number): Order {
  const value = clamp(bakeSeconds, 30, 3600);
  return mutate(() => {
    const now = Date.now();
    const result = db
      .prepare(
        "UPDATE orders SET bake_seconds = :value, updated_at = :now " +
          "WHERE id = :id AND status = 'BAKING' AND cancelled_at IS NULL",
      )
      .run({ id, value, now });

    const order = requireOrder(id);
    if (Number(result.changes) === 0) {
      throw staleConflict('not_baking', 'That pizza is not in the oven.', order);
    }
    log(`BAKE #${id} duration=${value}s`);
    return order;
  });
}

export function patchOrder(
  id: number,
  input: { customerName?: string; pizzaTypeId?: number; note?: string },
): Order {
  return mutate(() => {
    const before = requireOrder(id);

    let typeId = before.pizzaTypeId;
    let typeName = before.pizzaTypeName;
    let typeEmoji = before.pizzaTypeEmoji;
    if (input.pizzaTypeId !== undefined && input.pizzaTypeId !== before.pizzaTypeId) {
      // Past IN_PREPARATION the pizza physically exists; changing what it is would be a lie.
      if (before.status !== STATUS.ORDERED && before.status !== STATUS.IN_PREPARATION) {
        throw staleConflict(
          'too_late_to_change_type',
          'That pizza is already being made - remake it instead.',
          before,
        );
      }
      const type = requireLiveType(input.pizzaTypeId);
      typeId = type.id;
      // re-snapshotted together with the id, never separately
      typeName = type.name;
      typeEmoji = type.emoji;
    }

    const now = Date.now();
    db.prepare(
      'UPDATE orders SET customer_name = :name, note = :note, pizza_type_id = :typeId, ' +
        'pizza_type_name = :typeName, pizza_type_emoji = :typeEmoji, updated_at = :now ' +
        'WHERE id = :id',
    ).run({
      id,
      name: input.customerName ?? before.customerName,
      note: input.note ?? before.note,
      typeId,
      typeName,
      typeEmoji,
      now,
    });

    log(`EDIT #${id}`);
    return requireOrder(id);
  });
}

/** For a genuine mis-tap. A backward status move deliberately does NOT clear paid_at,
 *  because by then the money really is in the tin. */
export function setUnpaid(id: number): Order {
  return mutate(() => {
    const now = Date.now();
    db.prepare(
      'UPDATE orders SET paid_at = NULL, payment_method = NULL, updated_at = :now WHERE id = :id',
    ).run({ id, now });
    log(`UNPAID #${id}`);
    return requireOrder(id);
  });
}

export function cancelOrder(id: number, reason: string): Order {
  return mutate(() => {
    const now = Date.now();
    // Freeing the slot is the point: a cancelled pizza is off the board, and leaving it
    // holding a slot would block a real pizza from going where it physically is.
    db.prepare(
      'UPDATE orders SET cancelled_at = COALESCE(cancelled_at, :now), cancel_reason = :reason, ' +
        'oven_layer_id = NULL, oven_slot = NULL, updated_at = :now WHERE id = :id',
    ).run({ id, reason, now });
    log(`CANCEL #${id} "${reason}"`);
    return requireOrder(id);
  });
}

export function uncancelOrder(id: number): Order {
  return mutate(() => {
    const now = Date.now();
    db.prepare(
      "UPDATE orders SET cancelled_at = NULL, cancel_reason = '', updated_at = :now WHERE id = :id",
    ).run({ id, now });
    log(`UNCANCEL #${id}`);
    return requireOrder(id);
  });
}

/** Dropped on the floor, or came out charcoal. Clone it forward, cancel the original, and
 *  carry the payment across so the crew never take cash twice. */
export function remakeOrder(id: number): { original: Order; clone: Order } {
  return mutate(() => {
    const original = requireOrder(id);
    if (original.cancelledAt !== null) {
      throw staleConflict('already_cancelled', 'That order is already cancelled.', original);
    }

    const now = Date.now();
    const result = db
      .prepare(
        'INSERT INTO orders (public_token, customer_name, note, pizza_type_id, pizza_type_name, ' +
          'pizza_type_emoji, payment_method, status, paid_at, remade_from, created_at, updated_at) ' +
          'VALUES (:token, :name, :note, :typeId, :typeName, :emoji, :payment, :status, ' +
          ':paidAt, :from, :now, :now)',
      )
      .run({
        token: newToken(),
        name: original.customerName,
        note: original.note,
        typeId: original.pizzaTypeId,
        typeName: original.pizzaTypeName,
        emoji: original.pizzaTypeEmoji,
        // They already paid for the one that got ruined; never charge them twice.
        payment: original.paymentMethod,
        status: STATUS.IN_PREPARATION,
        paidAt: original.paidAt,
        from: original.id,
        now,
      });

    const cloneId = Number(result.lastInsertRowid);
    db.prepare(
      'UPDATE orders SET cancelled_at = :now, cancel_reason = :reason, updated_at = :now ' +
        'WHERE id = :id',
    ).run({ id, now, reason: `remake -> #${cloneId}` });

    log(`REMAKE #${id} -> #${cloneId}`);
    return { original: requireOrder(id), clone: requireOrder(cloneId) };
  });
}

// ===========================================================================================
// Crew: oven layers
// ===========================================================================================

export function createLayer(name: string, capacity: number): OvenLayer {
  return mutate(() => {
    const now = Date.now();
    const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM oven_layers').get() as {
      p: number;
    };
    const result = db
      .prepare(
        'INSERT INTO oven_layers (name, capacity, position, created_at, updated_at) ' +
          'VALUES (:name, :capacity, :position, :now, :now)',
      )
      .run({ name, capacity, position: maxPos.p + 1, now });
    const id = Number(result.lastInsertRowid);
    log(`LAYER +${id} "${name}" capacity=${capacity}`);
    // A new layer adopts nothing. No card moves without a human moving a pizza.
    const row = db.prepare('SELECT * FROM oven_layers WHERE id = :id').get({ id }) as Row;
    return rowToLayer(row);
  });
}

export function updateLayer(
  id: number,
  input: { name?: string; capacity?: number; position?: number },
): { layer: OvenLayer; evicted: number } {
  return mutate(() => {
    const row = db.prepare('SELECT * FROM oven_layers WHERE id = :id').get({ id }) as Row | undefined;
    if (!row) throw notFound('layer_not_found', 'That oven layer no longer exists.');
    const before = rowToLayer(row);
    const now = Date.now();
    const capacity = input.capacity ?? before.capacity;

    db.prepare(
      'UPDATE oven_layers SET name = :name, capacity = :capacity, position = :position, ' +
        'updated_at = :now WHERE id = :id',
    ).run({
      id,
      name: input.name ?? before.name,
      capacity,
      position: input.position ?? before.position,
      now,
    });

    // Shrinking a deck can leave pizzas sitting in slots that no longer exist. They go to
    // the Unplaced tray rather than silently vanishing or keeping an impossible position -
    // the crew can see them and put them somewhere real.
    const evicted = Number(
      db
        .prepare(
          "UPDATE orders SET oven_layer_id = NULL, oven_slot = NULL, updated_at = :now " +
            "WHERE oven_layer_id = :id AND oven_slot >= :capacity AND status = 'BAKING'",
        )
        .run({ id, capacity, now }).changes,
    );
    if (evicted > 0) log(`LAYER ${id} shrunk to ${capacity}, ${evicted} pizza(s) -> unplaced`);

    const after = db.prepare('SELECT * FROM oven_layers WHERE id = :id').get({ id }) as Row;
    return { layer: rowToLayer(after), evicted };
  });
}

/**
 * The rehoming heuristic, in one sentence: a pizza only ever moves because someone moved it,
 * and when you delete a deck you choose where its pizzas go.
 *
 * Pizzas are freed from the deck BEFORE it is dropped, so the guarantee never depends on
 * `PRAGMA foreign_keys` being on. They fill the destination's free slots in order; any that
 * do not fit land in the Unplaced tray. Timers are untouched throughout - the pizzas are
 * still physically baking.
 */
export function deleteLayer(
  id: number,
  moveTo: number | null,
): { moved: number; toUnplaced: number; to: number | null } {
  return mutate(() => {
    const row = db.prepare('SELECT * FROM oven_layers WHERE id = :id').get({ id }) as Row | undefined;
    if (!row) throw notFound('layer_not_found', 'That oven layer no longer exists.');

    if (moveTo !== null) {
      if (moveTo === id) throw bad('invalid_destination', 'A deck cannot move pizzas into itself.');
      if (!getLayer(moveTo)) throw bad('invalid_destination', 'That destination deck does not exist.');
    }

    const now = Date.now();
    const occupants = db
      .prepare(
        "SELECT id FROM orders WHERE oven_layer_id = :id AND status = 'BAKING' " +
          'AND cancelled_at IS NULL ORDER BY oven_slot',
      )
      .all({ id }) as { id: number }[];

    // Clear every reference first - including any cancelled leftovers - so neither the
    // unique index nor the foreign key has anything to trip over.
    db.prepare(
      'UPDATE orders SET oven_layer_id = NULL, oven_slot = NULL, updated_at = :now ' +
        'WHERE oven_layer_id = :id',
    ).run({ id, now });

    let moved = 0;
    let toUnplaced = 0;

    if (moveTo === null) {
      toUnplaced = occupants.length;
    } else {
      const dest = getLayer(moveTo);
      const taken = new Set(
        (
          db
            .prepare(
              "SELECT oven_slot AS s FROM orders WHERE oven_layer_id = :d " +
                "AND status = 'BAKING' AND cancelled_at IS NULL",
            )
            .all({ d: moveTo }) as { s: number }[]
        ).map((r) => Number(r.s)),
      );
      const free: number[] = [];
      for (let i = 0; i < (dest?.capacity ?? 0); i += 1) if (!taken.has(i)) free.push(i);

      const assign = db.prepare(
        'UPDATE orders SET oven_layer_id = :d, oven_slot = :s, updated_at = :now WHERE id = :oid',
      );
      for (const o of occupants) {
        const slot = free.shift();
        if (slot === undefined) {
          toUnplaced += 1;
          continue;
        }
        assign.run({ d: moveTo, s: slot, now, oid: o.id });
        moved += 1;
      }
    }

    db.prepare('DELETE FROM oven_layers WHERE id = :id').run({ id });
    log(`LAYER -${id} moved ${moved} pizza(s) to ${moveTo ?? 'unplaced'}, ${toUnplaced} unplaced`);
    return { moved, toUnplaced, to: moveTo };
  });
}

// ===========================================================================================
// Crew: pizza types (the menu)
// ===========================================================================================

export function createPizzaType(input: {
  name: string;
  emoji: string;
  ingredients: string[];
  bakeSeconds: number;
}): PizzaType {
  return mutate(() => {
    const now = Date.now();
    const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM pizza_types').get() as {
      p: number;
    };
    const result = db
      .prepare(
        'INSERT INTO pizza_types (name, emoji, ingredients, bake_seconds, position, ' +
          'created_at, updated_at) ' +
          'VALUES (:name, :emoji, :ingredients, :bakeSeconds, :position, :now, :now)',
      )
      .run({
        name: input.name,
        emoji: input.emoji || DEFAULT_PIZZA_EMOJI,
        ingredients: JSON.stringify(input.ingredients),
        bakeSeconds: clamp(input.bakeSeconds, 30, 3600),
        position: maxPos.p + 1,
        now,
      });
    const id = Number(result.lastInsertRowid);
    log(`TYPE +${id} "${input.name}"`);
    const row = db.prepare('SELECT * FROM pizza_types WHERE id = :id').get({ id }) as Row;
    return rowToPizzaType(row);
  });
}

export function updatePizzaType(
  id: number,
  input: {
    name?: string;
    emoji?: string;
    ingredients?: string[];
    bakeSeconds?: number;
    soldOut?: boolean;
    position?: number;
    archived?: boolean;
  },
): PizzaType {
  return mutate(() => {
    const row = db.prepare('SELECT * FROM pizza_types WHERE id = :id').get({ id }) as Row | undefined;
    if (!row) throw notFound('type_not_found', 'That pizza type no longer exists.');
    const before = rowToPizzaType(row);
    const now = Date.now();

    let archivedAt = before.archivedAt;
    if (input.archived !== undefined) archivedAt = input.archived ? (archivedAt ?? now) : null;

    // NOTE: orders.pizza_type_name is deliberately NOT touched. A pizza someone already
    // ordered keeps the name they ordered it under.
    db.prepare(
      'UPDATE pizza_types SET name = :name, emoji = :emoji, ingredients = :ingredients, ' +
        'bake_seconds = :bakeSeconds, sold_out = :soldOut, archived_at = :archivedAt, ' +
        'position = :position, updated_at = :now WHERE id = :id',
    ).run({
      id,
      name: input.name ?? before.name,
      emoji: input.emoji || before.emoji,
      ingredients: JSON.stringify(input.ingredients ?? before.ingredients),
      bakeSeconds: clamp(input.bakeSeconds ?? before.bakeSeconds, 30, 3600),
      soldOut: (input.soldOut ?? before.soldOut) ? 1 : 0,
      archivedAt,
      position: input.position ?? before.position,
      now,
    });

    const after = db.prepare('SELECT * FROM pizza_types WHERE id = :id').get({ id }) as Row;
    return rowToPizzaType(after);
  });
}

/** Hard delete only when nothing references it. Otherwise the caller is told to retire it,
 *  because an order must never lose the thing it points at. */
export function deletePizzaType(id: number): void {
  mutate(() => {
    const row = db.prepare('SELECT * FROM pizza_types WHERE id = :id').get({ id }) as Row | undefined;
    if (!row) throw notFound('type_not_found', 'That pizza type no longer exists.');

    const used = db
      .prepare('SELECT count(*) AS n FROM orders WHERE pizza_type_id = :id')
      .get({ id }) as { n: number };
    if (used.n > 0) {
      throw new ApiError(
        409,
        'type_in_use',
        `${used.n} order(s) use this pizza. Retire it instead - it will disappear from the ` +
          'order form and those orders keep working.',
        { orders: used.n },
      );
    }

    db.prepare('DELETE FROM pizza_types WHERE id = :id').run({ id });
    log(`TYPE -${id}`);
  });
}

// ===========================================================================================
// Crew: settings
// ===========================================================================================

export function updateSettings(input: { ordersOpen?: boolean }): void {
  mutate(() => {
    if (input.ordersOpen !== undefined) {
      writeSetting('orders_open', input.ordersOpen ? '1' : '0');
      log(`SETTINGS orders_open=${input.ordersOpen ? 1 : 0}`);
    }
  });
}

export { allLayers };
