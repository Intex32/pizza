import { useEffect, useState } from 'react';
import { serverNow } from './api.ts';

/**
 * One ticker per screen. Every tick recomputes from the wall clock rather than accumulating,
 * so background-tab throttling costs a stale PIXEL, never a stale NUMBER: when the tab wakes
 * the very next render is already correct.
 */
export function useNow(intervalMs = 500): number {
  const [now, setNow] = useState(() => serverNow());

  useEffect(() => {
    let frame = 0;
    const tick = () => setNow(serverNow());
    const timer = setInterval(tick, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        frame = requestAnimationFrame(tick);
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', tick);
    return () => {
      clearInterval(timer);
      cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', tick);
    };
  }, [intervalMs]);

  return now;
}

export type BakeState = {
  /** Milliseconds left. Negative once the pizza is overdue. */
  remainingMs: number;
  expired: boolean;
  /** Last 30 seconds - amber, "get ready". */
  warning: boolean;
  /** mm:ss, or +mm:ss once overdue. */
  label: string;
  /** How long it has been overdue, in whole seconds. */
  overdueS: number;
  valid: boolean;
};

export function bakeState(
  bakingStartedAt: number | null,
  bakeSeconds: number | null,
  now: number,
): BakeState {
  if (bakingStartedAt === null || bakeSeconds === null || !Number.isFinite(bakeSeconds)) {
    // Renders an amber dash rather than NaN:NaN. Should be unreachable - the row CHECK
    // forbids a BAKING row without both - but a timer that lies is worse than one that says
    // it does not know.
    return { remainingMs: 0, expired: false, warning: false, label: '—', overdueS: 0, valid: false };
  }
  const deadline = bakingStartedAt + bakeSeconds * 1000;
  const remainingMs = deadline - now;
  const expired = remainingMs <= 0;
  return {
    remainingMs,
    expired,
    warning: !expired && remainingMs <= 30_000,
    label: expired ? `+${mmss(-remainingMs)}` : mmss(remainingMs),
    overdueS: expired ? Math.floor(-remainingMs / 1000) : 0,
    valid: true,
  };
}

/** Ceil, so a countdown shows 00:01 for the whole final second rather than flashing 00:00. */
export function mmss(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** "3:40" style elapsed label for the queue and pickup boards. */
export function elapsed(since: number | null, now: number): string {
  if (since === null) return '—';
  return mmss(Math.max(0, now - since));
}
