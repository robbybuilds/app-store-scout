// The rest of an app's App Store page, from the same undocumented JSON that prices.ts reads:
// how its ratings split by star, its recent versions, its privacy label, Apple's badges, and the
// apps Apple suggests next to it ("You Might Also Like"). One page fetch a week per researched app.

import { fetchText } from "./apple.ts";
import { type PriceRow, pageData, pageUrl, pricesFrom, withNoneMarker } from "./prices.ts";

/** The most a privacy label admits to. "none" means "Data Not Collected"; "" means no label at all. */
export type Privacy = "tracking" | "linked" | "not-linked" | "none" | "";

export interface PageRow {
  app_id: string;
  /** Ratings by star, as Apple's histogram shows them. They add up to the app's rating count. */
  stars_5: number;
  stars_4: number;
  stars_3: number;
  stars_2: number;
  stars_1: number;
  editors_choice: boolean;
  /** "4+", "12+", "18+". */
  age_rating: string;
  size_mb: number | null;
  privacy: Privacy;
  /** Data used to track people across other companies' apps: "identifiers;location". */
  tracking: string;
  checked_at: string;
}

/** One release from the page's version history (Apple shows the latest 25). */
export interface VersionRow {
  app_id: string;
  version: string;
  date: string;
}

/** One of the apps Apple shows under "You Might Also Like", in Apple's order. */
export interface SimilarRow {
  app_id: string;
  position: number;
  similar_id: string;
  name: string;
  developer: string;
  checked_at: string;
}

export interface Page {
  prices: PriceRow[];
  page: PageRow;
  versions: VersionRow[];
  similar: SimilarRow[];
}

type Node = { $kind?: string; items?: Node[]; [key: string]: unknown };

/** The page's shelves by name: "productRatings", "similarItems" and so on. */
function shelves(node: unknown): Record<string, Node> {
  if (Array.isArray(node)) {
    for (const v of node) {
      const found = shelves(v);
      if (Object.keys(found).length) return found;
    }
  } else if (node && typeof node === "object") {
    const mapping = (node as Record<string, unknown>).shelfMapping;
    if (mapping && typeof mapping === "object") return mapping as Record<string, Node>;
    for (const v of Object.values(node)) {
      const found = shelves(v);
      if (Object.keys(found).length) return found;
    }
  }
  return {};
}

const items = (shelf: Node | undefined): Node[] => (Array.isArray(shelf?.items) ? shelf.items : []);

const PRIVACY: [string, Privacy][] = [
  ["DATA_USED_TO_TRACK_YOU", "tracking"],
  ["DATA_LINKED_TO_YOU", "linked"],
  ["DATA_NOT_LINKED_TO_YOU", "not-linked"],
  ["DATA_NOT_COLLECTED", "none"],
];

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "Mon Nov 02 2026 16:40:58 GMT+0000 (…)" → "2026-11-02". Apple writes it in English everywhere. */
export function versionDate(text: string): string {
  const m = text.match(/\b([A-Z][a-z]{2}) (\d{1,2}) (\d{4})\b/);
  const month = m ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
  if (!m || month < 0) return "";
  return `${m[3]}-${String(month + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

/** "523,7" with caption "MB" → 523.7; "20.8" "GB" → 21299.2. */
export function sizeMb(text: string, unit: string): number | null {
  const value = Number(text.replace(",", "."));
  const scale = { KB: 1 / 1024, MB: 1, GB: 1024 }[unit.trim().toUpperCase()];
  return Number.isFinite(value) && scale ? Math.round(value * scale * 10) / 10 : null;
}

export function parsePage(html: string, appId: string, checkedAt: string): Page {
  const data = pageData(html);
  const shelf = shelves(data);

  // Apple sometimes sends these as 417244.00000000006.
  const counts = ((items(shelf.productRatings)[0]?.ratingCounts as number[] | undefined) ?? []).map(Math.round);
  const badges = items(shelf.informationRibbon);
  const badge = (key: string) => badges.find((b) => b.key === key || b.type === key);
  const content = (key: string) => (badge(key)?.content ?? {}) as Record<string, unknown>;
  const size = badge("size");

  const types = items(shelf.privacyTypes);
  const present = types.map((t) => t.identifier);
  const tracking = types.find((t) => t.identifier === "DATA_USED_TO_TRACK_YOU");

  const page: PageRow = {
    app_id: appId,
    stars_5: counts[0] ?? 0,
    stars_4: counts[1] ?? 0,
    stars_3: counts[2] ?? 0,
    stars_2: counts[3] ?? 0,
    stars_1: counts[4] ?? 0,
    editors_choice: !!badge("editorsChoice"),
    age_rating: String(content("contentRating").contentRating ?? ""),
    size_mb: size ? sizeMb(String(content("size").paragraphText ?? ""), String(size.caption ?? "")) : null,
    privacy: PRIVACY.find(([id]) => present.includes(id))?.[1] ?? "",
    tracking: ((tracking?.categories as Node[] | undefined) ?? [])
      .map((c) => String(c.identifier).toLowerCase())
      .join(";"),
    checked_at: checkedAt,
  };

  // The full list (up to 25) sits behind "Version History"; the shelf itself only has the latest.
  const latest = shelf.mostRecentVersion;
  const history = ((latest?.seeAllAction as Node | undefined)?.pageData as { shelves?: Node[] } | undefined)?.shelves;
  const releases = history?.length ? history.flatMap(items) : items(latest);
  const seen = new Set<string>();
  const versions: VersionRow[] = [];
  for (const r of releases) {
    const version = String(r.primarySubtitle ?? "").split(" ").pop() ?? "";
    const date = versionDate(String(r.secondarySubtitle ?? ""));
    if (!version || !date || seen.has(version)) continue;
    seen.add(version);
    versions.push({ app_id: appId, version, date });
  }

  const similar = items(shelf.similarItems)
    .filter((l) => l.adamId)
    .map((l, i) => ({
      app_id: appId,
      position: i + 1,
      similar_id: String(l.adamId),
      name: String(l.title ?? ""),
      developer: String(l.developerName ?? ""),
      checked_at: checkedAt,
    }));

  return { prices: withNoneMarker(pricesFrom(data, appId, checkedAt), appId, checkedAt), page, versions, similar };
}

export async function fetchPage(country: string, appId: string, checkedAt: string): Promise<Page> {
  return parsePage(await fetchText(pageUrl(country, appId)), appId, checkedAt);
}

/** Adds releases to the ones already saved. Apple only shows 25, so older ones are kept from earlier checks. */
export function mergeVersions(versions: Map<string, VersionRow[]>, fresh: VersionRow[]): void {
  for (const v of fresh) {
    const rows = versions.get(v.app_id) ?? [];
    if (!rows.some((r) => r.version === v.version)) rows.push(v);
    versions.set(v.app_id, rows);
  }
  for (const rows of versions.values()) rows.sort((a, b) => b.date.localeCompare(a.date) || b.version.localeCompare(a.version));
}

export function totalStars(p: PageRow): number {
  return p.stars_5 + p.stars_4 + p.stars_3 + p.stars_2 + p.stars_1;
}

/** Share of an app's ratings that are 1 or 2 stars. Null with too few ratings to mean much. */
export function lowStarShare(p: PageRow, minRatings = 20): number | null {
  const total = totalStars(p);
  return total >= minRatings ? (p.stars_1 + p.stars_2) / total : null;
}

/** How many releases an app shipped in the `days` before `today`. */
export function releasesWithin(versions: VersionRow[], today: string, days = 90): number {
  const since = new Date(Date.parse(today) - days * 86_400_000).toISOString().slice(0, 10);
  return versions.filter((v) => v.date > since && v.date <= today).length;
}

export interface Suggestion {
  similar_id: string;
  name: string;
  developer: string;
  /** How many of the given apps Apple shows it next to. */
  apps: number;
}

/**
 * The apps Apple most often suggests alongside a group of apps (a niche), leaving out the group's
 * own apps. Apple builds these lists from what people view and buy, so a name that keeps coming
 * up is a competitor the niche list missed.
 */
export function alsoSuggested(byApp: SimilarRow[][], exclude: Set<string>, minApps = 2): Suggestion[] {
  const out = new Map<string, Suggestion>();
  for (const rows of byApp) {
    for (const r of new Map(rows.map((r) => [r.similar_id, r])).values()) {
      if (exclude.has(r.similar_id)) continue;
      const s = out.get(r.similar_id) ?? { similar_id: r.similar_id, name: r.name, developer: r.developer, apps: 0 };
      s.apps++;
      out.set(r.similar_id, s);
    }
  }
  return [...out.values()].filter((s) => s.apps >= minApps).sort((a, b) => b.apps - a.apps || a.name.localeCompare(b.name));
}
