// A log of what changed on an app's listing, so a rank move can be read next to what the
// developer did: a new name (usually an App Store search play), a new price, a new seller,
// a different category, or in-app purchases added, dropped or repriced.
//
// Names, prices, sellers and categories come from the daily Lookup call, for every charting app.
// In-app purchases come from the weekly App Store page read, for researched apps only.

import type { AppDetails } from "./apple.ts";
import type { PriceRow } from "./prices.ts";

export type ChangeField = "name" | "price" | "seller" | "publisher" | "category" | "purchase added" | "purchase removed" | "purchase price";

export interface ChangeRow {
  /** The scan that first saw the change. The change itself happened since the scan before. */
  date: string;
  app_id: string;
  field: ChangeField;
  from: string;
  to: string;
}

const DETAIL_FIELDS: [ChangeField, (a: AppDetails) => string][] = [
  ["name", (a) => a.name.trim()],
  ["price", (a) => String(a.price)],
  ["seller", (a) => a.seller.trim()],
  ["publisher", (a) => a.publisher.trim()],
  ["category", (a) => a.primaryGenre.trim()],
];

/** What changed between yesterday's and today's Lookup result for one app. */
export function detailChanges(date: string, before: AppDetails | undefined, after: AppDetails): ChangeRow[] {
  if (!before) return [];
  const out: ChangeRow[] = [];
  for (const [field, read] of DETAIL_FIELDS) {
    const from = read(before);
    const to = read(after);
    // An empty old value is a column that didn't exist yet, not a change.
    if (from === "" || to === "" || from === to) continue;
    if (field === "price" && Number(from) === Number(to)) continue;
    out.push({ date, app_id: after.appId, field, from, to });
  }
  return out;
}

/** What changed in an app's in-app purchase list between two page reads. Nothing on the first read. */
export function purchaseChanges(date: string, appId: string, before: PriceRow[] | undefined, after: PriceRow[]): ChangeRow[] {
  if (!before) return [];
  const list = (rows: PriceRow[]) => new Map(rows.filter((r) => r.item).map((r) => [r.item, r.price_text]));
  const was = list(before);
  const now = list(after);
  const out: ChangeRow[] = [];
  for (const [item, price] of now) {
    if (!was.has(item)) out.push({ date, app_id: appId, field: "purchase added", from: "", to: `${item} ${price}`.trim() });
    else if (was.get(item) !== price) out.push({ date, app_id: appId, field: "purchase price", from: `${item} ${was.get(item)}`.trim(), to: `${item} ${price}`.trim() });
  }
  for (const [item, price] of was) {
    if (!now.has(item)) out.push({ date, app_id: appId, field: "purchase removed", from: `${item} ${price}`.trim(), to: "" });
  }
  return out;
}

const money = (value: string) => (Number(value) === 0 ? "free" : Number(value).toFixed(2));

/** One change as a sentence: "Renamed from “A” to “B”." */
export function describeChange(c: ChangeRow): string {
  switch (c.field) {
    case "name": return `Renamed from “${c.from}” to “${c.to}”.`;
    case "price": return `Price changed from ${money(c.from)} to ${money(c.to)}.`;
    case "seller": return `Seller changed from ${c.from} to ${c.to}.`;
    case "publisher": return `Publisher name changed from ${c.from} to ${c.to}.`;
    case "category": return `Moved from ${c.from} to ${c.to}.`;
    case "purchase added": return `Added an in-app purchase: ${c.to}.`;
    case "purchase removed": return `Dropped an in-app purchase: ${c.from}.`;
    case "purchase price": return `Repriced an in-app purchase: ${c.from} is now ${c.to}.`;
  }
}

/** Changes on or after `since`, newest first. */
export function recentChanges(rows: ChangeRow[], since: string): ChangeRow[] {
  return rows.filter((r) => r.date >= since).sort((a, b) => b.date.localeCompare(a.date) || a.app_id.localeCompare(b.app_id));
}
