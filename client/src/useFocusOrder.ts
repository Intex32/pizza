import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router';

/** How long a scan highlight survives. Long enough to walk back to the board, short enough
 *  that a tablet left alone is not still outlining a pizza an hour later. */
const FOCUS_MS = 12_000;

/**
 * Reads ?focus=<id>.
 *
 * A URL param rather than context state on purpose: it survives the navigate() with no
 * plumbing, it survives a reload (which is the wall-tablet story this app already cares
 * about), and it is inspectable when something goes wrong during service.
 */
export function useFocusParam(): number | null {
  const [params] = useSearchParams();
  const raw = params.get('focus');
  return raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
}

/**
 * The same read, plus the self-clear. Call this ONCE per screen: calling it from every card
 * would queue one redundant replace-navigation per card on screen.
 */
export function useFocusedOrderId(): number | null {
  const [, setParams] = useSearchParams();
  const id = useFocusParam();

  useEffect(() => {
    if (id === null) return;
    const t = setTimeout(() => {
      // replace, so Back does not walk into a stale highlight.
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete('focus');
          return next;
        },
        { replace: true },
      );
    }, FOCUS_MS);
    return () => clearTimeout(t);
  }, [id, setParams]);

  return id;
}

/**
 * Attach the returned ref to a card's root. Every board gets the same treatment this way,
 * so a scanned pizza looks identical wherever it turns up.
 */
export function useFocusCard<T extends HTMLElement>(id: number, focusedId: number | null) {
  const ref = useRef<T | null>(null);
  const focused = focusedId === id;

  useEffect(() => {
    if (!focused || !ref.current) return;
    // Instant, not smooth: they are already looking at the screen, and a 400ms glide just
    // delays the answer.
    ref.current.scrollIntoView({ block: 'center' });
  }, [focused]);

  return { ref, focused };
}
