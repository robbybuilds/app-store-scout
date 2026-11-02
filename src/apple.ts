// Apple's public, keyless endpoints:
// - Legacy iTunes RSS charts (the only free feed with top-grossing and per-genre charts, 100 apps max)
// - iTunes Lookup API for ratings, release dates and publisher details (up to 200 ids per call)

import type { Chart } from "./config.ts";

export interface ChartEntry {
  rank: number;
  appId: string;
  name: string;
  publisher: string;
  genreId: number;
}

export interface ChartResult {
  /** When Apple says the feed was last updated (ISO), if present. */
  sourceUpdatedAt: string | null;
  entries: ChartEntry[];
}

export interface AppDetails {
  appId: string;
  name: string;
  publisher: string;
  publisherId: string;
  primaryGenre: string;
  price: number;
  ratingCount: number;
  averageRating: number;
  releasedAt: string;
  updatedAt: string;
  url: string;
}

const FEED_NAMES: Record<Chart, string> = {
  "top-free": "topfreeapplications",
  "top-paid": "toppaidapplications",
  "top-grossing": "topgrossingapplications",
};

const USER_AGENT = "app-store-scout (+https://github.com/robbybuilds/app-store-scout)";

export function chartUrl(country: string, chart: Chart, genreId: number, limit = 100): string {
  const genre = genreId ? `/genre=${genreId}` : "";
  return `https://itunes.apple.com/${country}/rss/${FEED_NAMES[chart]}/limit=${limit}${genre}/json`;
}

export async function fetchJson(url: string, attempts = 3): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(1000 * 2 ** attempt);
    }
  }
  throw lastError;
}

// The legacy feed wraps every value as { label, attributes }, and returns a single
// object instead of an array when a chart has one entry.
type Labelled = { label?: string; attributes?: Record<string, string> };
type RawEntry = Record<string, Labelled>;

export function parseChart(json: unknown): ChartResult {
  const feed = (json as { feed?: { updated?: Labelled; entry?: RawEntry | RawEntry[] } }).feed;
  if (!feed) throw new Error("Unexpected chart response: no feed");
  const raw = feed.entry === undefined ? [] : Array.isArray(feed.entry) ? feed.entry : [feed.entry];

  const entries = raw.map((e, i) => ({
    rank: i + 1,
    appId: e.id?.attributes?.["im:id"] ?? "",
    name: e["im:name"]?.label ?? "",
    publisher: e["im:artist"]?.label ?? "",
    genreId: Number(e.category?.attributes?.["im:id"] ?? 0),
  }));

  return {
    sourceUpdatedAt: feed.updated?.label ? new Date(feed.updated.label).toISOString() : null,
    entries: entries.filter((e) => e.appId),
  };
}

export async function fetchChart(country: string, chart: Chart, genreId: number): Promise<ChartResult> {
  return parseChart(await fetchJson(chartUrl(country, chart, genreId)));
}

interface RawLookup {
  trackId: number;
  trackName: string;
  artistName: string;
  artistId: number;
  primaryGenreName: string;
  price?: number;
  userRatingCount?: number;
  averageUserRating?: number;
  releaseDate: string;
  currentVersionReleaseDate?: string;
  trackViewUrl: string;
}

export function parseLookup(json: unknown): AppDetails[] {
  const results = (json as { results?: RawLookup[] }).results ?? [];
  return results
    .filter((r) => r.trackId)
    .map((r) => ({
      appId: String(r.trackId),
      name: r.trackName,
      publisher: r.artistName,
      publisherId: String(r.artistId),
      primaryGenre: r.primaryGenreName,
      price: r.price ?? 0,
      ratingCount: r.userRatingCount ?? 0,
      averageRating: Math.round((r.averageUserRating ?? 0) * 100) / 100,
      releasedAt: r.releaseDate?.slice(0, 10) ?? "",
      updatedAt: r.currentVersionReleaseDate?.slice(0, 10) ?? "",
      url: r.trackViewUrl?.split("?")[0] ?? "",
    }));
}

export async function lookupApps(country: string, appIds: string[]): Promise<AppDetails[]> {
  const details: AppDetails[] = [];
  for (let i = 0; i < appIds.length; i += 150) {
    const ids = appIds.slice(i, i + 150).join(",");
    details.push(...parseLookup(await fetchJson(`https://itunes.apple.com/lookup?id=${ids}&country=${country}`)));
    await sleep(500);
  }
  return details;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
