import { Navigate, Route, Routes } from 'react-router';
import CustomerHome from './pages/CustomerHome.tsx';
import NewOrder from './pages/NewOrder.tsx';
import OrderDetail from './pages/OrderDetail.tsx';
import CrewLogin from './pages/CrewLogin.tsx';
import CrewShell from './pages/CrewShell.tsx';
import ScreenPicker from './pages/ScreenPicker.tsx';
import Ordered from './pages/Ordered.tsx';
import Prep from './pages/Prep.tsx';
import Oven from './pages/Oven.tsx';
import Ready from './pages/Ready.tsx';
import Menu from './pages/Menu.tsx';
import Admin from './pages/Admin.tsx';

export default function App() {
  return (
    <Routes>
      {/* Customer - no login, trust-based. */}
      <Route path="/" element={<CustomerHome />} />
      <Route path="/new" element={<NewOrder />} />
      <Route path="/order/:token" element={<OrderDetail />} />

      {/* Crew - one shared password. The login page sits OUTSIDE the shell so it is not
          guarded by the thing it exists to get you past. */}
      <Route path="/crew/login" element={<CrewLogin />} />
      <Route path="/crew" element={<CrewShell />}>
        <Route index element={<ScreenPicker />} />
        <Route path="orders" element={<Ordered />} />
        <Route path="prep" element={<Prep />} />
        {/* The oven queue lives ON the oven screen now: the person loading the oven is the
            person who needs to see what is waiting. A tablet bookmarked on the old URL
            keeps working rather than 404ing mid-service. */}
        <Route path="queue" element={<Navigate to="/crew/oven" replace />} />
        <Route path="oven" element={<Oven />} />
        <Route path="ready" element={<Ready />} />
        <Route path="menu" element={<Menu />} />
        <Route path="admin" element={<Admin />} />
      </Route>

      <Route
        path="*"
        element={
          <div className="page">
            <div className="empty">
              <span className="empty-emoji">🍕</span>
              <p>Nothing here.</p>
              <a className="btn btn-primary" href="/">
                Go to the order page
              </a>
            </div>
          </div>
        }
      />
    </Routes>
  );
}
