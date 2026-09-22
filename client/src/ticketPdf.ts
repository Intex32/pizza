import { QR_MARGIN, qrModules } from './qrMatrix.ts';

/**
 * A one-page pickup ticket as a PDF, written by hand.
 *
 * No jsPDF: this needs rectangles, three base-14 fonts and no images, which is about 150
 * lines of PDF rather than 350 KB of library. The QR is emitted as VECTOR rectangles, so it
 * stays sharp at any zoom and prints cleanly - strictly better than embedding a bitmap, and
 * it avoids needing a Flate or JPEG encoder in the browser.
 *
 * THE WHOLE FILE IS BUILT AS A "BINARY STRING": every character in it has a code <= 255 and
 * stands for exactly one byte. That is not a stylistic choice. A PDF's xref table holds BYTE
 * offsets, and 'u-umlaut'.length === 1 while its UTF-8 form is two bytes - so building this
 * as ordinary text and measuring with .length would silently corrupt the xref for exactly
 * the names this kitchen will type. Keeping one char == one byte makes .length correct by
 * construction, and assertAllBytes() below refuses to emit anything that breaks the rule.
 */

// A6, in points. Big enough that the QR prints at ~60 mm, small enough to be a ticket.
const PAGE_W = 298;
const PAGE_H = 420;

const INK = '0.09 0.075 0.063';
const MUTED = '0.478 0.416 0.361';
const ACCENT = '0.761 0.255 0.047';

// --- Base-14 metrics -------------------------------------------------------------------
// Widths for codes 32..126 in 1/1000 em. Needed only to centre text: without them every
// line would be left-aligned or guessed, and a visibly off-centre ticket reads as broken.
// Latin-1 accented letters are the width of their base letter in these faces, which is why
// the >126 fallback below is accurate rather than a guess.
const HELV = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
  611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
  222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const HELV_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667,
  611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556,
  278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

type Face = { res: string; widths: number[] | null };
const F_REGULAR: Face = { res: '/F1', widths: HELV };
const F_BOLD: Face = { res: '/F2', widths: HELV_BOLD };
/** Courier-Bold is monospaced: every glyph is 600. */
const F_MONO: Face = { res: '/F3', widths: null };

/** The width of 'o', used for any accented letter - they match their base glyph. */
const FALLBACK_INDEX = 'o'.charCodeAt(0) - 32;

/**
 * Latin-1 is WinAnsiEncoding for everything a name here will contain, so an umlaut is one
 * byte and renders correctly. Anything outside it has no glyph in a base-14 font at all, so
 * strip the diacritic if that lands in range and otherwise emit '?' - a visible wrong
 * character rather than a silent drop.
 */
function toLatin1(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 63;
    if (cp <= 255) {
      out += ch;
      continue;
    }
    const bare = ch.normalize('NFD').replace(/[̀-ͯ]/g, '').codePointAt(0) ?? 63;
    out += String.fromCharCode(bare <= 255 ? bare : 63);
  }
  return out;
}

function widthOf(text: string, face: Face, size: number, tracking: number): number {
  const latin = toLatin1(text);
  let units = 0;
  for (const ch of latin) {
    const c = ch.charCodeAt(0);
    if (!face.widths) units += 600;
    else if (c >= 32 && c <= 126) units += face.widths[c - 32];
    else units += face.widths[FALLBACK_INDEX];
  }
  // Tracking sits between glyphs, so n-1 gaps contribute to the visible width.
  return (units / 1000) * size + Math.max(0, latin.length - 1) * tracking;
}

/** A PDF string literal. Escapes the only three bytes that can terminate or confuse one. */
function lit(text: string): string {
  return '(' + toLatin1(text).replace(/([\\()])/g, '\\$1') + ')';
}

function centred(
  text: string,
  face: Face,
  size: number,
  y: number,
  colour: string,
  tracking = 0,
): string {
  const x = (PAGE_W - widthOf(text, face, size, tracking)) / 2;
  return (
    colour +
    ' rg\nBT ' +
    face.res +
    ' ' +
    size +
    ' Tf ' +
    tracking +
    ' Tc ' +
    x.toFixed(2) +
    ' ' +
    y.toFixed(2) +
    ' Td ' +
    lit(text) +
    ' Tj ET\n'
  );
}

export type TicketInput = {
  orderId: number;
  customerName: string;
  pizzaTypeName: string;
  pickupCode: string;
  url: string;
  placedAt: number;
};

function contentStream(t: TicketInput): string {
  let c = '';

  c += centred('PIZZA NIGHT', F_BOLD, 9, PAGE_H - 28, MUTED, 2.6);
  c += centred('#' + t.orderId, F_BOLD, 46, PAGE_H - 76, INK);
  c += centred(t.customerName, F_BOLD, 16, PAGE_H - 99, INK);
  c += centred(t.pizzaTypeName, F_REGULAR, 11, PAGE_H - 114, MUTED);

  // The perforation. This is what makes it read as a ticket rather than a screenshot.
  const ruleY = PAGE_H - 130;
  c += MUTED + ' RG\n0.8 w [3 3] 0 d\n24 ' + ruleY + ' m 274 ' + ruleY + ' l S\n[] 0 d\n';

  // --- QR, as vector rectangles ---
  const { dark, count } = qrModules(t.url);
  const span = count + QR_MARGIN * 2;
  // 150pt is 53mm printed, which scans comfortably. It is sized DOWN from the page rather
  // than up from the modules: at 182 the code below it collided with the footer, which only
  // showed up once the file was opened in a real PDF viewer.
  const plate = 150;
  const cell = plate / span;
  const qx = (PAGE_W - plate) / 2;
  const qy = ruleY - 12 - plate;

  c += '1 1 1 rg\n' + qx.toFixed(2) + ' ' + qy.toFixed(2) + ' ' + plate + ' ' + plate + ' re f\n';
  c += '0 0 0 rg\n';
  for (let r = 0; r < count; r += 1) {
    for (let col = 0; col < count; col += 1) {
      if (!dark[r][col]) continue;
      const x = qx + (col + QR_MARGIN) * cell;
      // PDF's y grows upward while the matrix's rows grow downward, so the row index is
      // measured from the far edge. Getting this wrong mirrors the code vertically.
      const y = qy + (span - 1 - (r + QR_MARGIN)) * cell;
      // +0.02 closes the hairline seam between neighbouring modules that some rasterisers
      // leave when a cell lands on a fractional device pixel.
      const s = (cell + 0.02).toFixed(2);
      c += x.toFixed(2) + ' ' + y.toFixed(2) + ' ' + s + ' ' + s + ' re f\n';
    }
  }

  const codeY = qy - 24;
  c += centred('PICKUP CODE', F_BOLD, 8, codeY, MUTED, 2.4);
  c += centred(t.pickupCode, F_MONO, 30, codeY - 34, ACCENT, 4);

  const placed = new Date(t.placedAt).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
  // Deliberately NO status: a saved ticket reading "ORDERED" while the pizza is already on
  // the ready shelf is worse than no ticket at all.
  c += centred('Show this at the counter for live status', F_REGULAR, 7.5, 40, MUTED);
  c += centred(t.url + '  -  placed ' + placed, F_REGULAR, 6.5, 26, MUTED);

  return c;
}

function assertAllBytes(s: string): void {
  for (let i = 0; i < s.length; i += 1) {
    if (s.charCodeAt(i) > 255) {
      throw new Error('ticketPdf: non-byte char at ' + i + ' - xref offsets would be wrong');
    }
  }
}

export function buildTicketPdf(t: TicketInput): Blob {
  const content = contentStream(t);

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' +
      PAGE_W +
      ' ' +
      PAGE_H +
      '] /Resources << /Font << /F1 5 0 R /F2 6 0 R /F3 7 0 R >> >> /Contents 4 0 R >>',
    '<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length); // one char == one byte, by the invariant at the top
    pdf += i + 1 + ' 0 obj\n' + body + '\nendobj\n';
  });

  const startxref = pdf.length;
  pdf += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
  // Each entry is EXACTLY 20 bytes. Readers seek by multiplying, so a short line here
  // breaks every object after it.
  for (const off of offsets) pdf += String(off).padStart(10, '0') + ' 00000 n \n';
  pdf +=
    'trailer\n<< /Size ' +
    (objects.length + 1) +
    ' /Root 1 0 R >>\nstartxref\n' +
    startxref +
    '\n%%EOF\n';

  assertAllBytes(pdf);
  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i += 1) bytes[i] = pdf.charCodeAt(i);
  return new Blob([bytes], { type: 'application/pdf' });
}
