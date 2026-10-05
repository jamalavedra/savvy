import { readFileSync } from "node:fs";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import { isDeepStrictEqual } from "node:util";
import type { ServiceState } from "./state.js";
import { get, stripeBilling, stripeId, stripeObject } from "./stripe.js";

export interface Offer {
  version: string;
  currency: string;
  amountCents: number;
  interval: string | null;
  hours: number;
  briefs: number;
  expiry: string;
}
export const CATALOG: Record<"monthly" | "pack", Offer> = JSON.parse(
  readFileSync(
    new URL("../../config/managed-catalog.json", import.meta.url),
    "utf8",
  ),
);
export type Product = keyof typeof CATALOG;

export function historical(db: Db, price: string, product: Product): Offer {
  const row = db
    .prepare<[string, string], { offer_json: string }>(
      "SELECT offer_json FROM catalog_prices WHERE price_id=? AND product=?",
    )
    .get(price, product);
  if (!row)
    throw new ApiError(
      "payment_pending",
      "purchase catalog identity needs reconciliation",
    );
  return JSON.parse(row.offer_json) as Offer;
}

export async function validatePrice(state: ServiceState, product: Product) {
  const price =
    product === "monthly"
      ? stripeBilling(state).priceMonthly
      : stripeBilling(state).pricePack;
  await associatePrice(state, price, product, true);
  return price;
}

export async function recoverPrice(
  state: ServiceState,
  price: string,
  product: Product,
): Promise<Offer> {
  const row = state.db
    .prepare("SELECT 1 FROM catalog_prices WHERE price_id=? AND product=?")
    .get(price, product);
  if (!row) await associatePrice(state, price, product, false);
  return historical(state.db, price, product);
}

async function associatePrice(
  state: ServiceState,
  price: string,
  product: Product,
  newPurchase: boolean,
) {
  const offer = CATALOG[product];
  const value = await get(state, `prices/${stripeId(price)}`);
  if (
    value.id !== price ||
    (newPurchase && value.active !== true) ||
    value.currency !== offer.currency ||
    value.unit_amount !== offer.amountCents ||
    value.billing_scheme !== "per_unit" ||
    value.transform_quantity != null ||
    (offer.interval !== null
      ? value.type !== "recurring" ||
        stripeObject(value.recurring).interval !== offer.interval ||
        stripeObject(value.recurring).interval_count !== 1 ||
        stripeObject(value.recurring).usage_type !== "licensed"
      : value.type !== "one_time" || value.recurring != null) ||
    stripeObject(value.metadata).savvy_catalog_version !== offer.version
  ) {
    throw new ApiError(
      newPurchase ? "provider_unavailable" : "payment_pending",
      newPurchase
        ? "new purchases unavailable: Stripe catalog mismatch"
        : "legacy Price does not establish a known catalog identity",
    );
  }
  state.db
    .transaction(() => {
      state.db
        .prepare(
          "INSERT OR IGNORE INTO catalog_prices(price_id,product,offer_json) VALUES(?,?,?)",
        )
        .run(price, product, JSON.stringify(offer));
      if (!isDeepStrictEqual(historical(state.db, price, product), offer))
        throw new ApiError(
          "provider_unavailable",
          "new purchases unavailable: historical Price cannot be reassigned",
        );
    })
    .immediate();
}
