import qrcode from 'qrcode-generator';

// Kept out of qr.tsx deliberately: building the matrix is not a React concern, and a
// plain .ts module can be imported by the PDF writer and exercised directly by node,
// which is how the payload gets decoded and asserted in the tests.

/**
 * The quiet zone, in modules. The spec says 4 and iOS's camera genuinely gives up below 3,
 * so this is not a margin you tune for looks.
 */
export const QR_MARGIN = 4;

/**
 * The one place the library is called. Both the on-screen SVG and the PDF go through here,
 * so a QR printed on a ticket can never disagree with the one on the guest's screen.
 *
 * Error correction 'M' (15%), not 'H'. 'H' buys nothing on clean phone glass and makes every
 * module physically smaller, which is the only thing that actually stops a scan.
 *
 * ASCII ONLY. The library's default stringToBytes maps each UTF-16 code unit to one byte -
 * it is Latin-1, not UTF-8 - so a customer name or an emoji in here would encode as mojibake.
 * Our payload is an origin plus a base64url token, which is why that is safe.
 */
export function qrModules(value: string): { dark: boolean[][]; count: number } {
  const qr = qrcode(0, 'M'); // 0 = smallest version that fits
  qr.addData(value);
  qr.make();
  const count = qr.getModuleCount();
  const dark: boolean[][] = [];
  for (let r = 0; r < count; r += 1) {
    const row: boolean[] = [];
    // isDark takes (row, col) in that order. Swapping them yields a plausible-looking
    // matrix that no scanner can read, which is why the tests decode a real one.
    for (let c = 0; c < count; c += 1) row.push(qr.isDark(r, c));
    dark.push(row);
  }
  return { dark, count };
}
