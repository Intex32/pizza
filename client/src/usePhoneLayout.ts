import { useEffect, useState } from 'react';

/** Matches the phone breakpoint the crew CSS already uses. Keep the two in step. */
const PHONE = '(max-width: 760px)';

/**
 * True on a phone-sized screen.
 *
 * Used to turn drag-and-drop off on the oven screen. Dragging needs `touch-action: none` on
 * the card so the browser hands every gesture to the page - which also means a finger that
 * lands on a card can never scroll, and on a phone the board is almost entirely cards. The
 * explicit move button does the same job with none of that, so the drag is the part that
 * gives way.
 *
 * A media query rather than a touch-capability test on purpose: a kitchen tablet is a touch
 * device too, and dragging a pizza between decks is exactly what it is good at.
 */
export function usePhoneLayout(): boolean {
  const [phone, setPhone] = useState(() => window.matchMedia(PHONE).matches);

  useEffect(() => {
    const mq = window.matchMedia(PHONE);
    const onChange = (e: MediaQueryListEvent) => setPhone(e.matches);
    mq.addEventListener('change', onChange);
    // Re-read on mount: a rotation between render and effect would otherwise stick.
    setPhone(mq.matches);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return phone;
}
