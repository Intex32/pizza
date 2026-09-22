import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { ApiError, crewApi, serverNow } from '../api.ts';
import { Modal, PizzaEmoji, StatusChip } from '../components.tsx';
import { useLive } from '../live.tsx';
import { scanOutcome, whereIs } from '../scan.ts';
import type { ScanOutcome } from '../scan.ts';
import { startScanner, ticketFromScan } from '../scanner.ts';
import type { ScannerHandle } from '../scanner.ts';
import { PICKUP_CODE_LENGTH, normalizePickupCode } from '../../../shared/pickupCode.ts';
import type { Order } from '../../../shared/types.ts';

/**
 * Whether the browser will hand this page a camera at all.
 *
 * Outside a secure context `navigator.mediaDevices` is not merely blocked, it is UNDEFINED -
 * so this is a feature detect rather than a try/catch. It is true over https and on
 * localhost, and can be forced on for a LAN address through
 * chrome://flags/#unsafely-treat-insecure-origin-as-secure.
 *
 * When it is false the scan button is not rendered at all. A disabled button invites repeated
 * tapping and reads like a bug; a sentence explaining the alternative reads like a decision.
 */
const IN_PAGE_SCAN_POSSIBLE =
  window.isSecureContext && Boolean(navigator.mediaDevices?.getUserMedia);

type Result =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'error'; message: string }
  | { kind: 'choose'; orders: Order[] }
  | { kind: 'explain'; outcome: Extract<ScanOutcome, { kind: 'explain' }> };

export function FindOrderModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const { pushToast } = useLive();
  const [code, setCode] = useState('');
  const [result, setResult] = useState<Result>({ kind: 'idle' });
  // Scanning is what the crew came here to do, so the sheet opens straight into it rather
  // than waiting for a tap they would make every single time.
  const [scanning, setScanning] = useState(IN_PAGE_SCAN_POSSIBLE);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const act = (order: Order) => {
    const outcome = scanOutcome(order, serverNow());
    if (outcome.kind === 'explain') {
      setResult({ kind: 'explain', outcome });
      return;
    }
    pushToast(outcome.note);
    onClose();
    navigate(outcome.to);
  };

  const resolve = async (body: { token: string } | { code: string }) => {
    setResult({ kind: 'busy' });
    try {
      // NOT live.run(): that refreshes the whole snapshot on success and throws the response
      // away, and the response is the only thing wanted here. This is a read.
      const res = await crewApi.resolve(body);
      act(res.order);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'ambiguous_code') {
        setResult({ kind: 'choose', orders: (e.details as { orders?: Order[] })?.orders ?? [] });
        return;
      }
      // Kept inside the sheet rather than fired as a toast the sheet would cover.
      // A 401 needs nothing: LiveProvider's poll redirects to the login within a second.
      setResult({
        kind: 'error',
        message: e instanceof ApiError ? e.message : 'Could not reach the kitchen.',
      });
    }
  };

  /**
   * The camera's whole lifecycle, owned by one effect keyed on `scanning`.
   *
   * Effects run AFTER React has committed the DOM, which is the point: videoRef.current is
   * guaranteed to exist here. An earlier version started the camera imperatively and waited a
   * microtask for the <video> to appear - that happened to win the race when a click triggered
   * it and lost it when the sheet opened straight into scanning, leaving a viewfinder with no
   * stream attached and no error to show for it.
   *
   * The cleanup also covers closing the sheet, Escape, a backdrop tap and unmount in one go.
   * A MediaStream outlives the React tree that made it, and a forgotten one leaves the camera
   * light on after the crew member has walked away.
   */
  useEffect(() => {
    if (!scanning) return;
    const video = videoRef.current;
    if (!video) return;

    let cancelled = false;
    let handle: ScannerHandle | null = null;

    void startScanner({
      video,
      onResult: (text) => {
        setScanning(false);
        const ticket = ticketFromScan(text);
        if (!ticket) {
          setResult({ kind: 'error', message: 'That QR code is not a Pizza Night ticket.' });
          return;
        }
        void resolve(ticket);
      },
      onError: (message) => {
        setScanning(false);
        setResult({ kind: 'error', message });
        // The camera just became unavailable, so the code field is the only way forward.
        inputRef.current?.focus();
      },
    }).then((h) => {
      handle = h;
      // Stopped while getUserMedia was still resolving - usually the permission prompt was
      // still up when the sheet was closed.
      if (cancelled) h.stop();
    });

    return () => {
      cancelled = true;
      handle?.stop();
    };
  }, [scanning]);

  const lookUpCode = async (raw: string) => {
    const clean = normalizePickupCode(raw);
    if (clean.length !== PICKUP_CODE_LENGTH) return;
    await resolve({ code: clean });
  };

  const onChange = (raw: string) => {
    const clean = normalizePickupCode(raw).slice(0, PICKUP_CODE_LENGTH);
    setCode(clean);
    if (result.kind !== 'idle') setResult({ kind: 'idle' });
    // Fire on the last character: at a counter, a separate "search" button is one tap nobody
    // should have to find.
    if (clean.length === PICKUP_CODE_LENGTH) void lookUpCode(clean);
  };

  return (
    <Modal
      title="Find an order"
      onClose={onClose}
      actions={
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      }
    >
      {scanning ? (
        <div className="scanner">
          {/* muted + playsInline are what let a stream autoplay without a gesture. */}
          <video ref={videoRef} className="scanner-video" muted playsInline />
          <div className="scanner-frame" aria-hidden="true" />
        </div>
      ) : null}

      {scanning ? (
        <p className="hint" style={{ textAlign: 'center', marginTop: 0 }}>
          Point it at the QR on the guest's phone.
        </p>
      ) : null}

      {/* Always here, never swapped out for the camera. A dead battery, a cracked screen or a
          guest who deleted the tab all end the same way: someone reads five characters out. */}
      <label className="field" htmlFor="pickup">
        {scanning ? 'Or type the pickup code' : 'Pickup code'}
      </label>
      <input
        id="pickup"
        ref={inputRef}
        className="input search"
        // Not focused while the camera is up: on a phone the keyboard would slide over the
        // very viewfinder they are trying to aim.
        autoFocus={!IN_PAGE_SCAN_POSSIBLE}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        maxLength={PICKUP_CODE_LENGTH}
        placeholder="K7M2Q"
        value={code}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void lookUpCode(code);
        }}
        style={{
          letterSpacing: '0.25em',
          fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
        }}
      />

      {IN_PAGE_SCAN_POSSIBLE ? (
        <button
          type="button"
          className="btn btn-block"
          style={{ marginTop: 10 }}
          onClick={() => setScanning((v) => !v)}
        >
          {scanning ? 'Turn the camera off' : '📷 Scan the ticket QR'}
        </button>
      ) : (
        <div className="hint">
          Or point your phone's own camera app at the guest's QR — it opens straight to the
          order. Scanning inside the app needs https, which this server is not using.
        </div>
      )}

      {result.kind === 'busy' ? <p className="muted">Looking…</p> : null}

      {result.kind === 'error' ? (
        <div className="banner banner-warn" style={{ marginTop: 12 }}>
          {result.message}
        </div>
      ) : null}

      {result.kind === 'explain' ? (
        <div className="banner banner-info" style={{ marginTop: 12 }}>
          <strong>{result.outcome.title}</strong>
          <div className="small" style={{ marginTop: 4 }}>
            {result.outcome.note}
          </div>
        </div>
      ) : null}

      {/* Two orders can share a five-character code about once in 6,800 evenings. Picking one
          at random is exactly the "it found the wrong Anna" failure this feature exists to
          prevent, so both are offered by name. */}
      {result.kind === 'choose' ? (
        <>
          <div className="small muted" style={{ marginTop: 12 }}>
            More than one order matches. Which one?
          </div>
          <div className="olist" style={{ marginTop: 8 }}>
            {result.orders.map((o) => (
              <button key={o.id} type="button" className="orow" onClick={() => act(o)}>
                <PizzaEmoji emoji={o.pizzaTypeEmoji} />
                <span className="orow-no">#{o.id}</span>
                <div className="orow-main">
                  <div className="orow-name">{o.customerName}</div>
                  <div className="orow-sub">{whereIs(o, serverNow())}</div>
                </div>
                <StatusChip order={o} />
              </button>
            ))}
          </div>
        </>
      ) : null}
    </Modal>
  );
}
