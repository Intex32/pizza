import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { ApiError, publicApi } from '../api.ts';
import { unlockAudio } from '../alarm.ts';

/**
 * Where ?next= is allowed to send someone after logging in.
 *
 * Widened to cover /t/<token>, so a crew member who scanned a ticket before logging in lands
 * back on that ticket rather than on a generic screen. Tightened at the same time: the old
 * `next.startsWith('/crew')` also accepted '/crewevil', and an open redirect is an open
 * redirect even on a kitchen LAN. The token shape is base64url, 22 chars for 16 bytes.
 */
const SAFE_NEXT = /^\/crew(\/|$)|^\/t\/[A-Za-z0-9_-]{1,64}$/;

export default function CrewLogin() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get('next') ?? '/crew';
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !password) return;

    // Tablets only allow audio that a real user gesture started, so the oven alarm is
    // unlocked HERE, synchronously inside the submit gesture. Doing it later never works.
    unlockAudio();

    setBusy(true);
    setError('');
    try {
      await publicApi.login(password);
      navigate(SAFE_NEXT.test(next) ? next : '/crew', { replace: true });
    } catch (err) {
      setBusy(false);
      setPassword('');
      setError(err instanceof ApiError ? err.message : 'Could not reach the server.');
    }
  };

  return (
    <div className="kiosk" style={{ display: 'flex', alignItems: 'center', minHeight: '100dvh' }}>
      <div className="page" style={{ width: '100%' }}>
        <div className="brand">
          <span className="brand-mark">🍕</span>
          <span>
            <span className="brand-name" style={{ display: 'block' }}>
              Crew
            </span>
            <span className="brand-sub">Pizza Night</span>
          </span>
        </div>

        <form className="card stack" onSubmit={submit}>
          <div>
            <label className="field" htmlFor="pw">
              Crew password
            </label>
            <input
              id="pw"
              className="input"
              type="password"
              autoFocus
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {error ? <div className="banner banner-error">{error}</div> : null}
          <button type="submit" className="btn btn-primary btn-lg" disabled={busy || !password}>
            {busy ? 'Checking…' : 'Log in'}
          </button>
          <div className="hint">
            This tablet stays logged in. Logging in also switches on the oven alarm sound for
            this device.
          </div>
        </form>
      </div>
    </div>
  );
}
