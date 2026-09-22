/**
 * How a pizza was paid for, recorded at the moment the counter sends it to preparation.
 *
 * "free" is a real answer, not a missing one: a pizza that went to another crew member was
 * genuinely never paid for, and lumping that in with "we forgot to record it" would make the
 * end-of-night reckoning impossible.
 */
export const PAYMENT_METHODS = ['cash', 'paypal', 'free'] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export function isPaymentMethod(v: unknown): v is PaymentMethod {
  return typeof v === 'string' && (PAYMENT_METHODS as readonly string[]).includes(v);
}

export const PAYMENT_LABEL: Record<PaymentMethod, string> = {
  cash: 'Cash',
  paypal: 'PayPal',
  free: 'Free',
};

export const PAYMENT_EMOJI: Record<PaymentMethod, string> = {
  cash: '💶',
  paypal: '🅿️',
  free: '🎁',
};

/** Shown on the confirmation buttons at the counter. */
export const PAYMENT_HINT: Record<PaymentMethod, string> = {
  cash: 'Money in the tin',
  paypal: 'Paid on their phone',
  free: 'Crew, comped, on the house',
};

export const DEFAULT_PIZZA_EMOJI = '🍕';
