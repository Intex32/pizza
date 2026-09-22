import { useEffect, useState } from 'react';
import { Link, Navigate, Outlet, useLocation, useNavigate } from 'react-router';
import { publicApi } from '../api.ts';
import { LiveProvider } from '../live.tsx';
import { ConnectionBar, CountsStrip, OfflineBanner, Toasts } from '../components.tsx';
import { FindOrderModal } from './FindOrder.tsx';

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
    // A scan can send a Ready tablet to /crew/oven for a few seconds, and remembering that
    // would re-home the station permanently - it would reboot into the oven forever.
    //
    // Decided ONCE per pathname, reading the query directly rather than depending on
    // location.search. That is load-bearing: the highlight REMOVES ?focus= from the URL after
    // twelve seconds, so an effect watching the query would re-run at that moment, see a
    // clean URL, and record the screen after all. Measured: it did exactly that.
    const arrivedViaScan = new URLSearchParams(window.location.search).has('focus');
    if (location.pathname !== '/crew' && location.pathname in TITLES && !arrivedViaScan) {
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
  const isOven = location.pathname === '/crew/oven';
  const [finding, setFinding] = useState(false);

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
        {/* Second in the bar on purpose. .crew-bar is overflow-x: auto with a hidden
            scrollbar, so on a 375px phone anything past the right edge is effectively
            invisible - which is already true of Menu, Admin and Log out. This has to stay
            reachable at scroll origin, because phones are exactly what it is built for. */}
        <button
          type="button"
          className="btn btn-sm"
          style={{ flex: 'none' }}
          title="Find an order by QR or pickup code"
          onClick={() => setFinding(true)}
        >
          🔎 Find
        </button>
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

      {finding ? <FindOrderModal onClose={() => setFinding(false)} /> : null}
    </div>
  );
}
