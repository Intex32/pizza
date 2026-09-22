import { useState } from 'react';
import { useNavigate } from 'react-router';
import { ApiError, crewApi, serverNow } from '../api.ts';
import { Modal, StatusChip } from '../components.tsx';
import { useLive } from '../live.tsx';
import { scanOutcome, whereIs } from '../scan.ts';
import type { ScanOutcome } from '../scan.ts';
import { PICKUP_CODE_LENGTH, normalizePickupCode } from '../../../shared/pickupCode.ts';
import type { Order } from '../../../shared/types.ts';

/**
 * getUserMedia does not exist outside a secure context, and this server is plain HTTP on a
 * LAN by design - so an in-page camera scanner is a button that can never work here. Rather
 * than ship a disabled control that invites repeated tapping and reads like a bug, the modal
 * says why and points at the thing that does work.
 *
 * If this ever runs over HTTPS, an in-page scanner would go behind this flag.
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

  const lookUp = async (raw: string) => {
    const clean = normalizePickupCode(raw);
    if (clean.length !== PICKUP_CODE_LENGTH) return;
    setResult({ kind: 'busy' });
    try {
      // NOT live.run(): that refreshes the whole snapshot on success and throws the response
      // away, and the response is the only thing wanted here. This is a read.
      const res = await crewApi.resolve({ code: clean });
      act(res.order);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'ambiguous_code') {
        const orders = (e.details as { orders?: Order[] } | undefined)?.orders ?? [];
        setResult({ kind: 'choose', orders });
        return;
      }
      // Kept inside the modal rather than fired as a toast the modal would cover.
      // A 401 needs nothing here: LiveProvider's poll redirects to the login within a second.
      setResult({
        kind: 'error',
        message: e instanceof ApiError ? e.message : 'Could not reach the kitchen.',
      });
    }
  };

  const onChange = (raw: string) => {
    const clean = normalizePickupCode(raw).slice(0, PICKUP_CODE_LENGTH);
    setCode(clean);
    if (result.kind !== 'idle') setResult({ kind: 'idle' });
    // Fire on the last character: at a counter, a separate "search" button is one tap nobody
    // should have to find.
    if (clean.length === PICKUP_CODE_LENGTH) void lookUp(clean);
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
      <label className="field" htmlFor="pickup">
        Pickup code
      </label>
      <input
        id="pickup"
        className="input search"
        autoFocus
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        maxLength={PICKUP_CODE_LENGTH}
        placeholder="K7M2Q"
        value={code}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void lookUp(code);
        }}
        style={{ letterSpacing: '0.25em', fontFamily: 'ui-monospace, Menlo, Consolas, monospace' }}
      />

      <div className="hint">
        {IN_PAGE_SCAN_POSSIBLE
          ? 'Or scan the ticket QR.'
          : "Or point your phone's own camera app at the customer's QR — it opens straight to " +
            'the order. In-page scanning needs HTTPS, which this kitchen server does not use.'}
      </div>

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
                <span className="orow-emoji" aria-hidden="true">
                  {o.pizzaTypeEmoji}
                </span>
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
