import { useEffect } from 'react';

type WakeLockSentinelLike = { release: () => Promise<void>; addEventListener?: unknown };
type WakeLockLike = { request: (type: 'screen') => Promise<WakeLockSentinelLike> };

/**
 * Keeps a kiosk tablet awake. Feature-detected, and deliberately quiet when unavailable:
 * the Wake Lock API needs a SECURE CONTEXT, so on a plain-http LAN it simply will not
 * engage. Setting the tablet's own screen timeout to Never is the primary measure and the
 * README says so - this is the bonus that works when you do have https or localhost.
 */
export function useWakeLock(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const wakeLock = (navigator as unknown as { wakeLock?: WakeLockLike }).wakeLock;
    if (!wakeLock) return;

    let sentinel: WakeLockSentinelLike | null = null;
    let cancelled = false;

    const acquire = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const next = await wakeLock.request('screen');
        if (cancelled) {
          void next.release();
          return;
        }
        sentinel = next;
      } catch {
        // Denied, or not a secure context. Nothing to do.
      }
    };

    // The lock is dropped whenever the tab is hidden, so it has to be re-acquired on wake.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void acquire();
    };

    void acquire();
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      if (sentinel) void sentinel.release().catch(() => {});
    };
  }, [enabled]);
}
