import path from 'node:path';
import { Router } from 'express';
import { BACKUP_DIR } from '../config.ts';
import { bumpVersion, db, log, tx } from '../db.ts';
import { appendDeletedOrdersSync, listBackups, runBackup } from '../backup.ts';
import { ApiError, asObject, bad, notFound, str } from '../validate.ts';

export const adminRouter: Router = Router();

// =========================================================================================
// THE ONLY TWO PLACES AN ORDER CAN DIE. Nothing else in this codebase issues a DELETE
// against the orders table, and no collection-level DELETE route is registered anywhere -
// so a truncated URL or a stray retry cannot wipe the evening.
// =========================================================================================

/** Deleting one order. Requires an explicit header, so it can never be a stray navigation. */
adminRouter.delete('/orders/:id', (req, res) => {
  if (req.get('x-confirm') !== 'delete-order') {
    throw new ApiError(428, 'confirmation_required', 'Deleting an order needs an explicit confirm.');
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw bad('invalid_id', 'Bad order id.');

  tx(() => {
    const row = db.prepare('SELECT * FROM orders WHERE id = :id').get({ id });
    if (!row) throw notFound('order_not_found', `No order #${id}.`);
    // BEFORE the delete, and outside any swallowing try/catch: a full disk must abort the
    // delete rather than lose the record.
    appendDeletedOrdersSync([row]);
    db.prepare('DELETE FROM orders WHERE id = :id').run({ id });
    log(`DELETE #${id}`);
  });
  bumpVersion();
  res.status(204).end();
});

/**
 * Delete everything, after the night is over.
 *
 * The sequence below is exact, and it is a correctness fix rather than a nicety.
 * node:sqlite is synchronous over one connection, so an open BEGIN IMMEDIATE is global
 * process state: an `await` inside the transaction would let a customer's POST /api/orders
 * commit INSIDE the purge and then be deleted by it - an order destroyed that nobody
 * intended to destroy, and absent from the backup. So the backup is fully awaited first,
 * and `created_at <= cutoff` makes any order placed during the backup survive by
 * construction.
 */
adminRouter.post('/purge', async (req, res) => {
  const body = asObject(req.body);
  const confirm = str(body, 'confirm', { max: 40 });
  if (confirm !== 'DELETE ALL ORDERS') {
    throw bad('confirmation_required', 'Type the confirmation phrase exactly.');
  }

  const cutoff = Date.now();
  const backupFile = await runBackup();

  const deleted = tx(() => {
    const rows = db.prepare('SELECT * FROM orders WHERE created_at <= :cutoff').all({ cutoff });
    appendDeletedOrdersSync(rows);
    const result = db.prepare('DELETE FROM orders WHERE created_at <= :cutoff').run({ cutoff });
    // Restart numbering at #1 for the next event. This is the ONLY moment an order id is
    // ever reused, and it takes a deliberate operator action to reach it.
    db.prepare("DELETE FROM sqlite_sequence WHERE name = 'orders'").run();
    return Number(result.changes);
  });

  bumpVersion();
  log(`PURGE ${deleted} order(s), backup ${backupFile}`);
  res.json({ deleted, backupFile });
});

adminRouter.post('/backup', async (_req, res) => {
  res.json({ file: await runBackup() });
});

adminRouter.get('/backups', (_req, res) => {
  res.json({ files: listBackups() });
});

/** So a backup ends up on the admin tablet, not only on the Pi's SD card next to the db. */
adminRouter.get('/backups/:file', (req, res) => {
  // Validated against the actual directory listing rather than by sanitising the string,
  // which closes path traversal by construction.
  const known = listBackups().find((f) => f.name === req.params.file);
  if (!known) throw notFound('backup_not_found', 'No such backup file.');
  res.download(path.join(BACKUP_DIR, known.name), known.name);
});
