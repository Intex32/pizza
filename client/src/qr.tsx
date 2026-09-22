import { useMemo } from 'react';
import { QR_MARGIN, qrModules } from './qrMatrix.ts';

export { QR_MARGIN, qrModules } from './qrMatrix.ts';

export function QrCode({ value, size = 264 }: { value: string; size?: number }) {
  const { d, span } = useMemo(() => {
    const { dark, count } = qrModules(value);
    // ONE path, not ~1000 <rect> elements. OrderDetail re-renders on every poll tick, and a
    // matrix of React elements is real reconciliation work on a cheap phone.
    let path = '';
    for (let r = 0; r < count; r += 1) {
      for (let c = 0; c < count; c += 1) {
        if (dark[r][c]) path += `M${c + QR_MARGIN} ${r + QR_MARGIN}h1v1h-1z`;
      }
    }
    return { d: path, span: count + QR_MARGIN * 2 };
  }, [value]);

  return (
    <svg
      viewBox={`0 0 ${span} ${span}`}
      width={size}
      height={size}
      /* Without this the antialiased hairlines between adjacent modules are what make a
         scaled SVG QR scan unreliably. */
      shapeRendering="crispEdges"
      /* The pickup code printed underneath is the accessible equivalent; a screen reader has
         no use for a module matrix. */
      aria-hidden="true"
      focusable="false"
    >
      {/* Hard #fff/#000 in BOTH themes. currentColor would invert the code at night, and an
          inverted QR is a coin flip on iOS. */}
      <rect width={span} height={span} fill="#ffffff" />
      <path d={d} fill="#000000" />
    </svg>
  );
}
