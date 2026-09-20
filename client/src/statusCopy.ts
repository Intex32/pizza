import { CUSTOMER_CANCEL_REASON, STATUS } from '../../shared/status.ts';
import type { Status } from '../../shared/status.ts';
import type { Order } from '../../shared/types.ts';

/**
 * Per-status copy, not just a chip. In a trust-based pre-order model the single most likely
 * confusion is a guest thinking a pre-order means their pizza is already being made, so the
 * ORDERED line says out loud what has to happen next.
 */
const COPY: Record<Status, string> = {
  [STATUS.ORDERED]:
    'Pre-ordered. Come to the counter and pay when you arrive — we start making it then.',
  [STATUS.IN_PREPARATION]: 'Paid — being made right now.',
  [STATUS.WAITING_FOR_OVEN]: 'Next up for the oven.',
  [STATUS.BAKING]: 'In the oven.',
  [STATUS.READY]: 'Ready — collect it now!',
  [STATUS.PICKED_UP]: 'Collected. Enjoy!',
};

export function statusCopy(order: Order): string {
  if (order.cancelledAt !== null) {
    return order.cancelReason === CUSTOMER_CANCEL_REASON
      ? 'You cancelled this order.'
      : 'Cancelled — talk to the crew.';
  }
  return COPY[order.status];
}

/** The cancel button only exists while the server would actually accept it. */
export function canCustomerCancel(order: Order): boolean {
  return order.cancelledAt === null && order.status === STATUS.ORDERED && order.paidAt === null;
}
