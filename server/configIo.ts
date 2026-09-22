import { allLayers, allPizzaTypes, db, log, readSettings, writeSetting } from './db.ts';
import { bad, clamp } from './validate.ts';
import type { ImportSummary, OvenLayer, PizzaType } from '../shared/types.ts';

/**
 * Taking the evening's SETUP somewhere else: the menu, the oven decks, and where money goes.
 *
 * This exists because the schema has no migration framework by design - the documented way
 * forward across a schema change is "back up, delete the database, re-seed". That is a fine
 * trade for order data, which is worthless the next morning, and a terrible one for a menu
 * somebody spent an hour typing in. So the menu can be carried across independently.
 *
 * What is NOT in here, deliberately:
 *   - Orders. They belong to one evening and are not configuration.
 *   - The crew password. It is not in the database at all, and an export is a file that
 *     gets emailed to people.
 *   - Anything with an id in it. Ids are local to one database; matching is done by NAME,
 *     so an export from the test Pi lands correctly on the real one.
 */

export const CONFIG_FORMAT = 'pizza-night-config';
export const CONFIG_VERSION = 1;

export type ConfigExport = {
  format: typeof CONFIG_FORMAT;
  version: number;
  exportedAt: number;
  pizzaTypes: {
    name: string;
    emoji: string;
    ingredients: string[];
    bakeSeconds: number;
    soldOut: boolean;
    archived: boolean;
  }[];
  ovenLayers: { name: string; capacity: number }[];
  settings: { paypalLink: string; weroLink: string };
};

export function exportConfig(): ConfigExport {
  const settings = readSettings();
  return {
    format: CONFIG_FORMAT,
    version: CONFIG_VERSION,
    exportedAt: Date.now(),
    // Position is implied by array order rather than stored as a number, so a hand-edited
    // file can be reordered by moving lines around.
    pizzaTypes: allPizzaTypes()
      .slice()
      .sort((a: PizzaType, b: PizzaType) => a.position - b.position)
      .map((t) => ({
        name: t.name,
        emoji: t.emoji,
        ingredients: t.ingredients,
        bakeSeconds: t.bakeSeconds,
        soldOut: t.soldOut,
        archived: t.archivedAt !== null,
      })),
    ovenLayers: allLayers()
      .slice()
      .sort((a: OvenLayer, b: OvenLayer) => a.position - b.position)
      .map((l) => ({ name: l.name, capacity: l.capacity })),
    settings: { paypalLink: settings.paypalLink, weroLink: settings.weroLink },
  };
}

function asArray(v: unknown, field: string): unknown[] {
  if (!Array.isArray(v)) throw bad('invalid_field', `${field} must be an array`);
  if (v.length > 200) throw bad('invalid_field', `${field} has too many entries`);
  return v;
}

function asString(v: unknown, field: string, max: number, required = true): string {
  if (v === undefined || v === null) {
    if (required) throw bad('invalid_field', `${field} is required`);
    return '';
  }
  if (typeof v !== 'string') throw bad('invalid_field', `${field} must be text`);
  const s = v.trim();
  if (required && !s) throw bad('invalid_field', `${field} must not be empty`);
  if (s.length > max) throw bad('invalid_field', `${field} is too long`);
  return s;
}

function asLink(v: unknown, field: string): string {
  const s = asString(v, field, 300, false);
  if (!s) return '';
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw bad('invalid_field', `${field} must be a full link starting with https://`);
  }
  // Same rule as the admin form: a javascript: link here would be stored and then rendered
  // as a payment button on a guest's phone.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw bad('invalid_field', `${field} must start with https://`);
  }
  return s;
}

/**
 * Apply a config file.
 *
 * MERGE, NEVER REPLACE. Nothing is deleted and nothing is archived that was not archived in
 * the file - so importing during service cannot pull a pizza type out from under an order
 * that references it, or delete an oven deck with pizzas baking in it. Matching is by name,
 * which is also what makes an export from one Pi meaningful on another.
 *
 * `tx` is taken by the CALLER (routes/crew.ts), so the whole import is one transaction: a
 * file that fails validation half way through leaves the menu exactly as it was.
 */
export function importConfig(body: unknown): ImportSummary {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw bad('invalid_body', 'That file is not a config export.');
  }
  const file = body as Record<string, unknown>;

  if (file.format !== CONFIG_FORMAT) {
    throw bad(
      'wrong_format',
      'That file is not a Pizza Night config export. Pick the file you downloaded with Export.',
    );
  }
  if (typeof file.version !== 'number' || file.version > CONFIG_VERSION) {
    throw bad(
      'newer_version',
      'That file was made by a newer version of this app than the one running here.',
    );
  }

  const now = Date.now();
  const summary: ImportSummary = {
    pizzaTypes: { added: 0, updated: 0 },
    ovenLayers: { added: 0, updated: 0 },
    settingsChanged: [],
    keptNotInFile: { pizzaTypes: [], ovenLayers: [] },
  };

  // --- Pizza types -------------------------------------------------------------------------
  const existingTypes = allPizzaTypes();
  const typeByName = new Map(existingTypes.map((t) => [t.name.toLowerCase(), t]));
  const seenTypes = new Set<string>();

  const rawTypes = asArray(file.pizzaTypes ?? [], 'pizzaTypes');
  rawTypes.forEach((raw, i) => {
    if (typeof raw !== 'object' || raw === null) {
      throw bad('invalid_field', `pizzaTypes[${i}] must be an object`);
    }
    const t = raw as Record<string, unknown>;
    const name = asString(t.name, `pizzaTypes[${i}].name`, 60);
    const emoji = asString(t.emoji, `pizzaTypes[${i}].emoji`, 16, false) || '🍕';
    const ingredients = asArray(t.ingredients ?? [], `pizzaTypes[${i}].ingredients`)
      .map((x, j) => asString(x, `pizzaTypes[${i}].ingredients[${j}]`, 60, false))
      .filter(Boolean);
    const bakeSeconds = clamp(
      typeof t.bakeSeconds === 'number' && Number.isFinite(t.bakeSeconds) ? t.bakeSeconds : 300,
      30,
      3600,
    );
    const soldOut = t.soldOut === true ? 1 : 0;
    const archived = t.archived === true ? now : null;

    seenTypes.add(name.toLowerCase());
    const hit = typeByName.get(name.toLowerCase());
    if (hit) {
      db.prepare(
        'UPDATE pizza_types SET emoji = :emoji, ingredients = :ingredients, ' +
          'bake_seconds = :bake, sold_out = :soldOut, archived_at = :archived, ' +
          'position = :position, updated_at = :now WHERE id = :id',
      ).run({
        id: hit.id,
        emoji,
        ingredients: JSON.stringify(ingredients),
        bake: bakeSeconds,
        soldOut,
        archived,
        position: i,
        now,
      });
      summary.pizzaTypes.updated += 1;
    } else {
      db.prepare(
        'INSERT INTO pizza_types (name, emoji, ingredients, bake_seconds, sold_out, ' +
          'archived_at, position, created_at, updated_at) ' +
          'VALUES (:name, :emoji, :ingredients, :bake, :soldOut, :archived, :position, :now, :now)',
      ).run({
        name,
        emoji,
        ingredients: JSON.stringify(ingredients),
        bake: bakeSeconds,
        soldOut,
        archived,
        position: i,
        now,
      });
      summary.pizzaTypes.added += 1;
    }
  });

  // Anything on the menu that the file did not mention STAYS. Reported so the crew can see
  // it rather than discovering it later.
  summary.keptNotInFile.pizzaTypes = existingTypes
    .filter((t) => !seenTypes.has(t.name.toLowerCase()))
    .map((t) => t.name);

  // --- Oven decks --------------------------------------------------------------------------
  const existingLayers = allLayers();
  const layerByName = new Map(existingLayers.map((l) => [l.name.toLowerCase(), l]));
  const seenLayers = new Set<string>();

  const rawLayers = asArray(file.ovenLayers ?? [], 'ovenLayers');
  rawLayers.forEach((raw, i) => {
    if (typeof raw !== 'object' || raw === null) {
      throw bad('invalid_field', `ovenLayers[${i}] must be an object`);
    }
    const l = raw as Record<string, unknown>;
    const name = asString(l.name, `ovenLayers[${i}].name`, 40);
    const capacity = clamp(
      typeof l.capacity === 'number' && Number.isFinite(l.capacity) ? l.capacity : 4,
      1,
      12,
    );
    seenLayers.add(name.toLowerCase());
    const hit = layerByName.get(name.toLowerCase());
    if (hit) {
      // Capacity is NOT shrunk below what is currently in the deck: the unique slot index
      // would still hold, but a pizza would be left sitting in a slot the UI no longer
      // draws, which looks exactly like a lost pizza.
      const deepest = db
        .prepare(
          "SELECT COALESCE(MAX(oven_slot), -1) AS s FROM orders WHERE oven_layer_id = :id " +
            "AND status = 'BAKING' AND cancelled_at IS NULL",
        )
        .get({ id: hit.id }) as { s: number };
      const safeCapacity = Math.max(capacity, deepest.s + 1);
      db.prepare(
        'UPDATE oven_layers SET capacity = :cap, position = :position, updated_at = :now ' +
          'WHERE id = :id',
      ).run({ id: hit.id, cap: safeCapacity, position: i, now });
      summary.ovenLayers.updated += 1;
    } else {
      db.prepare(
        'INSERT INTO oven_layers (name, capacity, position, created_at, updated_at) ' +
          'VALUES (:name, :capacity, :position, :now, :now)',
      ).run({ name, capacity, position: i, now });
      summary.ovenLayers.added += 1;
    }
  });
  summary.keptNotInFile.ovenLayers = existingLayers
    .filter((l) => !seenLayers.has(l.name.toLowerCase()))
    .map((l) => l.name);

  // --- Payment links -----------------------------------------------------------------------
  const rawSettings = file.settings;
  if (typeof rawSettings === 'object' && rawSettings !== null && !Array.isArray(rawSettings)) {
    const st = rawSettings as Record<string, unknown>;
    const current = readSettings();
    if (st.paypalLink !== undefined) {
      const link = asLink(st.paypalLink, 'settings.paypalLink');
      if (link !== current.paypalLink) {
        writeSetting('paypal_link', link);
        summary.settingsChanged.push('PayPal link');
      }
    }
    if (st.weroLink !== undefined) {
      const link = asLink(st.weroLink, 'settings.weroLink');
      if (link !== current.weroLink) {
        writeSetting('wero_link', link);
        summary.settingsChanged.push('Wero link');
      }
    }
  }

  // orders_open is deliberately NOT imported. Whether tonight is taking orders is about
  // right now, not about configuration, and a file from last week must not close the door.

  log(
    `IMPORT types +${summary.pizzaTypes.added}/~${summary.pizzaTypes.updated} ` +
      `layers +${summary.ovenLayers.added}/~${summary.ovenLayers.updated}`,
  );
  return summary;
}
