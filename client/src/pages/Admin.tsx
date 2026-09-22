import { useEffect, useMemo, useRef, useState } from 'react';
import { crewApi } from '../api.ts';
import { useLive } from '../live.tsx';
import { Modal, PaymentChip } from '../components.tsx';
import { whenLabel } from './Ordered.tsx';
import { STATUS_LABEL, STATUS_ORDER } from '../../../shared/status.ts';
import type { Status } from '../../../shared/status.ts';
import type { ImportSummary } from '../../../shared/types.ts';
import { countByPayment, countByType, rollUpIngredients } from '../../../shared/menu.ts';
import { PAYMENT_EMOJI, PAYMENT_LABEL, PAYMENT_METHODS } from '../../../shared/payment.ts';
import type { Order } from '../../../shared/types.ts';

type Filter = 'all' | 'active' | 'cancelled' | Status;

export default function Admin() {
  const { orders, state, run, pushToast } = useLive();
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<Order | null>(null);
  const [purging, setPurging] = useState(false);
  const [backups, setBackups] = useState<{ name: string; size: number; mtime: number }[] | null>(null);

  const liveOrders = useMemo(() => orders.filter((o) => o.cancelledAt === null), [orders]);
  const cancelled = useMemo(() => orders.filter((o) => o.cancelledAt !== null), [orders]);

  const typeCounts = useMemo(() => countByType(liveOrders), [liveOrders]);
  const rollup = useMemo(
    () => rollUpIngredients(liveOrders, state?.pizzaTypes ?? []),
    [liveOrders, state],
  );
  const unpaid = useMemo(() => liveOrders.filter((o) => o.paidAt === null), [liveOrders]);
  const payments = useMemo(() => countByPayment(liveOrders), [liveOrders]);
  const maxTypeCount = typeCounts[0]?.count ?? 1;
  const maxIngredient = rollup.ingredients[0]?.count ?? 1;

  const shown = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    let list = orders;
    if (filter === 'active') list = liveOrders;
    else if (filter === 'cancelled') list = cancelled;
    else if (filter !== 'all') list = liveOrders.filter((o) => o.status === filter);
    if (q) {
      list = list.filter(
        (o) =>
          o.customerName.toLocaleLowerCase().includes(q) ||
          o.pizzaTypeName.toLocaleLowerCase().includes(q) ||
          String(o.id) === q.replace('#', ''),
      );
    }
    return [...list].sort((a, b) => b.id - a.id);
  }, [orders, liveOrders, cancelled, filter, query]);

  const loadBackups = async () => {
    try {
      setBackups((await crewApi.backups()).files);
    } catch {
      pushToast('Could not list backups', 'warn');
    }
  };

  return (
    <div className="maxw">
      {/* --- Shopping -------------------------------------------------------------- */}
      <div className="section">
        <h2>
          Pizzas ordered <span className="muted small">— {liveOrders.length} live orders</span>
        </h2>
        {typeCounts.length === 0 ? (
          <p className="muted">No orders yet.</p>
        ) : (
          <div className="bars">
            {typeCounts.map((t) => (
              <div className="bar" key={t.name}>
                <span className="bar-name" title={t.name}>
                  <span aria-hidden="true">{t.emoji} </span>
                  {t.name}
                </span>
                <span className="bar-track">
                  <span
                    className="bar-fill"
                    style={{ width: `${Math.round((t.count / maxTypeCount) * 100)}%` }}
                  />
                </span>
                <span className="bar-n">{t.count}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="section">
        <h2>
          Shopping list <span className="muted small">— counts pizzas, not grams</span>
        </h2>
        {rollup.ingredients.length === 0 ? (
          <p className="muted">Nothing to buy yet.</p>
        ) : (
          <div className="bars">
            {rollup.ingredients.map((ing) => (
              <div className="bar" key={ing.name}>
                <span className="bar-name" title={ing.name}>
                  {ing.name}
                </span>
                <span className="bar-track">
                  <span
                    className="bar-fill"
                    style={{ width: `${Math.round((ing.count / maxIngredient) * 100)}%` }}
                  />
                </span>
                <span className="bar-n">{ing.count}</span>
              </div>
            ))}
          </div>
        )}
        {rollup.orphanOrders > 0 ? (
          <div className="hint">
            {rollup.orphanOrders} order(s) use a pizza that is no longer on the menu, so their
            ingredients are not counted here.
          </div>
        ) : null}
      </div>

      {/* --- Event switches -------------------------------------------------------- */}
      <div className="section">
        <h2>Tonight</h2>
        <div className="card">
          <div className="row-between wrap" style={{ gap: 10 }}>
            <div>
              <strong>{state?.settings.ordersOpen ? 'Orders are open' : 'Orders are closed'}</strong>
              <div className="small muted">
                {state?.settings.ordersOpen
                  ? 'Guests can pre-order from their phones.'
                  : 'The customer page will not accept new orders. Walk-ins still work.'}
              </div>
            </div>
            <button
              type="button"
              className={`btn${state?.settings.ordersOpen ? ' btn-danger' : ' btn-ok'}`}
              onClick={() =>
                void run(() => crewApi.settings({ ordersOpen: !state?.settings.ordersOpen }))
              }
            >
              {state?.settings.ordersOpen ? 'Close orders' : 'Open orders'}
            </button>
          </div>
          <PaymentLinksCard />

          <ConfigIoCard />

          <div className="row-between wrap" style={{ gap: 10, marginTop: 14 }}>
            <div>
              <strong>{unpaid.length} not yet through the counter</strong>
              <div className="small muted">Still waiting to pay.</div>
            </div>
            <button type="button" className="btn btn-sm" onClick={() => setFilter('ORDERED')}>
              Show them
            </button>
          </div>
        </div>
      </div>

      {/* --- How it was paid for ------------------------------------------------- */}
      <div className="section">
        <h2>
          How they paid <span className="muted small">— recorded at the counter</span>
        </h2>
        <div className="card">
          <div className="pay-summary">
            {PAYMENT_METHODS.map((m) => (
              <div key={m} className={`pay-stat pay-stat-${m}`}>
                <span className="pay-stat-emoji" aria-hidden="true">
                  {PAYMENT_EMOJI[m]}
                </span>
                <span className="pay-stat-n">{payments[m]}</span>
                <span className="pay-stat-label">{PAYMENT_LABEL[m]}</span>
              </div>
            ))}
            <div className="pay-stat pay-stat-unpaid">
              <span className="pay-stat-emoji" aria-hidden="true">
                ⏳
              </span>
              <span className="pay-stat-n">{payments.unpaid}</span>
              <span className="pay-stat-label">Not paid yet</span>
            </div>
          </div>
          <div className="hint">
            “Free” is counted on its own, so a comped crew pizza never looks like one the
            counter forgot to record.
          </div>
        </div>
      </div>

      {/* --- Orders table ---------------------------------------------------------- */}
      <div className="section">
        <h2>
          All orders <span className="muted small">— {orders.length} total</span>
        </h2>

        <div className="row wrap" style={{ gap: 8, marginBottom: 10 }}>
          <input
            className="input"
            style={{ flex: 1, minWidth: 200 }}
            placeholder="Search name, pizza, #id…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            className="select"
            style={{ width: 'auto' }}
            value={filter}
            onChange={(e) => setFilter(e.target.value as Filter)}
          >
            <option value="all">All ({orders.length})</option>
            <option value="active">Active ({liveOrders.length})</option>
            {STATUS_ORDER.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]} ({liveOrders.filter((o) => o.status === s).length})
              </option>
            ))}
            <option value="cancelled">Cancelled ({cancelled.length})</option>
          </select>
        </div>

        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>#</th>
                <th>Name</th>
                <th>Pizza</th>
                <th>Status</th>
                <th>Paid</th>
                <th>How</th>
                <th>Ordered</th>
                <th className="wrap-cell">Note / reason</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((o) => (
                <tr key={o.id} style={{ opacity: o.cancelledAt !== null ? 0.6 : 1 }}>
                  <td>{o.id}</td>
                  <td>{o.customerName}</td>
                  <td>
                    <span aria-hidden="true">{o.pizzaTypeEmoji} </span>
                    {o.pizzaTypeName}
                  </td>
                  <td>
                    {o.cancelledAt !== null ? (
                      <span style={{ color: 'var(--danger)' }}>Cancelled</span>
                    ) : (
                      STATUS_LABEL[o.status]
                    )}
                  </td>
                  <td>{o.paidAt !== null ? '✓' : '—'}</td>
                  <td>
                    <PaymentChip method={o.paymentMethod} />
                  </td>
                  <td>{whenLabel(o.createdAt)}</td>
                  <td className="wrap-cell">
                    {o.cancelledAt !== null ? (
                      <em className="muted">{o.cancelReason}</em>
                    ) : (
                      o.note
                    )}
                  </td>
                  <td>
                    <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                      {o.cancelledAt !== null ? (
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => void run(() => crewApi.uncancel(o.id))}
                        >
                          Uncancel
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={() => void run(() => crewApi.cancel(o.id, 'cancelled by crew'))}
                        >
                          Cancel
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        style={{ color: 'var(--danger)' }}
                        onClick={() => setConfirmDelete(o)}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {shown.length === 0 ? (
                <tr>
                  <td colSpan={9} className="muted" style={{ padding: 20 }}>
                    Nothing matches.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      {/* --- Danger zone ------------------------------------------------------------ */}
      <div className="section">
        <h2>After the night</h2>
        <div className="card">
          <div className="row wrap" style={{ gap: 10 }}>
            <button
              type="button"
              className="btn"
              onClick={() =>
                void run(async () => {
                  const r = await crewApi.backup();
                  pushToast(`Backed up to ${r.file}`);
                  await loadBackups();
                  return r;
                })
              }
            >
              Back up now
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => void loadBackups()}>
              {backups === null ? 'Show backups' : 'Refresh backups'}
            </button>
            <span className="spacer" />
            <button type="button" className="btn btn-danger" onClick={() => setPurging(true)}>
              Delete ALL orders
            </button>
          </div>

          {backups !== null ? (
            <div style={{ marginTop: 12 }}>
              {backups.length === 0 ? (
                <p className="muted small">No backups yet.</p>
              ) : (
                <ul className="small" style={{ paddingLeft: 18, margin: 0 }}>
                  {backups.map((b) => (
                    <li key={b.name} style={{ marginBottom: 4 }}>
                      <a className="link" href={`/api/crew/admin/backups/${encodeURIComponent(b.name)}`}>
                        {b.name}
                      </a>{' '}
                      <span className="muted">({Math.round(b.size / 1024)} KB)</span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="hint">
                Download one onto this device — a backup that only lives on the server is not a
                backup.
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {confirmDelete ? (
        <Modal
          title="Delete this order?"
          onClose={() => setConfirmDelete(null)}
          actions={
            <>
              <button type="button" className="btn" onClick={() => setConfirmDelete(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => {
                  const target = confirmDelete;
                  setConfirmDelete(null);
                  void run(() => crewApi.deleteOrder(target.id));
                }}
              >
                Delete permanently
              </button>
            </>
          }
        >
          <p>
            Really delete <strong>{confirmDelete.customerName}</strong>’s{' '}
            {confirmDelete.pizzaTypeName} (#{confirmDelete.id})?
          </p>
          <p className="small muted">
            If you only want it off the crew screens, cancel it instead — that is reversible.
            Deleted rows are written to data/deleted-orders.log before they go.
          </p>
        </Modal>
      ) : null}

      {purging ? <PurgeModal count={orders.length} onClose={() => setPurging(false)} /> : null}
    </div>
  );
}

function PurgeModal({ count, onClose }: { count: number; onClose: () => void }) {
  const { run, pushToast } = useLive();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <Modal
      title="Delete every order"
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={typed !== 'DELETE' || busy}
            onClick={() => {
              setBusy(true);
              void run(async () => {
                const r = await crewApi.purge();
                pushToast(`Deleted ${r.deleted} orders. Backup: ${r.backupFile}`);
                return r;
              }).then(() => {
                setBusy(false);
                onClose();
              });
            }}
          >
            {busy ? 'Deleting…' : 'Delete all'}
          </button>
        </>
      }
    >
      <p>
        This permanently deletes <strong>all {count} orders</strong>, and the next order will be
        #1 again. Pizza types and oven layers are kept.
      </p>
      <p className="small muted">
        A full backup is written first, and every deleted row is appended to
        data/deleted-orders.log.
      </p>
      <label className="field" htmlFor="confirm">
        Type DELETE to confirm
      </label>
      <input
        id="confirm"
        className="input"
        autoFocus
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
      />
    </Modal>
  );
}

/**
 * Where online payments go. Both optional - an empty field means that method is simply not
 * offered, and the button for it never appears on a guest's page.
 *
 * Kept as a draft in local state rather than saving on every keystroke: these are pasted in,
 * and a half-typed URL written straight through would be shown to a guest mid-paste.
 */
function PaymentLinksCard() {
  const { state, run } = useLive();
  const saved = state?.settings;
  const [paypal, setPaypal] = useState('');
  const [wero, setWero] = useState('');
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);

  // Adopt what the server has, until the crew member starts editing - after which their
  // typing must not be overwritten by the one-second poll landing underneath them.
  useEffect(() => {
    if (touched || !saved) return;
    setPaypal(saved.paypalLink);
    setWero(saved.weroLink);
  }, [saved, touched]);

  const dirty = Boolean(saved) && (paypal !== saved?.paypalLink || wero !== saved?.weroLink);

  const save = async () => {
    setBusy(true);
    const ok = await run(() =>
      crewApi.settings({ paypalLink: paypal.trim(), weroLink: wero.trim() }),
    );
    setBusy(false);
    if (ok) setTouched(false);
  };

  return (
    <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
      <strong>Online payment links</strong>
      <div className="small muted">
        Shown to a guest only after a crew member taps <strong>PayPal</strong> at the counter.
        Leave a field empty to not offer it.
      </div>

      <label className="field" htmlFor="paypal-link" style={{ marginTop: 10 }}>
        PayPal link
      </label>
      <input
        id="paypal-link"
        className="input"
        type="url"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        placeholder="https://paypal.me/yourname"
        value={paypal}
        onChange={(e) => {
          setTouched(true);
          setPaypal(e.target.value);
        }}
      />

      <label className="field" htmlFor="wero-link" style={{ marginTop: 10 }}>
        Wero link
      </label>
      <input
        id="wero-link"
        className="input"
        type="url"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        placeholder="https://wero-wallet.eu/..."
        value={wero}
        onChange={(e) => {
          setTouched(true);
          setWero(e.target.value);
        }}
      />

      <div className="row" style={{ gap: 8, marginTop: 10 }}>
        <button type="button" className="btn btn-ok" disabled={!dirty || busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save links'}
        </button>
        {dirty ? (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy}
            onClick={() => {
              setTouched(false);
              setPaypal(saved?.paypalLink ?? '');
              setWero(saved?.weroLink ?? '');
            }}
          >
            Discard
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Carrying the SETUP between databases: the menu, the oven decks, the payment links.
 *
 * The reason this exists is in server/configIo.ts - the documented way through a schema
 * change is to delete the database, and a menu somebody spent an hour typing in should not
 * die with it. It is also how the test Pi and the real one end up agreeing.
 */
function ConfigIoCard() {
  const { refresh, pushToast } = useLive();
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);

  const doExport = async () => {
    setBusy(true);
    setError('');
    try {
      const config = await crewApi.exportConfig();
      // A Blob rather than a data: URL - a menu with long ingredient lists can outgrow what
      // some browsers accept in a URL, and it fails by silently downloading nothing.
      const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `pizza-night-config-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      // Revoked on the next turn of the loop: revoking immediately races the download in
      // Safari and produces an empty file.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not build the export.');
    } finally {
      setBusy(false);
    }
  };

  const doImport = async (file: File) => {
    setBusy(true);
    setError('');
    setSummary(null);
    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error('That file is not valid JSON.');
      }
      const res = await crewApi.importConfig(parsed);
      setSummary(res.summary);
      await refresh();
      pushToast('Config imported');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not import that file.');
    } finally {
      setBusy(false);
      // Cleared so choosing the SAME file again still fires a change event.
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
      <strong>Menu &amp; settings file</strong>
      <div className="small muted">
        The menu, the oven decks and the payment links as one file. No orders, no password.
        Handy before wiping the database, or to copy a setup onto another Pi.
      </div>

      <div className="oactions" style={{ marginTop: 10 }}>
        <button type="button" className="btn" disabled={busy} onClick={() => void doExport()}>
          ⬇ Export
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          ⬆ Import…
        </button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void doImport(file);
        }}
      />

      <div className="hint">
        Importing only adds and updates — it never deletes a pizza type or a deck, so it is
        safe to run mid-evening.
      </div>

      {error ? (
        <div className="banner banner-warn" style={{ marginTop: 10 }}>
          {error}
        </div>
      ) : null}

      {summary ? (
        <div className="banner banner-info" style={{ marginTop: 10 }}>
          <strong>Imported.</strong>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            <li>
              Menu: {summary.pizzaTypes.added} added, {summary.pizzaTypes.updated} updated
            </li>
            <li>
              Decks: {summary.ovenLayers.added} added, {summary.ovenLayers.updated} updated
            </li>
            <li>
              {summary.settingsChanged.length > 0
                ? `Changed: ${summary.settingsChanged.join(', ')}`
                : 'Payment links unchanged'}
            </li>
          </ul>
          {summary.keptNotInFile.pizzaTypes.length > 0 ? (
            <div className="small" style={{ marginTop: 6 }}>
              Kept, not in the file: {summary.keptNotInFile.pizzaTypes.join(', ')}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
