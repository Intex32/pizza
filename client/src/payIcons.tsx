/**
 * Small marks for the two online payment buttons.
 *
 * These are deliberately OUR OWN simplified badges in each service's colours, not copies of
 * the official logos. Shipping a redrawn trademark in someone else's app is the kind of
 * thing that is fine right up until it is not, and at 22px a clean lettered badge reads
 * faster than a traced logo anyway. If you would rather use the official assets, drop the
 * SVGs in and swap these two components out - nothing else changes.
 *
 * aria-hidden throughout: the button already says "Pay with PayPal" in text, and a screen
 * reader announcing the icon as well would just say it twice.
 */

const BADGE = { rx: 6, width: 22, height: 22 } as const;

export function PayPalMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={BADGE.width}
      height={BADGE.height}
      aria-hidden="true"
      focusable="false"
      className="pay-mark"
    >
      <rect width="24" height="24" rx={BADGE.rx} fill="#003087" />
      {/* Two offset strokes echo the layered "PP" without reproducing it. */}
      <path
        d="M8.2 18.2 10.4 6.2h4.1c2.2 0 3.4 1.1 3.1 3-.3 2.2-2 3.5-4.4 3.5h-1.5l-.8 5.5Z"
        fill="#fff"
        opacity="0.55"
      />
      <path
        d="M6.4 18.2 8.6 6.2h4.1c2.2 0 3.4 1.1 3.1 3-.3 2.2-2 3.5-4.4 3.5H9.9l-.8 5.5Z"
        fill="#fff"
      />
    </svg>
  );
}

export function WeroMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={BADGE.width}
      height={BADGE.height}
      aria-hidden="true"
      focusable="false"
      className="pay-mark"
    >
      <defs>
        <linearGradient id="wero-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#e5007d" />
          <stop offset="100%" stopColor="#7d1fa2" />
        </linearGradient>
      </defs>
      <rect width="24" height="24" rx={BADGE.rx} fill="url(#wero-g)" />
      {/* A plain W: unambiguous at this size, and not a trademark. */}
      <path
        d="M4.8 7.4h2.5l1.6 6.1 1.8-6.1h2.1l1.8 6.1 1.6-6.1h2.5l-2.8 9.5h-2.4l-1.7-5.7-1.7 5.7H7.6Z"
        fill="#fff"
      />
    </svg>
  );
}
