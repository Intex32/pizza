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
      {/* Order here is deliberate and drives the responsive layout in kiosk.css:
          home and Find stay reachable at every width, the counts drop onto their own
          full-width row on a phone, and Menu/Admin/Log out fold into one button below
          900px. Nothing is ever parked off the right edge where it cannot be seen. */}
      <div className="crew-bar">
        <Link to="/crew" className="btn btn-sm" title="All screens">
          🍕
        </Link>
        <button
          type="button"
          className="btn btn-sm"
          title="Find an order by QR or pickup code"
          onClick={() => setFinding(true)}
        >
          🔎 Find
        </button>
        <CountsStrip />
        <span className="spacer" />
        {/* Wide screens show these three inline; below 900px CSS hides them and reveals
            the overflow button instead. Both are always rendered, so there is no width
            listener to get out of step with the media query. */}
        <Link to="/crew/menu" className="btn btn-sm btn-ghost bar-wide">
          Menu
        </Link>
        <Link to="/crew/admin" className="btn btn-sm btn-ghost bar-wide">
          Admin
        </Link>
        <button
          type="button"
          className="btn btn-sm btn-ghost bar-wide"
          onClick={() => void logout()}
        >
          Log out
        </button>
        <BarOverflow onLogout={logout} />
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

/**
 * Menu, Admin and Log out behind one button.
 *
 * They are the three things nobody touches mid-service, so on a narrow screen they are the
 * right things to cost an extra tap - rather than being pushed off the edge of a bar that
 * scrolls sideways with no visible scrollbar, which is where they used to end up.
 */
function BarOverflow({ onLogout }: { onLogout: () => void }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="bar-more">
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More screens"
        onClick={() => setOpen((v) => !v)}
      >
        ⋯
      </button>
      {open ? (
        <>
          {/* A full-screen catcher rather than a document listener: it closes on the first
              tap anywhere, including on the bar itself, with no teardown to forget. */}
          <div className="bar-more-backdrop" onClick={() => setOpen(false)} />
          <div className="bar-menu" role="menu">
            <Link role="menuitem" to="/crew/menu" onClick={() => setOpen(false)}>
              Menu
            </Link>
            <Link role="menuitem" to="/crew/admin" onClick={() => setOpen(false)}>
              Admin
            </Link>
            <button
              role="menuitem"
              type="button"
              onClick={() => {
                setOpen(false);
                void onLogout();
              }}
            >
              Log out
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
