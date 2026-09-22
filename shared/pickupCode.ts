/**
 * The human-readable half of a pickup ticket.
 *
 * Deliberately free of node:crypto and of the DOM: the server derives the code and the crew
 * screens normalise what someone types into it, so both halves must agree on the alphabet.
 * A second, drifted copy of that alphabet is a lookup that silently never matches.
 */

/**
 * 32 symbols, so one symbol is exactly five bits and the encoder needs no rejection
 * sampling. It is [2-9] plus [A-Z] minus I and O - 8 + 24 = 32 on the nose.
 *
 * 0/O and 1/I are the pairs people actually get wrong reading a code off a phone screen at
 * a counter. Both are removed ENTIRELY rather than folded together: a code that can never
 * contain a 0 or an O cannot be mistyped in that direction at all. 2/Z, 5/S, 6/G and 8/B
 * survive - they are far milder, the code is always rendered monospaced, and a lookup that
 * shows every match by name absorbs the rest.
 */
export const PICKUP_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/** 5 symbols = 25 bits = 33,554,432 codes. See server/pickupCode.ts for why not 4. */
export const PICKUP_CODE_LENGTH = 5;

/** What a crew member typed -> what to compare. Spaces, hyphens and case are noise. */
export function normalizePickupCode(input: string): string {
  return input.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/**
 * True only for something that could BE a code. Lets the crew search tell "K7M2Q" from
 * "Anna" without guessing, and lets a typed 0/1/I/O be rejected with a real message
 * instead of a silent no-match.
 */
export function looksLikePickupCode(input: string): boolean {
  const s = normalizePickupCode(input);
  return s.length === PICKUP_CODE_LENGTH && [...s].every((c) => PICKUP_ALPHABET.includes(c));
}
