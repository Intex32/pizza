import { STATUS } from '../../shared/status.ts';
import type { Status } from '../../shared/status.ts';
import type { Order } from '../../shared/types.ts';
import { bakeState, elapsed } from './useNow.ts';

/**
 * Where a pizza physically is, by status. null means no board shows it, so a scan that lands
 * there must explain rather than navigate.
 */
const SCREEN_FOR: Record<Status, string | null> = {
  [STATUS.ORDERED]: '/crew/orders',
  [STATUS.IN_PREPARATION]: '/crew/prep',
  // The queue was merged into the oven screen, so both of these live there.
  [STATUS.WAITING_FOR_OVEN]: '/crew/oven',
  [STATUS.BAKING]: '/crew/oven',
  [STATUS.READY]: '/crew/ready',
  [STATUS.PICKED_UP]: null,
};

export type ScanOutcome =
  | { kind: 'go'; to: string; note: string }
  | { kind: 'explain'; title: string; note: string };

/**
 * The crew voice, which is NOT statusCopy's voice. statusCopy talks to a guest ("being made
 * right now"); a crew member holding a phone wants a place and a duration.
 *
 * Every elapsed() value gets an explicit "for" or "ago". It renders as mm:ss, so "on the
 * shelf, 13:53" reads as ten to two rather than as fourteen minutes - the boards get away
 * with a bare number only because a label sits next to it.
 */
export function whereIs(order: Order, now: number): string {
  const who = `#${order.id} ${order.customerName}`;
  switch (order.status) {
    case STATUS.ORDERED:
      return `${who} - at the counter, not paid yet`;
    case STATUS.IN_PREPARATION:
      return `${who} - on the prep bench for ${elapsed(order.paidAt, now)}`;
    case STATUS.WAITING_FOR_OVEN:
      return `${who} - waiting for the oven for ${elapsed(order.queuedAt, now)}`;
    case STATUS.BAKING: {
      // bakeState already formats the label, including the leading + once it is overdue.
      // Re-deriving it here would be a second place for the timer to disagree with the oven.
      const bake = bakeState(order.bakingStartedAt, order.bakeSeconds, now);
      return bake.expired
        ? `${who} - in the oven, OVERDUE ${bake.label}`
        : `${who} - in the oven, ${bake.label} left`;
    }
    case STATUS.READY:
      return `${who} - on the ready shelf for ${elapsed(order.readyAt, now)}`;
    default:
      return who;
  }
}

/**
 * What a resolved scan should do.
 *
 * cancelledAt is checked BEFORE status on purpose: cancelled is a flag on the row, not a
 * status, so a cancelled order still carries a live-looking status and would otherwise be
 * sent to a board that deliberately filters it out.
 *
 * Neither terminal case offers a button to change anything. Scanning finds a pizza; it must
 * never move one.
 */
export function scanOutcome(order: Order, now: number): ScanOutcome {
  if (order.cancelledAt !== null) {
    const why = order.cancelReason ? ` (${order.cancelReason})` : '';
    return {
      kind: 'explain',
      title: `#${order.id} ${order.customerName} - cancelled`,
      note: `Cancelled${why} ${elapsed(order.cancelledAt, now)} ago. Nothing is being made.`,
    };
  }

  const to = SCREEN_FOR[order.status];
  if (to === null) {
    // The most valuable non-navigating answer there is: no board can tell you this.
    return {
      kind: 'explain',
      title: `#${order.id} ${order.customerName} - already collected`,
      note: `Handed over ${elapsed(order.pickedUpAt, now)} ago.`,
    };
  }

  return { kind: 'go', to: `${to}?focus=${order.id}`, note: whereIs(order, now) };
}
