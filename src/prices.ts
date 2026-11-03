// What an app charges: the "In-App Purchases" list on its App Store page (Apple shows up to 10).
// Apple has no API for this, so it's read from the JSON the web page embeds. That JSON is
// undocumented: if Apple changes the page, the scan logs it, saves nothing and carries on.

import { fetchText } from "./apple.ts";

export type Period = "weekly" | "monthly" | "yearly" | "lifetime" | "other" | "";

export interface PriceRow {
  app_id: string;
  /** The purchase's name as the developer wrote it. Empty when the app lists no purchases. */
  item: string;
  price: number | null;
  /** Exactly as the page shows it, currency and all: "$39.99", "39,99 €". */
  price_text: string;
  /** Guessed from the item's name (English words only); "other" when the name doesn't say. */
  period: Period;
  checked_at: string;
}

export const RECHECK_DAYS = 7;

export function pageUrl(country: string, appId: string): string {
  return `https://apps.apple.com/${country}/app/id${appId}`;
}

const NUMBER = /\d(?:[\d.,'\s  ]*\d)?/;

/**
 * "$39.99" → 39.99, "39,99 €" → 39.99, "¥1,200" → 1200, "1.299,00 kr" → 1299.
 * Null for anything that isn't a price, such as "Requires iOS 16.4 or later."
 */
export function parsePrice(text: string): number | null {
  const match = text.match(NUMBER);
  if (!match) return null;
  // A price is a number plus a short currency marker ("$", "kr", "CHF", "R$"), nothing more.
  const rest = text.replace(match[0], "").replace(/[\s  ]/g, "");
  if (!rest || rest.length > 4 || /\d/.test(rest)) return null;

  const digits = match[0].replace(/[\s  ']/g, "");
  const decimal = digits.match(/[.,](\d{1,2})$/);
  const whole = (decimal ? digits.slice(0, -decimal[0].length) : digits).replace(/[.,]/g, "");
  return Number(decimal ? `${whole}.${decimal[1]}` : whole);
}

/** 42 shown the way `sample` shows prices: formatPrice("39,99 €", 42) → "42,00 €". */
export function formatPrice(sample: string, value: number): string {
  const match = sample.match(NUMBER);
  if (!match) return value.toFixed(2);
  const decimal = match[0].match(/([.,])\d{1,2}$/);
  const text = decimal ? value.toFixed(2).replace(".", decimal[1]) : String(Math.round(value));
  return sample.replace(match[0], text);
}

export function periodOf(item: string): Period {
  const t = item.toLowerCase();
  if (/\b(lifetime|forever|permanent|one[- ]time)\b/.test(t)) return "lifetime";
  if (/\b(week|weekly|7[- ]days?)\b/.test(t)) return "weekly";
  const months = t.match(/\b(\d+)[- ]?months?\b/);
  if (months) return Number(months[1]) === 12 ? "yearly" : Number(months[1]) === 1 ? "monthly" : "other";
  if (/\b(year|yearly|annual|annually)\b/.test(t)) return "yearly";
  if (/\b(month|monthly)\b/.test(t)) return "monthly";
  return "other";
}

type Node = { $kind?: string; items?: Node[]; leadingText?: string; trailingText?: string; [key: string]: unknown };

/** Every "Annotation" (a row of the page's Information section) anywhere in the page data. */
function annotations(node: unknown, out: Node[] = []): Node[] {
  if (Array.isArray(node)) for (const v of node) annotations(v, out);
  else if (node && typeof node === "object") {
    if ((node as Node).$kind === "Annotation") out.push(node as Node);
    for (const v of Object.values(node)) annotations(v, out);
  }
  return out;
}

/**
 * The in-app purchases listed on an App Store page. Finds the Information row whose entries
 * are name/price pairs, so it works in any language ("In-App Purchases", "In-App-Käufe").
 * Empty if the app sells nothing; throws if the page has no data we recognise.
 */
export function parsePrices(html: string, appId: string, checkedAt: string): PriceRow[] {
  const script = html.match(/<script[^>]*id="?serialized-server-data"?[^>]*>([\s\S]*?)<\/script>/);
  if (!script) throw new Error("no page data found (Apple may have changed the page)");

  const lists = annotations(JSON.parse(script[1])).map((a) =>
    (a.items ?? []).filter((i) => i.$kind === "textPair" && i.trailingText && parsePrice(i.trailingText) !== null),
  );
  const pairs = lists.sort((a, b) => b.length - a.length)[0] ?? [];

  const seen = new Set<string>();
  const rows: PriceRow[] = [];
  for (const p of pairs) {
    const item = (p.leadingText ?? "").replace(/\s+/g, " ").trim();
    const key = `${item}\t${p.trailingText}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      app_id: appId,
      item,
      price: parsePrice(p.trailingText!),
      price_text: p.trailingText!.replace(/[  ]/g, " "),
      period: periodOf(item),
      checked_at: checkedAt,
    });
  }
  return rows;
}

/** One app's purchases, or a single empty row recording that it lists none. */
export async function fetchPrices(country: string, appId: string, checkedAt: string): Promise<PriceRow[]> {
  const rows = parsePrices(await fetchText(pageUrl(country, appId)), appId, checkedAt);
  return rows.length ? rows : [{ app_id: appId, item: "", price: null, price_text: "", period: "", checked_at: checkedAt }];
}

export function isStale(rows: PriceRow[] | undefined, today: string): boolean {
  return !rows?.length || Date.parse(today) - Date.parse(rows[0].checked_at) >= RECHECK_DAYS * 86_400_000;
}

export interface PeriodSummary {
  period: Period;
  /** Apps with at least one purchase of this kind. */
  apps: number;
  /** Median across apps of each app's own median price, so an app listing 6 tiers counts once. */
  median: number;
  min: number;
  max: number;
  /** One price as shown, for currency formatting. */
  sample: string;
}

export interface PricingSummary {
  /** Apps whose page was read. */
  checked: number;
  /** Apps that list at least one purchase. */
  selling: number;
  periods: PeriodSummary[];
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const ORDER: Period[] = ["weekly", "monthly", "yearly", "lifetime", "other"];

/** How a group of apps (a niche) prices its purchases, period by period. */
export function pricingSummary(byApp: PriceRow[][]): PricingSummary {
  const checked = byApp.filter((rows) => rows.length);
  const selling = checked.map((rows) => rows.filter((r) => r.item && r.price !== null)).filter((rows) => rows.length);
  const periods = ORDER.map((period) => {
    const perApp = selling.map((rows) => rows.filter((r) => r.period === period)).filter((rows) => rows.length);
    const all = perApp.flat().map((r) => r.price!);
    return {
      period,
      apps: perApp.length,
      median: perApp.length ? median(perApp.map((rows) => median(rows.map((r) => r.price!)))) : 0,
      min: all.length ? Math.min(...all) : 0,
      max: all.length ? Math.max(...all) : 0,
      sample: perApp[0]?.[0].price_text ?? "",
    };
  }).filter((p) => p.apps > 0);
  return { checked: checked.length, selling: selling.length, periods };
}
