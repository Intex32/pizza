import { useEffect, useState } from 'react';
import { Link, Navigate, Outlet, useLocation, useNavigate } from 'react-router';
import { publicApi } from '../api.ts';
import { LiveProvider } from '../live.tsx';
import { ConnectionBar, CountsStrip, OfflineBanner, Toasts } from '../components.tsx';

const LAST_SCREEN_KEY = 'pizza.lastCrewScreen';

const TITLES: Record<string, string> = {
  '/crew': 'Crew',
  '/crew/orders': 'Ordered',
  '/crew/prep': 'Preparation',
  '/crew/oven': 'Oven',
  '/crew/ready': 'Ready',
  '/crew/menu': 'Menu',
  '/crew/admin': 'Admin',
};

/** The URL is the persistence: a wall tablet parked on /crew/oven survives reload and reboot.
 *  This only remembers which screen to land on when someone opens the bare /crew. */
export function rememberScreen(path: string): void {
  try {
    localStorage.setItem(LAST_SCREEN_KEY, path);
  } catch {
    // no-op
  }
}

export function lastScreen(): string | null {
  try {
    return localStorage.getItem(LAST_SCREEN_KEY);
  } catch {
    return null;
  }
}

export default function CrewShell() {
  const location = useLocation();
  const [auth, setAuth] = useState<'checking' | 'in' | 'out'>('checking');

  useEffect(() => {
    publicApi
      .session()
      .then((r) => setAuth(r.authenticated ? 'in' : 'out'))
      .catch(() => setAuth('out'));
  }, []);

  useEffect(() => {
    if (location.pathname !== '/crew' && location.pathname in TITLES) {
      rememberScreen(location.pathname);
    }
  }, [location.pathname]);

  if (auth === 'checking') {
    return (
      <div className="kiosk" style={{ padding: 24 }}>
        <p className="muted">Checking…</p>
      </div>
    );
  }

  if (auth === 'out') {
    return (
      <Navigate to={`/crew/login?next=${encodeURIComponent(location.pathname)}`} replace />
    );
  }

  return (
    <LiveProvider>
      <ShellFrame />
    </LiveProvider>
  );
}

function ShellFrame() {
  const location = useLocation();
  const navigate = useNavigate();
  const title = TITLES[location.pathname] ?? 'Crew';
  const isOven = location.pathname === '/crew/oven';

  const logout = async () => {
    try {
      await publicApi.logout();
    } catch {
      // Even if the call failed, sending them to the login screen is the honest outcome.
    }
    navigate('/crew/login', { replace: true });
  };

  return (
    <div className="kiosk crew-shell">
      <div className="crew-bar">
        <Link to="/crew" className="btn btn-sm" title="All screens" style={{ flex: 'none' }}>
          🍕
        </Link>
        <span className="screen-title">{title}</span>
        <CountsStrip />
        <span className="spacer" style={{ minWidth: 8 }} />
        <Link to="/crew/menu" className="btn btn-sm btn-ghost" style={{ flex: 'none' }}>
          Menu
        </Link>
        <Link to="/crew/admin" className="btn btn-sm btn-ghost" style={{ flex: 'none' }}>
          Admin
        </Link>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          style={{ flex: 'none' }}
          onClick={() => void logout()}
        >
          Log out
        </button>
        <ConnectionBar />
      </div>

      <OfflineBanner />

      {/* The oven screen owns its own height and must never scroll the page. */}
      <div className={`crew-body${isOven ? ' no-scroll' : ''}`}>
        <Outlet />
      </div>

      <Toasts />
    </div>
  );
}
