export const STATUS = {
  ORDERED: 'ORDERED',
  IN_PREPARATION: 'IN_PREPARATION',
  WAITING_FOR_OVEN: 'WAITING_FOR_OVEN',
  BAKING: 'BAKING',
  READY: 'READY',
  PICKED_UP: 'PICKED_UP',
} as const;

export type Status = (typeof STATUS)[keyof typeof STATUS];

/** The pipeline, in order. `cancelled` is a flag on the row, never a status. */
export const STATUS_ORDER: Status[] = [
  STATUS.ORDERED,
  STATUS.IN_PREPARATION,
  STATUS.WAITING_FOR_OVEN,
  STATUS.BAKING,
  STATUS.READY,
  STATUS.PICKED_UP,
];

export function isStatus(v: unknown): v is Status {
  return typeof v === 'string' && (STATUS_ORDER as string[]).includes(v);
}

/** A bidirectional line: forward one step or back one step. Nothing else. */
export function canTransition(from: Status, to: Status): boolean {
  const a = STATUS_ORDER.indexOf(from);
  const b = STATUS_ORDER.indexOf(to);
  return a !== -1 && b !== -1 && Math.abs(b - a) === 1;
}

/** Human labels. Never stored - the database only ever holds the enum value. */
export const STATUS_LABEL: Record<Status, string> = {
  ORDERED: 'Ordered',
  IN_PREPARATION: 'In preparation',
  WAITING_FOR_OVEN: 'Waiting for oven',
  BAKING: 'On fire',
  READY: 'Ready',
  PICKED_UP: 'Collected',
};

/** The reason string the customer's own cancel writes; distinguishes it from a crew no-show. */
export const CUSTOMER_CANCEL_REASON = 'cancelled by customer';
