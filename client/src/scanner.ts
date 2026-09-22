import jsQRImport from 'jsqr';
import type { QRCode } from 'jsqr';
import { looksLikePickupCode, normalizePickupCode } from '../../shared/pickupCode.ts';

/**
 * jsQR ships a CommonJS UMD bundle with ESM-shaped .d.ts, so under `nodenext` the default
 * import is typed as the module namespace and loses its call signature - while at runtime
 * `module.exports` IS the function. Both shapes are accepted here rather than guessed at,
 * because which one a bundler hands over is exactly the kind of thing that differs between
 * dev and a production build.
 */
type JsQR = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options?: { inversionAttempts?: 'dontInvert' | 'onlyInvert' | 'attemptBoth' | 'invertFirst' },
) => QRCode | null;

const jsQRUnknown: unknown = jsQRImport;
const jsQR: JsQR =
  typeof jsQRUnknown === 'function'
    ? (jsQRUnknown as JsQR)
    : (jsQRUnknown as { default: JsQR }).default;

/**
 * In-page QR scanning.
 *
 * This only runs where the browser considers the origin trustworthy - https, localhost, or
 * Chrome with the origin added to chrome://flags/#unsafely-treat-insecure-origin-as-secure.
 * On a plain LAN address without that flag `navigator.mediaDevices` does not exist at all,
 * which is why the caller feature-detects rather than catching an error. See README.
 *
 * jsQR rather than the native BarcodeDetector: BarcodeDetector is missing on Windows and
 * desktop Linux Chrome, so a native-first design would leave the decode path untestable on
 * the machine this was written on. One path that always runs is worth more here than a fast
 * path nobody can exercise.
 */

/** What a scanned string turned out to be. */
export type ScannedTicket = { token: string } | { code: string };

/** A 16-byte token is 22 base64url characters; the range allows for future changes. */
const TOKEN_IN_URL = /\/(?:t|order)\/([A-Za-z0-9_-]{16,64})\/?$/;
const BARE_TOKEN = /^[A-Za-z0-9_-]{22}$/;

/**
 * Turn whatever the camera read into something the crew API can resolve.
 *
 * The ORIGIN in a scanned URL is deliberately ignored. If the Pi's address changed since a
 * guest saved their ticket, the token in that old URL is still the right token - refusing it
 * because the host no longer matches would break exactly the ticket that needs helping.
 */
export function ticketFromScan(text: string): ScannedTicket | null {
  const trimmed = text.trim();

  const inUrl = trimmed.match(TOKEN_IN_URL);
  if (inUrl) return { token: inUrl[1] };

  if (BARE_TOKEN.test(trimmed)) return { token: trimmed };

  if (looksLikePickupCode(trimmed)) return { code: normalizePickupCode(trimmed) };

  return null;
}

/** Frames are downscaled to this on the long edge before decoding. */
const DECODE_EDGE = 480;
/** ~10 fps. Faster buys nothing: a hand holding a phone is not moving that quickly. */
const FRAME_MS = 100;

export type ScannerHandle = { stop: () => void };

export type ScannerOptions = {
  video: HTMLVideoElement;
  onResult: (text: string) => void;
  onError: (message: string) => void;
};

function messageFor(e: unknown): string {
  const name = e instanceof Error ? e.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Camera permission was refused. Allow it in the browser, or type the code instead.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No camera on this device. Type the pickup code instead.';
  }
  if (name === 'NotReadableError') {
    return 'The camera is busy in another app. Close it, or type the code instead.';
  }
  return 'Could not start the camera. Type the pickup code instead.';
}

/**
 * Starts the camera and decodes until it finds something or stop() is called.
 *
 * ALWAYS call stop(). A MediaStream outlives the React tree that created it, so a forgotten
 * one leaves the camera light on after the sheet is closed - which on a borrowed phone looks
 * exactly like spyware.
 */
export async function startScanner({
  video,
  onResult,
  onError,
}: ScannerOptions): Promise<ScannerHandle> {
  let stopped = false;
  let timer: number | undefined;
  let stream: MediaStream | undefined;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) window.clearTimeout(timer);
    // Every track, not just the first: a device with several cameras hands back several.
    stream?.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  };

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      // The rear camera on a phone. Not `exact`, so a laptop with only a front camera still
      // works rather than throwing OverconstrainedError.
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
  } catch (e) {
    onError(messageFor(e));
    return { stop };
  }

  // The sheet may have been closed while the permission prompt was up.
  if (stopped) {
    stream.getTracks().forEach((t) => t.stop());
    return { stop };
  }

  video.srcObject = stream;
  video.playsInline = true;
  video.muted = true;
  try {
    await video.play();
  } catch {
    // Safari can reject play() on a stream that is already rendering. The frame loop below
    // reads from the element either way, so this is not worth failing over.
  }

  const canvas = document.createElement('canvas');
  // willReadFrequently keeps getImageData on the CPU path; without it Chrome round-trips the
  // GPU on every frame and warns about it.
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    onError('This browser cannot read camera frames.');
    stop();
    return { stop };
  }

  const tick = () => {
    if (stopped) return;

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (vw > 0 && vh > 0) {
      const scale = Math.min(1, DECODE_EDGE / Math.max(vw, vh));
      canvas.width = Math.round(vw * scale);
      canvas.height = Math.round(vh * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
      // dontInvert: our codes are always dark on white, and trying the inverse doubles the
      // work every frame for a case that cannot happen.
      const found = jsQR(frame.data, frame.width, frame.height, { inversionAttempts: 'dontInvert' });
      if (found?.data) {
        // Stop BEFORE handing the result up: the callback navigates, and a frame loop still
        // running against a torn-down element is a leak with a camera light attached.
        stop();
        onResult(found.data);
        return;
      }
    }

    timer = window.setTimeout(tick, FRAME_MS);
  };

  tick();
  return { stop };
}
