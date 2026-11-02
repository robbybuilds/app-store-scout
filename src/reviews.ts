// App Store customer reviews from Apple's public RSS feed: the most recent ~500 per app
// (10 pages of 50), no key. Reviewer names are not kept.

import { fetchJson, sleep } from "./apple.ts";

export interface Review {
  id: string;
  rating: number;
  version: string;
  date: string;
  title: string;
  body: string;
}

const MAX_PAGES = 10;

export function reviewsUrl(country: string, appId: string, page: number): string {
  return `https://itunes.apple.com/${country}/rss/customerreviews/page=${page}/id=${appId}/sortby=mostrecent/json`;
}

type Labelled = { label?: string; attributes?: Record<string, string> };
type RawEntry = Record<string, Labelled>;
type RawFeed = { entry?: RawEntry | RawEntry[]; link?: Labelled[] };

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

export function parseReviews(json: unknown): { reviews: Review[]; lastPage: number } {
  const feed = (json as { feed?: RawFeed }).feed;
  if (!feed) throw new Error("Unexpected reviews response: no feed");
  const raw = feed.entry === undefined ? [] : Array.isArray(feed.entry) ? feed.entry : [feed.entry];

  const reviews = raw
    // Some versions of the feed lead with an entry describing the app itself, with no rating.
    .filter((e) => e["im:rating"]?.label)
    .map((e) => ({
      id: e.id?.label ?? "",
      rating: Number(e["im:rating"]?.label),
      version: e["im:version"]?.label ?? "",
      date: e.updated?.label ? new Date(e.updated.label).toISOString().slice(0, 10) : "",
      title: oneLine(e.title?.label ?? ""),
      body: oneLine(e.content?.label ?? ""),
    }))
    .filter((r) => r.id);

  const last = feed.link?.find((l) => l.attributes?.rel === "last")?.attributes?.href ?? "";
  const lastPage = Number(last.match(/page=(\d+)/)?.[1] ?? 1);
  return { reviews, lastPage: Math.min(lastPage, MAX_PAGES) };
}

/** 1, 2 and 3 star reviews first (worst first), newest first within each rating. */
export function sortCriticalFirst(reviews: Review[]): Review[] {
  return [...reviews].sort((a, b) => a.rating - b.rating || b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
}

export const isCritical = (r: Review) => r.rating <= 3;

/**
 * New reviews for one app, newest first. Stops paging at the first review we already have,
 * so after the first run a daily scan costs one request per app.
 */
export async function fetchNewReviews(country: string, appId: string, known: Set<string>, pages = MAX_PAGES): Promise<Review[]> {
  const fresh: Review[] = [];
  let lastPage = 1;
  for (let page = 1; page <= Math.min(lastPage, pages); page++) {
    const result = parseReviews(await fetchJson(reviewsUrl(country, appId, page)));
    lastPage = result.lastPage;
    const unseen = result.reviews.filter((r) => !known.has(r.id));
    fresh.push(...unseen);
    if (unseen.length < result.reviews.length || !result.reviews.length) break;
    await sleep(300);
  }
  return fresh;
}

// What people complain about, by keyword. Crude on purpose: easy to read, easy to change.
export const THEMES: { name: string; pattern: RegExp }[] = [
  { name: "Price and subscription", pattern: /\b(subscri\w*|paywall\w*|pay|paid|paying|pric\w*|expensive|overpriced|charg\w*|refund\w*|trial|cancel\w*|money|premium|cost\w*|scam)\b/i },
  { name: "Bugs and crashes", pattern: /\b(crash\w*|bug\w*|buggy|glitch\w*|freez\w*|frozen|broken|error\w*|stuck|won'?t (load|open|work)|doesn'?t work|not working|stopped working)\b/i },
  { name: "Ads", pattern: /\b(ads|adverts?|advertis\w*|commercials?)\b/i },
  { name: "Login and account", pattern: /\b(log ?in|logged|sign ?in|sign ?up|account|password|verif\w*)\b/i },
  { name: "Sync and lost data", pattern: /\b(sync\w*|lost|deleted|disappear\w*|backup|wiped|gone)\b/i },
  { name: "Wrong or inaccurate", pattern: /\b(wrong|inaccura\w*|incorrect|accura\w*|mistakes?|made up)\b/i },
  { name: "Customer support", pattern: /\b(support|customer service|no response|never (heard|responded|replied)|contacted|emailed)\b/i },
  { name: "Missing features", pattern: /\b(wish|would be (nice|great)|please add|missing|lacks?|option to|ability to)\b/i },
];

export interface ThemeCount {
  name: string;
  count: number;
  /** Share of the critical reviews that mention this theme, 0 to 1. */
  share: number;
}

/** How many 1 to 3 star reviews mention each theme, most common first. */
export function complaintThemes(reviews: Review[]): { critical: number; themes: ThemeCount[] } {
  const critical = reviews.filter(isCritical);
  const themes = THEMES.map(({ name, pattern }) => {
    const count = critical.filter((r) => pattern.test(`${r.title} ${r.body}`)).length;
    return { name, count, share: critical.length ? count / critical.length : 0 };
  })
    .filter((t) => t.count > 0)
    .sort((a, b) => b.count - a.count);
  return { critical: critical.length, themes };
}
