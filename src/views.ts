// One country's data loaded once, and the plain objects the JSON API and the MCP server both
// return. Keeping them here means an agent asking the MCP server and a script reading the API
// get the same answer, with the same field names.

import type { AppDetails } from "./apple.ts";
import { type ChangeRow, describeChange, recentChanges } from "./changes.ts";
import { type Chart, type Config, genreName } from "./config.ts";
import { chartMovers, type Mover, type Movers } from "./movers.ts";
import { lowStarShare, releasesWithin, totalStars } from "./pages.ts";
import { pricingSummary } from "./prices.ts";
import { looksLikeIndividual } from "./publishers.ts";
import { confirmedRemovals } from "./removed.ts";
import { complaintThemes, isCritical } from "./reviews.ts";
import {
  type AppSignal,
  type Cluster,
  computeSignals,
  daysBetween,
  neglectedEarners,
  newAndPaying,
  researchTargets,
  smallAndPaying,
  soloAndPaying,
} from "./signals.ts";
import type { Snapshot, Store } from "./store.ts";

export interface CountryData {
  country: string;
  snapshots: Snapshot[];
  date: string;
  signals: AppSignal[];
  bySignal: Map<string, AppSignal>;
  apps: Map<string, AppDetails>;
  niches: Cluster[];
  /** What moved on the top-grossing charts since the previous scan. */
  movers: Movers;
}

export function countryData(store: Store, config: Config, country: string): CountryData | null {
  const snapshots = store.recent(country, 30);
  const latest = snapshots.at(-1);
  if (!latest) return null;
  const apps = store.readApps(country);
  const signals = computeSignals(snapshots, apps);
  return {
    country,
    snapshots,
    date: latest.date,
    signals,
    bySignal: new Map(signals.map((s) => [s.appId, s])),
    apps,
    niches: researchTargets(signals, config).niches,
    movers: chartMovers(snapshots, "top-grossing"),
  };
}

/** A signal for an app that may have left the charts since, so older niches still have rows. */
export function signalOf(d: CountryData, id: string): AppSignal | null {
  const charted = d.bySignal.get(id);
  if (charted) return charted;
  const details = d.apps.get(id);
  if (!details) return null;
  return {
    appId: id, details, grossing: null, best: null, grossingRankChange7: null, daysOnChart: 0, windowDays: 0,
    ratingCount: details.ratingCount ?? null, ratingDelta7: null,
    ageDays: details.releasedAt ? daysBetween(details.releasedAt.slice(0, 10), d.date) : null,
  };
}

export const appStoreUrl = (country: string, id: string) => `https://apps.apple.com/${country}/app/id${id}`;

export interface AppBrief {
  id: string;
  name: string;
  publisher: string;
  category: string;
  ratings: number | null;
  released: string;
  /** Best top-grossing place today, or null when it's on no grossing chart. */
  top_grossing: { rank: number; chart: string } | null;
  url: string;
}

export function appBrief(d: CountryData, config: Config, id: string): AppBrief {
  const s = signalOf(d, id);
  return {
    id,
    name: s?.details?.name ?? "",
    publisher: s?.details?.publisher ?? "",
    category: s?.details?.primaryGenre ?? "",
    ratings: s?.ratingCount ?? null,
    released: s?.details?.releasedAt?.slice(0, 10) ?? "",
    top_grossing: s?.grossing ? { rank: s.grossing.rank, chart: genreName(config, s.grossing.genreId) } : null,
    url: appStoreUrl(d.country, id),
  };
}

const NOTE = "Ranks, ratings and prices are observed from Apple's public feeds. They are not downloads or revenue.";

export function nichesView(d: CountryData, config: Config) {
  return {
    country: d.country,
    date: d.date,
    note: "A niche is a phrase shared by new or small apps from 3+ publishers, all on a top-grossing chart today.",
    niches: d.niches.map((c) => ({
      term: c.term,
      publishers: c.publishers,
      related: c.related,
      apps: c.apps.map((s) => appBrief(d, config, s.appId)),
    })),
  };
}

/** Everything Scout knows about one niche: its apps, the search, prices and complaints. */
export function nicheView(store: Store, config: Config, d: CountryData, term: string) {
  const wanted = term.trim().toLowerCase();
  const today = d.niches.find((c) => c.term === wanted || c.related.includes(wanted));
  const past = today ? undefined : store.nicheHistory(d.country).find((h) => h.term === wanted);
  const ids = today ? today.apps.map((s) => s.appId) : past?.appIds ?? [];
  if (!ids.length) return null;
  const prices = store.readPrices(d.country);
  const pages = store.readPages(d.country);
  const search = store.readSearch(d.country).get(today?.term ?? wanted);
  const volume = store.readVolumes(d.country).get(today?.term ?? wanted);
  const reviews = ids.flatMap((id) => store.readReviews(d.country, id).map((r) => ({ ...r, app: d.apps.get(id)?.name ?? id })));
  const { critical, themes } = complaintThemes(reviews);
  const pricing = pricingSummary(ids.map((id) => prices.get(id) ?? []));
  const shares = ids.map((id) => pages.get(id)).map((p) => (p ? lowStarShare(p) : null)).filter((v): v is number => v !== null).sort((a, b) => a - b);
  const sellers = ids.map((id) => d.apps.get(id)).filter((a): a is AppDetails => !!a);
  return {
    country: d.country,
    date: d.date,
    term: today?.term ?? wanted,
    live_today: !!today,
    last_seen: today ? d.date : past!.lastSeen,
    publishers: new Set(sellers.map((a) => a.publisherId)).size,
    apps: ids.map((id) => appBrief(d, config, id)),
    likely_solo_developers: sellers.filter((a) => a.seller && looksLikeIndividual(a.seller, a.name)).length,
    app_store_search: search
      ? {
          results: search.summary.results,
          results_capped_at: 200,
          with_10000_plus_ratings: search.summary.established,
          released_in_last_year: search.summary.new_apps,
          top10_median_ratings: search.summary.top10_median_ratings,
          top: search.top.map((t) => ({ position: t.position, id: t.app_id, name: t.name, ratings: t.rating_count })),
        }
      : null,
    google_search: volume ? { keyword: volume.keyword, monthly_searches: volume.volume, cost_per_click_usd: volume.cpc, source: "seodata.dev", checked: volume.checked_at } : null,
    pricing: {
      apps_checked: pricing.checked,
      apps_with_purchases: pricing.selling,
      plans: pricing.periods.map((p) => ({ period: p.period, apps: p.apps, median: p.median, min: p.min, max: p.max, shown_as: p.sample })),
    },
    median_share_of_1_and_2_star_ratings: shares.length ? Math.round(shares[Math.floor(shares.length / 2)] * 1000) / 1000 : null,
    complaints: {
      reviews_with_1_to_3_stars: critical,
      themes: themes.map((t) => ({ theme: t.name, share: Math.round(t.share * 1000) / 1000 })),
      examples: reviews.filter(isCritical).filter((r) => r.title).sort((a, b) => a.rating - b.rating || b.date.localeCompare(a.date)).slice(0, 10)
        .map((r) => ({ stars: r.rating, date: r.date, app: r.app, title: r.title, text: r.body.slice(0, 400) })),
    },
    note: NOTE,
  };
}

function moverView(d: CountryData, config: Config, m: Mover) {
  const brief = appBrief(d, config, m.appId);
  return {
    id: m.appId, name: brief.name, publisher: brief.publisher, category: brief.category, ratings: brief.ratings, released: brief.released,
    chart: genreName(config, m.genreId), rank: m.rank, previous_rank: m.previous, places_gained: m.change,
    ...(m.debut === undefined ? {} : { first_time_on_a_grossing_chart: m.debut }),
    url: brief.url,
  };
}

export function moversView(d: CountryData, config: Config, limit = 50) {
  const list = (rows: Mover[]) => rows.slice(0, limit).map((m) => moverView(d, config, m));
  return {
    country: d.country,
    chart: "top-grossing",
    date: d.date,
    compared_with: d.movers.previousDate,
    climbers: list(d.movers.climbers),
    fallers: list(d.movers.fallers),
    arrivals: list(d.movers.arrivals),
    exits: list(d.movers.exits),
    first_time_number_ones: list(d.movers.firstNumberOnes),
    note: "A rank change means an app out-earned different neighbours on that chart than the day before. It is not a revenue figure.",
  };
}

export function listsView(d: CountryData, config: Config, limit = 100) {
  const list = (rows: AppSignal[]) => rows.slice(0, limit).map((s) => appBrief(d, config, s.appId));
  return {
    country: d.country,
    date: d.date,
    small_and_paying: list(smallAndPaying(d.signals, config)),
    new_and_paying: list(newAndPaying(d.signals, config)),
    likely_solo_developers: list(soloAndPaying(d.signals)),
    earning_without_updates: list(neglectedEarners(d.signals, d.date)),
    definitions: {
      small_and_paying: `On a top-grossing chart with fewer than ${config.report.smallAppMaxRatings} ratings.`,
      new_and_paying: `Released in the last ${config.report.newAppMaxAgeDays} days and on a top-grossing chart.`,
      likely_solo_developers: "On a top-grossing chart and sold under a person's own name. A guess from the seller's name.",
      earning_without_updates: "On a top-grossing chart but not updated in over a year.",
    },
  };
}

const sinceDate = (date: string, days: number) => new Date(Date.parse(date) - days * 86_400_000).toISOString().slice(0, 10);

function changeView(d: CountryData, config: Config, c: ChangeRow) {
  const brief = appBrief(d, config, c.app_id);
  return { date: c.date, id: c.app_id, name: brief.name, publisher: brief.publisher, top_grossing: brief.top_grossing, field: c.field, from: c.from, to: c.to, summary: describeChange(c), url: brief.url };
}

/** Listing changes in the last `days`, apps on a grossing chart first within each day. */
export function changesView(store: Store, config: Config, d: CountryData, days = 30, limit = 500) {
  const rows = recentChanges(store.readChanges(d.country), sinceDate(d.date, days))
    .map((c) => changeView(d, config, c))
    .sort((a, b) => b.date.localeCompare(a.date) || (a.top_grossing?.rank ?? 999) - (b.top_grossing?.rank ?? 999));
  return {
    country: d.country,
    date: d.date,
    days,
    total: rows.length,
    changes: rows.slice(0, limit),
    note: "The date is the scan that first saw the change. Names, prices, sellers and categories are checked daily for every charting app; in-app purchases weekly for researched apps.",
  };
}

export function removedView(store: Store, config: Config, country: string) {
  const rows = confirmedRemovals(store.readRemoved(country));
  return {
    country,
    still_gone: rows.filter((r) => !r.returned_on).length,
    came_back: rows.filter((r) => r.returned_on).length,
    apps: rows.map((r) => ({
      id: r.app_id, name: r.name, publisher: r.publisher, category: r.genre,
      best_place: r.best_chart ? { chart: `${r.best_chart}, ${genreName(config, r.best_genre_id)}`, rank: r.best_rank } : null,
      last_on_a_chart: r.last_charted, found_missing: r.missing_since, confirmed: r.confirmed_on, came_back: r.returned_on || null,
    })),
    note: "Removed means Apple's Lookup API stopped returning the app in this country on two scans. The date is when Scout noticed, and Scout can't tell whether Apple or the developer removed it.",
  };
}

export function chartView(d: CountryData, config: Config, chart: Chart, genreId?: number) {
  const latest = d.snapshots.at(-1)!;
  const rows = latest.charts
    .filter((r) => r.chart === chart && (genreId === undefined || r.genre_id === genreId))
    .sort((a, b) => a.genre_id - b.genre_id || a.rank - b.rank);
  return {
    country: d.country,
    date: d.date,
    chart,
    rows: rows.map((r) => {
      const a = d.apps.get(r.app_id);
      return { category: genreName(config, r.genre_id), rank: r.rank, id: r.app_id, name: a?.name ?? "", publisher: a?.publisher ?? "", ratings: latest.ratings.get(r.app_id)?.rating_count ?? null, released: a?.releasedAt?.slice(0, 10) ?? "" };
    }),
  };
}

/** One app: today's places, its history in the saved window, and whatever research exists for it. */
export function appView(store: Store, config: Config, d: CountryData, id: string) {
  const s = signalOf(d, id);
  const details = s?.details;
  if (!s || !details) return null;
  const latest = d.snapshots.at(-1)!;
  const page = store.readPages(d.country).get(id);
  const purchases = (store.readPrices(d.country).get(id) ?? []).filter((r) => r.item);
  const versions = store.readVersions(d.country).get(id) ?? [];
  const similar = store.readSimilar(d.country).get(id) ?? [];
  const reviews = store.readReviews(d.country, id);
  const { critical, themes } = complaintThemes(reviews);
  const changes = store.readChanges(d.country).filter((c) => c.app_id === id).sort((a, b) => b.date.localeCompare(a.date));
  return {
    country: d.country,
    date: d.date,
    id,
    name: details.name,
    publisher: details.publisher,
    seller: details.seller,
    likely_solo_developer: !!details.seller && looksLikeIndividual(details.seller, details.name),
    category: details.primaryGenre,
    price: details.price,
    released: details.releasedAt,
    last_updated: details.updatedAt,
    version: details.version,
    languages: details.languages,
    ratings: s.ratingCount,
    average_rating: details.averageRating,
    url: appStoreUrl(d.country, id),
    places_today: latest.charts.filter((r) => r.app_id === id).sort((a, b) => a.rank - b.rank).map((r) => ({ chart: r.chart, category: genreName(config, r.genre_id), rank: r.rank })),
    history: d.snapshots.map((snap) => {
      const best = snap.charts.filter((r) => r.app_id === id && r.chart === "top-grossing").sort((a, b) => a.rank - b.rank)[0];
      return { date: snap.date, top_grossing: best ? { rank: best.rank, chart: genreName(config, best.genre_id) } : null, ratings: snap.ratings.get(id)?.rating_count ?? null };
    }),
    listing_changes: changes.map((c) => ({ date: c.date, field: c.field, from: c.from, to: c.to, summary: describeChange(c) })),
    in_app_purchases: purchases.map((r) => ({ item: r.item, price: r.price, shown_as: r.price_text, period: r.period, checked: r.checked_at })),
    stars: page && totalStars(page) > 0 ? { 5: page.stars_5, 4: page.stars_4, 3: page.stars_3, 2: page.stars_2, 1: page.stars_1 } : null,
    privacy_label: page?.privacy || null,
    tracking: page?.tracking ? page.tracking.split(";") : [],
    releases: { in_last_90_days: releasesWithin(versions, d.date), seen: versions.slice(0, 25) .map((v) => ({ version: v.version, date: v.date })) },
    apple_also_suggests: similar.map((x) => ({ id: x.similar_id, name: x.name, developer: x.developer })),
    complaints: reviews.length
      ? {
          reviews_read: reviews.length,
          reviews_with_1_to_3_stars: critical,
          themes: themes.map((t) => ({ theme: t.name, share: Math.round(t.share * 1000) / 1000 })),
          examples: reviews.filter(isCritical).slice(0, 10).map((r) => ({ stars: r.rating, date: r.date, version: r.version, title: r.title, text: r.body.slice(0, 400) })),
        }
      : null,
    researched: !!page,
    note: NOTE,
  };
}

export interface SearchOptions {
  grossingOnly?: boolean;
  smallOnly?: boolean;
  newOnly?: boolean;
  limit?: number;
}

/** Apps on today's charts whose name, publisher or category has every word of the query. */
export function searchView(d: CountryData, config: Config, query: string, opts: SearchOptions = {}) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = d.signals.filter((s) => {
    if (!s.details) return false;
    if (opts.grossingOnly && !s.grossing) return false;
    if (opts.smallOnly && !(s.ratingCount !== null && s.ratingCount < config.report.smallAppMaxRatings)) return false;
    if (opts.newOnly && !(s.ageDays !== null && s.ageDays <= config.report.newAppMaxAgeDays)) return false;
    const text = `${s.details.name} ${s.details.publisher} ${s.details.primaryGenre}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
  hits.sort((a, b) => (a.grossing?.rank ?? 999) - (b.grossing?.rank ?? 999) || (b.ratingCount ?? 0) - (a.ratingCount ?? 0));
  return {
    country: d.country,
    date: d.date,
    query,
    total: hits.length,
    on_a_grossing_chart: hits.filter((s) => s.grossing).length,
    publishers: new Set(hits.map((s) => s.details!.publisherId)).size,
    apps: hits.slice(0, opts.limit ?? 50).map((s) => appBrief(d, config, s.appId)),
    note: "Only apps on today's tracked charts (top 100 per category), not the whole App Store.",
  };
}
