import { createHash } from 'node:crypto';
import { PICKUP_ALPHABET, PICKUP_CODE_LENGTH } from '../shared/pickupCode.ts';

/**
 * A short code a crew member can read off a guest's phone and type, derived from that
 * order's public_token.
 *
 * DELIBERATELY NOT A COLUMN:
 *   - no schema change, so no drift check to satisfy and no migration on an existing db;
 *   - it cannot get out of sync with the token it names, because it IS the token;
 *   - it survives a backup/restore byte for byte, and a move to a different Pi.
 *
 * NOT SALTED, on purpose. A salt drawn from CREW_PASSWORD or from a boot-time random would
 * silently invalidate every ticket a guest has already saved the moment the operator
 * changed the password or restarted the container. Determinism is the feature here, and
 * sha256 of a 128-bit random token is preimage-resistant without one: the code tells an
 * attacker nothing about the token it came from.
 *
 * IT IS A LOOKUP KEY, NEVER A CREDENTIAL. 25 bits is brute-forceable, so the route that
 * accepts it sits behind requireCrew, and GET /api/orders/:token must never fall back to
 * matching it - that would turn a code readable across a room into a cancel capability.
 */

/** An evening is ~100 orders, so this never grows; the bound is only here to be safe. */
const cache = new Map<string, string>();

export function pickupCodeFor(publicToken: string): string {
  const hit = cache.get(publicToken);
  if (hit !== undefined) return hit;

  const d = createHash('sha256').update(publicToken, 'utf8').digest();

  // Five bits at a time out of the first four bytes, MSB first. A two-byte window always
  // covers a 5-bit field wherever it starts, so there is no carry state to get wrong.
  let code = '';
  for (let i = 0; i < PICKUP_CODE_LENGTH; i += 1) {
    const bit = i * 5;
    const byte = bit >> 3;
    const shift = bit & 7;
    const window = ((d[byte] << 8) | d[byte + 1]) >>> (11 - shift);
    code += PICKUP_ALPHABET[window & 31];
  }

  if (cache.size > 5000) cache.clear();
  cache.set(publicToken, code);
  return code;
}
