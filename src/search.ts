// iTunes Search API: what a customer sees when they search the App Store for a niche.
// Answers "how crowded is this?": up to 200 results per term, no key.

import { type AppDetails, fetchJson, parseLookup } from "./apple.ts";

export const SEARCH_LIMIT = 200;
/** Apps with at least this many ratings count as established. */
export const ESTABLISHED_RATINGS = 10_000;

export function searchUrl(country: string, term: string, limit = SEARCH_LIMIT): string {
  const q = encodeURIComponent(term).replace(/%20/g, "+");
  return `https://itunes.apple.com/search?term=${q}&entity=software&country=${country}&limit=${limit}`;
}

export async function searchApps(country: string, term: string): Promise<AppDetails[]> {
  return parseLookup(await fetchJson(searchUrl(country, term)));
}

export interface SearchSummary {
  date: string;
  term: string;
  /** Results returned; Apple stops at 200, so 200 means "200 or more". */
  results: number;
  /** Results with 10,000+ ratings. */
  established: number;
  /** Results released in the last year. */
  new_apps: number;
  /** Median ratings of the top 10 results: how big you have to be to rank for this search. */
  top10_median_ratings: number;
}

export interface SearchRow {
  date: string;
  term: string;
  position: number;
  app_id: string;
  name: string;
  publisher: string;
  rating_count: number;
  released_at: string;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

export function summariseSearch(date: string, term: string, results: AppDetails[], newAppMaxAgeDays = 365): SearchSummary {
  const cutoff = new Date(Date.parse(date) - newAppMaxAgeDays * 86_400_000).toISOString().slice(0, 10);
  return {
    date,
    term,
    results: results.length,
    established: results.filter((a) => a.ratingCount >= ESTABLISHED_RATINGS).length,
    new_apps: results.filter((a) => a.releasedAt >= cutoff).length,
    top10_median_ratings: median(results.slice(0, 10).map((a) => a.ratingCount)),
  };
}

/** The first `top` results, in Apple's order, for the record. */
export function topResults(date: string, term: string, results: AppDetails[], top = 10): SearchRow[] {
  return results.slice(0, top).map((a, i) => ({
    date,
    term,
    position: i + 1,
    app_id: a.appId,
    name: a.name,
    publisher: a.publisher,
    rating_count: a.ratingCount,
    released_at: a.releasedAt,
  }));
}
