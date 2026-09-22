import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ApiError, crewApi, publicApi, serverNow } from '../api.ts';
import { scanOutcome } from '../scan.ts';
import type { ScanOutcome } from '../scan.ts';
import OrderDetail from './OrderDetail.tsx';
import { Brand } from './NewOrder.tsx';

/** Only the non-navigating half is ever held in state; the 'go' half navigates immediately. */
type Explained = Extract<ScanOutcome, { kind: 'explain' }>;

/**
 * Where a scanned QR lands.
 *
 * The camera problem this app cannot solve is that getUserMedia does not exist outside a
 * secure context, and this server is plain HTTP on a LAN by design. So the scanning is done
 * by the PHONE'S OWN CAMERA APP, which needs no permission from us and no HTTPS - it simply
 * opens this URL. All this route has to do is work out who is holding the phone.
 *
 * A client route rather than a server redirect, because the interesting case cannot be
 * expressed as a 302: a crew member who is not logged in IN THIS BROWSER has to be told that,
 * and offered the fix. A redirect could only dump them on the customer page with no hint.
 */
export default function ScanLanding() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const [who, setWho] = useState<'checking' | 'crew' | 'guest'>('checking');
  const [outcome, setOutcome] = useState<Explained | null>(null);
  const [failed, setFailed] = useState('');

  useEffect(() => {
    let cancelled = false;

    publicApi
      .session()
      .then(async (r) => {
        if (cancelled) return;
        if (!r.authenticated) {
          setWho('guest');
          return;
        }
        setWho('crew');
        try {
          const res = await crewApi.resolve({ token });
          if (cancelled) return;
          const next = scanOutcome(res.order, serverNow());
          if (next.kind === 'go') navigate(next.to, { replace: true });
          else setOutcome(next);
        } catch (e) {
          if (cancelled) return;
          setFailed(
            e instanceof ApiError ? e.message : 'Could not reach the kitchen. Check the Wi-Fi.',
          );
        }
      })
      // session() never 401s, so a rejection here means the network, not the answer.
      .catch(() => !cancelled && setWho('guest'));

    return () => {
      cancelled = true;
    };
  }, [token, navigate]);

  if (who === 'checking') {
    return (
      <div className="page">
        <Brand />
        <p className="muted">Looking up that ticket…</p>
      </div>
    );
  }

  // Crew, but the order is somewhere no board shows it - cancelled or already collected.
  // Rendered as a full page rather than a toast because this route is outside LiveProvider,
  // and because "we already gave this person their pizza" deserves more than a 10s strip.
  if (who === 'crew' && (outcome || failed)) {
    return (
      <div className="page">
        <Brand />
        <div className="card" style={{ marginTop: 8 }}>
          <h2 style={{ marginTop: 0 }}>{failed ? 'No match' : outcome?.title}</h2>
          <p className="muted" style={{ marginBottom: 0 }}>
            {failed || outcome?.note}
          </p>
        </div>
        <div className="row" style={{ gap: 8, marginTop: 14 }}>
          <Link className="btn btn-primary" to="/crew">
            Crew screens
          </Link>
          <Link className="btn btn-ghost" to="/crew/admin">
            Admin
          </Link>
        </div>
      </div>
    );
  }

  // Not logged in here. Show the customer their own order exactly as always, and give a crew
  // member the one-time fix rather than a dead end.
  //
  // This is the DEFAULT for a crew phone, not an edge case: the camera app opens links in the
  // system browser, which has probably never visited the crew UI. The session cookie lasts a
  // year, so this happens once per phone and then never again.
  return (
    <>
      <OrderDetail />
      <div className="page" style={{ paddingTop: 0 }}>
        <div className="card muted">
          <div className="small" style={{ fontWeight: 650, marginBottom: 4 }}>
            Crew?
          </div>
          <div className="hint" style={{ marginTop: 0 }}>
            Your camera opened this in whichever browser the phone uses by default, and you are
            logged in somewhere else. Log in once here and every scan after this jumps straight
            to the order.
          </div>
          <Link
            className="btn btn-block"
            style={{ marginTop: 10 }}
            to={`/crew/login?next=${encodeURIComponent(`/t/${token}`)}`}
          >
            Log in as crew
          </Link>
        </div>
      </div>
    </>
  );
}
