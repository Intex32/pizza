import type { Order, PizzaType } from './types.ts';

/** Used only when an order's pizza type was hard-deleted before it reached the oven. */
export const DEFAULT_BAKE_SECONDS = 300;

export type IngredientCount = { name: string; count: number };

/**
 * Shopping list for the admin screen.
 *
 * Deliberately joins against the LIVE pizza types by id, not the name snapshotted on the
 * order: if you fix a recipe, the list you shop from updates. Orders whose type no longer
 * exists cannot contribute ingredients and are reported separately rather than dropped.
 */
export function rollUpIngredients(
  orders: Order[],
  types: PizzaType[],
): { ingredients: IngredientCount[]; orphanOrders: number } {
  const byId = new Map(types.map((t) => [t.id, t]));
  const counts = new Map<string, number>();
  let orphanOrders = 0;

  for (const o of orders) {
    const t = o.pizzaTypeId === null ? undefined : byId.get(o.pizzaTypeId);
    if (!t) {
      orphanOrders += 1;
      continue;
    }
    for (const raw of t.ingredients) {
      const name = raw.trim();
      if (!name) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }

  const ingredients = [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return { ingredients, orphanOrders };
}

/**
 * "How many people ordered each pizza type" - the pre-event estimation view.
 * Grouped by the SNAPSHOTTED name so a renamed or retired type still reads correctly.
 */
export function countByType(
  orders: Order[],
): { name: string; emoji: string; count: number }[] {
  const counts = new Map<string, { emoji: string; count: number }>();
  for (const o of orders) {
    const found = counts.get(o.pizzaTypeName);
    if (found) found.count += 1;
    else counts.set(o.pizzaTypeName, { emoji: o.pizzaTypeEmoji, count: 1 });
  }
  return [...counts]
    .map(([name, v]) => ({ name, emoji: v.emoji, count: v.count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** How the evening's money came in. `unpaid` is counted separately and deliberately: it
 *  means the counter never recorded anything, which is different from "it was free". */
export function countByPayment(orders: Order[]): {
  cash: number;
  paypal: number;
  free: number;
  unpaid: number;
} {
  const out = { cash: 0, paypal: 0, free: 0, unpaid: 0 };
  for (const o of orders) {
    if (o.paymentMethod === null) out.unpaid += 1;
    else out[o.paymentMethod] += 1;
  }
  return out;
}

export function formatIngredients(ingredients: string[]): string {
  return ingredients.join(', ');
}
