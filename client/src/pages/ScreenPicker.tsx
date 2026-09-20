import { useEffect } from 'react';
import { Link, useNavigate } from 'react-router';
import { useLive } from '../live.tsx';
import { countByStatus } from '../components.tsx';
import { lastScreen } from './CrewShell.tsx';

export default function ScreenPicker() {
  const navigate = useNavigate();
  const { orders } = useLive();
  const counts = countByStatus(orders);

  // A dedicated tablet should land back on its own station after a reload, without anyone
  // having to remember which one it was.
  useEffect(() => {
    const last = lastScreen();
    if (last && last !== '/crew') navigate(last, { replace: true });
  }, [navigate]);

  const tiles = [
    { to: '/crew/orders', emoji: '🧾', label: 'Ordered', count: counts.ORDERED, sub: 'take cash, start it' },
    { to: '/crew/prep', emoji: '🧑‍🍳', label: 'Preparation', count: counts.IN_PREPARATION, sub: 'top the pizzas' },
    { to: '/crew/queue', emoji: '⏳', label: 'Waiting for oven', count: counts.WAITING_FOR_OVEN, sub: 'ready to go in' },
    { to: '/crew/oven', emoji: '🔥', label: 'On fire', count: counts.BAKING, sub: 'timers and decks' },
    { to: '/crew/ready', emoji: '✅', label: 'Ready', count: counts.READY, sub: 'hand them over' },
    { to: '/crew/menu', emoji: '📋', label: 'Menu', count: null, sub: 'pizza types' },
    { to: '/crew/admin', emoji: '⚙️', label: 'Admin', count: null, sub: 'orders and shopping' },
  ];

  return (
    <div className="maxw">
      <p className="muted" style={{ marginBottom: 14 }}>
        Pick this tablet’s screen. It will come straight back here after a reload.
      </p>
      <div className="picker">
        {tiles.map((t) => (
          <Link key={t.to} to={t.to}>
            <span className="picker-emoji">{t.emoji}</span>
            <span>{t.label}</span>
            <span className="picker-count">
              {t.count === null ? t.sub : `${t.count} · ${t.sub}`}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
