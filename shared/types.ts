// TYPES ONLY. `verbatimModuleSyntax` means a value-style import from this module is a
// compile error rather than a runtime "module has no export" that reads like a bundler bug.
import type { Status } from './status.ts';
import type { PaymentMethod } from './payment.ts';

export type Order = {
  id: number;
  customerName: string;
  note: string;
  pizzaTypeId: number | null;
  pizzaTypeName: string;
  /** Snapshotted with the name, so a deleted type still renders as itself. */
  pizzaTypeEmoji: string;
  /** Recorded at the counter when the order moves to preparation. */
  paymentMethod: PaymentMethod | null;
  status: Status;
  cancelledAt: number | null;
  cancelReason: string;
  remadeFrom: number | null;
  paidAt: number | null;
  createdAt: number;
  updatedAt: number;
  queuedAt: number | null;
  bakingStartedAt: number | null;
  bakeSeconds: number | null;
  readyAt: number | null;
  pickedUpAt: number | null;
  ovenLayerId: number | null;
  /** 0-based position within the deck. null when the pizza has no recorded position. */
  ovenSlot: number | null;
};

/** What a customer gets back: their own order, including the token that addresses it. */
export type CustomerOrder = Order & { publicToken: string };

export type PizzaType = {
  id: number;
  name: string;
  emoji: string;
  ingredients: string[];
  bakeSeconds: number;
  soldOut: boolean;
  archivedAt: number | null;
  position: number;
};

/** The subset a customer is shown - no bake times, archived types omitted entirely. */
export type PublicPizzaType = Pick<
  PizzaType,
  'id' | 'name' | 'emoji' | 'ingredients' | 'soldOut'
>;

export type OvenLayer = {
  id: number;
  name: string;
  capacity: number;
  position: number;
};

export type Settings = { ordersOpen: boolean };

/** The single payload every crew screen renders from. */
export type CrewState = {
  version: number;
  serverNow: number;
  orders: Order[];
  layers: OvenLayer[];
  pizzaTypes: PizzaType[];
  settings: Settings;
};

export type PublicConfig = {
  ordersOpen: boolean;
  pizzaTypes: PublicPizzaType[];
  serverNow: number;
};

export type ApiErrorBody = {
  error: { code: string; message?: string; details?: unknown };
};
