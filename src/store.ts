// Snapshots live in plain CSV files so anyone can open them in a spreadsheet:
//   data/<country>/charts/YYYY-MM-DD.csv   one row per chart position
//   data/<country>/ratings/YYYY-MM-DD.csv  ratings count and average per app that day
//   data/<country>/apps.csv                latest details for every app ever seen (history is in git); ratings
//                                          live in ratings/, so this file only changes when an app does
//   data/<country>/new/YYYY-MM-DD.csv      apps in Apple's new-releases feeds that day (followed for 90 days)
//   data/<country>/niches/YYYY-MM-DD.csv   the niches researched that day and the apps in each
//   data/<country>/scans.csv               one line per scan: when it ran and how fresh Apple's feed was
//   data/<country>/reviews/<app-id>.csv    every review seen for the apps we research, 1 to 3 stars first
//   data/<country>/search.csv              one line per niche search per day: how crowded the search is
//   data/<country>/search/YYYY-MM-DD.csv   the top 10 App Store search results for each niche that day
//   data/<country>/volume.csv              monthly Google searches for each niche (seodata.dev)
//   data/<country>/publishers.csv          how many apps each researched publisher has, refreshed monthly
//   data/<country>/prices.csv              in-app purchase prices from researched apps' pages, refreshed weekly
//   data/<country>/pages.csv               star breakdown, privacy label and badges from those pages, weekly
//   data/<country>/versions.csv            every release seen on those pages (each check adds the latest 25)
//   data/<country>/similar.csv             the apps Apple suggests under "You Might Also Like", weekly
//   data/<country>/changes.csv             every listing change seen: names, prices, sellers, categories, purchases
//   data/<country>/removed.csv             charting apps that vanished from the App Store, and any that came back

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppDetails, NewFeed } from "./apple.ts";
import { type ChangeField, type ChangeRow, detailChanges } from "./changes.ts";
import type { Chart } from "./config.ts";
import { parseCsv, toCsv } from "./csv.ts";
import type { PageRow, SimilarRow, VersionRow } from "./pages.ts";
import type { PriceRow } from "./prices.ts";
import type { Publisher } from "./publishers.ts";
import type { RemovedRow } from "./removed.ts";
import { type Review, sortCriticalFirst } from "./reviews.ts";
import type { SearchRow, SearchSummary } from "./search.ts";
import type { Volume } from "./volume.ts";

export interface ChartRow {
  chart: Chart;
  genre_id: number;
  rank: number;
  app_id: string;
}

export interface NewAppRow {
  feed: NewFeed;
  position: number;
  app_id: string;
}

export interface NicheRow {
  term: string;
  app_id: string;
}

/** Every niche ever researched in a country, from the daily niche files. */
export interface NicheHistory {
  term: string;
  firstSeen: string;
  lastSeen: string;
  daysSeen: number;
  /** The apps in the niche on the last day it was seen. */
  appIds: string[];
}

export interface ScanRow {
  date: string;
  scanned_at: string;
  /** Apple's own "updated" time on the feed, so a stale feed can't pass as fresh data. */
  source_updated_at: string;
  charts_ok: number;
  charts_failed: number;
  apps: number;
}

export interface RatingRow {
  app_id: string;
  rating_count: number;
  average_rating: number;
}

export interface Snapshot {
  date: string;
  charts: ChartRow[];
  ratings: Map<string, RatingRow>;
}

const CHART_COLUMNS: (keyof ChartRow)[] = ["chart", "genre_id", "rank", "app_id"];
const NEW_APP_COLUMNS: (keyof NewAppRow)[] = ["feed", "position", "app_id"];
const NICHE_COLUMNS: (keyof NicheRow)[] = ["term", "app_id"];
const SCAN_COLUMNS: (keyof ScanRow)[] = ["date", "scanned_at", "source_updated_at", "charts_ok", "charts_failed", "apps"];
const RATING_COLUMNS: (keyof RatingRow)[] = ["app_id", "rating_count", "average_rating"];
const REVIEW_COLUMNS: (keyof Review)[] = ["id", "rating", "version", "date", "title", "body"];
const SEARCH_SUMMARY_COLUMNS: (keyof SearchSummary)[] = ["date", "term", "results", "established", "new_apps", "top10_median_ratings"];
const SEARCH_COLUMNS: (keyof SearchRow)[] = ["date", "term", "position", "app_id", "name", "publisher", "rating_count", "released_at"];
const VOLUME_COLUMNS: (keyof Volume)[] = ["term", "keyword", "volume", "cpc", "competition", "similar", "checked_at"];
const PUBLISHER_COLUMNS: (keyof Publisher)[] = ["publisher_id", "publisher", "apps", "total_ratings", "checked_at"];
const PRICE_COLUMNS: (keyof PriceRow)[] = ["app_id", "item", "price", "price_text", "period", "checked_at"];
const PAGE_COLUMNS: (keyof PageRow)[] = [
  "app_id", "stars_5", "stars_4", "stars_3", "stars_2", "stars_1", "editors_choice", "age_rating", "size_mb",
  "privacy", "tracking", "checked_at",
];
const VERSION_COLUMNS: (keyof VersionRow)[] = ["app_id", "version", "date"];
const SIMILAR_COLUMNS: (keyof SimilarRow)[] = ["app_id", "position", "similar_id", "name", "developer", "checked_at"];
const CHANGE_COLUMNS: (keyof ChangeRow)[] = ["date", "app_id", "field", "from", "to"];
const REMOVED_COLUMNS: (keyof RemovedRow)[] = [
  "app_id", "name", "publisher", "genre", "best_chart", "best_genre_id", "best_rank",
  "last_charted", "missing_since", "confirmed_on", "returned_on",
];
// No ratings here: they change daily for almost every app, which would rewrite the whole file
// (and grow the repo) every day. They're in ratings/<date>.csv and joined back in by readApps.
const APP_COLUMNS: (keyof AppDetails)[] = [
  "appId", "name", "publisher", "publisherId", "seller", "primaryGenre", "price",
  "releasedAt", "updatedAt", "version", "languages", "url",
];

export class Store {
  private root: string;

  constructor(root = "data") {
    this.root = root;
  }

  private dir(country: string, kind: string): string {
    return join(this.root, country, kind);
  }

  writeSnapshot(country: string, scan: ScanRow, charts: ChartRow[], apps: AppDetails[]): void {
    const date = scan.date;
    for (const kind of ["charts", "ratings"]) mkdirSync(this.dir(country, kind), { recursive: true });

    writeFileSync(join(this.dir(country, "charts"), `${date}.csv`), toCsv(CHART_COLUMNS, charts));

    const ratings = apps
      .map((a) => ({ app_id: a.appId, rating_count: a.ratingCount, average_rating: a.averageRating }))
      .sort((a, b) => a.app_id.localeCompare(b.app_id));
    writeFileSync(join(this.dir(country, "ratings"), `${date}.csv`), toCsv(RATING_COLUMNS, ratings));

    const all = this.readApps(country);
    // Compare with what was saved before overwriting it: that's the only moment the old listing is known.
    this.addChanges(country, apps.flatMap((app) => detailChanges(date, all.get(app.appId), app)));
    for (const app of apps) all.set(app.appId, app);
    const sorted = [...all.values()].sort((a, b) => a.appId.localeCompare(b.appId));
    writeFileSync(join(this.root, country, "apps.csv"), toCsv(APP_COLUMNS, sorted));

    const scansPath = join(this.root, country, "scans.csv");
    const scans = existsSync(scansPath)
      ? (parseCsv(readFileSync(scansPath, "utf8")) as unknown as ScanRow[]).filter((r) => r.date !== date)
      : [];
    writeFileSync(scansPath, toCsv(SCAN_COLUMNS, [...scans, scan]));
  }

  writeNewApps(country: string, date: string, rows: NewAppRow[]): void {
    mkdirSync(this.dir(country, "new"), { recursive: true });
    writeFileSync(join(this.dir(country, "new"), `${date}.csv`), toCsv(NEW_APP_COLUMNS, rows));
  }

  writeNiches(country: string, date: string, rows: NicheRow[]): void {
    mkdirSync(this.dir(country, "niches"), { recursive: true });
    writeFileSync(join(this.dir(country, "niches"), `${date}.csv`), toCsv(NICHE_COLUMNS, rows));
  }

  /** Every niche researched so far, most recently seen first. */
  nicheHistory(country: string): NicheHistory[] {
    const dir = this.dir(country, "niches");
    const out = new Map<string, NicheHistory>();
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.csv$/.test(f)).sort();
    for (const file of files) {
      const date = file.slice(0, 10);
      const byTerm = new Map<string, string[]>();
      for (const r of parseCsv(readFileSync(join(dir, file), "utf8"))) byTerm.set(r.term, [...(byTerm.get(r.term) ?? []), r.app_id]);
      for (const [term, appIds] of byTerm) {
        const h = out.get(term) ?? { term, firstSeen: date, lastSeen: date, daysSeen: 0, appIds };
        h.lastSeen = date;
        h.daysSeen++;
        h.appIds = appIds;
        out.set(term, h);
      }
    }
    return [...out.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen) || b.daysSeen - a.daysSeen);
  }

  /** Apps seen in a new-releases feed on or after `since`, with the first day each was seen. */
  newAppsSince(country: string, since: string): Map<string, string> {
    const dir = this.dir(country, "new");
    const firstSeen = new Map<string, string>();
    if (!existsSync(dir)) return firstSeen;
    const dates = readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.csv$/.test(f) && f.slice(0, 10) >= since)
      .sort();
    for (const file of dates) {
      for (const r of parseCsv(readFileSync(join(dir, file), "utf8"))) {
        if (!firstSeen.has(r.app_id)) firstSeen.set(r.app_id, file.slice(0, 10));
      }
    }
    return firstSeen;
  }

  /** Every app ever seen, with ratings from the latest snapshot that has them. */
  readApps(country: string): Map<string, AppDetails> {
    const path = join(this.root, country, "apps.csv");
    if (!existsSync(path)) return new Map();
    const latest = this.dates(country).at(-1);
    const ratings = latest ? this.readRatings(country, latest) : new Map<string, RatingRow>();
    return new Map(
      parseCsv(readFileSync(path, "utf8")).map((r) => [
        r.appId,
        {
          appId: r.appId,
          name: r.name,
          publisher: r.publisher,
          publisherId: r.publisherId,
          // Apps saved before these columns existed fill them in on their next scan.
          seller: r.seller ?? "",
          primaryGenre: r.primaryGenre,
          price: Number(r.price),
          // apps.csv files from before ratings moved out still carry them; use those as a fallback.
          ratingCount: ratings.get(r.appId)?.rating_count ?? Number(r.ratingCount ?? 0),
          averageRating: ratings.get(r.appId)?.average_rating ?? Number(r.averageRating ?? 0),
          releasedAt: r.releasedAt,
          updatedAt: r.updatedAt,
          version: r.version ?? "",
          languages: Number(r.languages ?? 0),
          url: r.url,
        },
      ]),
    );
  }

  /** Dates with a chart snapshot, oldest first. */
  dates(country: string): string[] {
    const dir = this.dir(country, "charts");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.csv$/.test(f))
      .map((f) => f.slice(0, 10))
      .sort();
  }

  readSnapshot(country: string, date: string): Snapshot {
    const charts = parseCsv(readFileSync(join(this.dir(country, "charts"), `${date}.csv`), "utf8")).map((r) => ({
      chart: r.chart as Chart,
      genre_id: Number(r.genre_id),
      rank: Number(r.rank),
      app_id: r.app_id,
    }));

    return { date, charts, ratings: this.readRatings(country, date) };
  }

  readRatings(country: string, date: string): Map<string, RatingRow> {
    const path = join(this.dir(country, "ratings"), `${date}.csv`);
    const ratings = new Map<string, RatingRow>();
    if (!existsSync(path)) return ratings;
    for (const r of parseCsv(readFileSync(path, "utf8"))) {
      ratings.set(r.app_id, {
        app_id: r.app_id,
        rating_count: Number(r.rating_count),
        average_rating: Number(r.average_rating),
      });
    }
    return ratings;
  }

  readReviews(country: string, appId: string): Review[] {
    const path = join(this.dir(country, "reviews"), `${appId}.csv`);
    if (!existsSync(path)) return [];
    return parseCsv(readFileSync(path, "utf8")).map((r) => ({
      id: r.id,
      rating: Number(r.rating),
      version: r.version,
      date: r.date,
      title: r.title,
      body: r.body,
    }));
  }

  /** Merges new reviews into the app's file, keeping 1 to 3 star reviews at the top. */
  addReviews(country: string, appId: string, reviews: Review[]): void {
    const all = new Map(this.readReviews(country, appId).map((r) => [r.id, r]));
    for (const r of reviews) all.set(r.id, r);
    mkdirSync(this.dir(country, "reviews"), { recursive: true });
    writeFileSync(join(this.dir(country, "reviews"), `${appId}.csv`), toCsv(REVIEW_COLUMNS, sortCriticalFirst([...all.values()])));
  }

  writeSearch(country: string, date: string, summaries: SearchSummary[], rows: SearchRow[]): void {
    mkdirSync(this.dir(country, "search"), { recursive: true });
    writeFileSync(join(this.dir(country, "search"), `${date}.csv`), toCsv(SEARCH_COLUMNS, rows));
    const path = join(this.root, country, "search.csv");
    const earlier = existsSync(path)
      ? (parseCsv(readFileSync(path, "utf8")) as unknown as SearchSummary[]).filter((r) => r.date !== date)
      : [];
    writeFileSync(path, toCsv(SEARCH_SUMMARY_COLUMNS, [...earlier, ...summaries]));
  }

  /** The latest day's niche searches, keyed by term. */
  readSearch(country: string): Map<string, { summary: SearchSummary; top: SearchRow[] }> {
    const path = join(this.root, country, "search.csv");
    if (!existsSync(path)) return new Map();
    const all = parseCsv(readFileSync(path, "utf8"));
    const date = all.reduce((max, r) => (r.date > max ? r.date : max), "");
    const topPath = join(this.dir(country, "search"), `${date}.csv`);
    const top = existsSync(topPath) ? parseCsv(readFileSync(topPath, "utf8")) : [];
    const out = new Map<string, { summary: SearchSummary; top: SearchRow[] }>();
    for (const r of all.filter((r) => r.date === date)) {
      out.set(r.term, {
        summary: {
          date: r.date,
          term: r.term,
          results: Number(r.results),
          established: Number(r.established),
          new_apps: Number(r.new_apps),
          top10_median_ratings: Number(r.top10_median_ratings),
        },
        top: top
          .filter((t) => t.term === r.term)
          .map((t) => ({
            date: t.date,
            term: t.term,
            position: Number(t.position),
            app_id: t.app_id,
            name: t.name,
            publisher: t.publisher,
            rating_count: Number(t.rating_count),
            released_at: t.released_at,
          })),
      });
    }
    return out;
  }

  readVolumes(country: string): Map<string, Volume> {
    const path = join(this.root, country, "volume.csv");
    if (!existsSync(path)) return new Map();
    return new Map(
      parseCsv(readFileSync(path, "utf8")).map((r) => [
        r.term,
        {
          term: r.term,
          keyword: r.keyword,
          volume: Number(r.volume),
          cpc: Number(r.cpc),
          competition: Number(r.competition),
          similar: r.similar,
          checked_at: r.checked_at,
        },
      ]),
    );
  }

  writeVolumes(country: string, volumes: Map<string, Volume>): void {
    const sorted = [...volumes.values()].sort((a, b) => a.term.localeCompare(b.term));
    writeFileSync(join(this.root, country, "volume.csv"), toCsv(VOLUME_COLUMNS, sorted));
  }

  readPublishers(country: string): Map<string, Publisher> {
    const path = join(this.root, country, "publishers.csv");
    if (!existsSync(path)) return new Map();
    return new Map(
      parseCsv(readFileSync(path, "utf8")).map((r) => [
        r.publisher_id,
        {
          publisher_id: r.publisher_id,
          publisher: r.publisher,
          apps: Number(r.apps),
          total_ratings: Number(r.total_ratings),
          checked_at: r.checked_at,
        },
      ]),
    );
  }

  writePublishers(country: string, publishers: Map<string, Publisher>): void {
    const sorted = [...publishers.values()].sort((a, b) => a.publisher_id.localeCompare(b.publisher_id));
    writeFileSync(join(this.root, country, "publishers.csv"), toCsv(PUBLISHER_COLUMNS, sorted));
  }

  /** Every price row, grouped by app. An app checked and found to sell nothing has one row with no item. */
  readPrices(country: string): Map<string, PriceRow[]> {
    const path = join(this.root, country, "prices.csv");
    const out = new Map<string, PriceRow[]>();
    if (!existsSync(path)) return out;
    for (const r of parseCsv(readFileSync(path, "utf8"))) {
      const rows = out.get(r.app_id) ?? [];
      rows.push({
        app_id: r.app_id,
        item: r.item,
        price: r.price === "" ? null : Number(r.price),
        price_text: r.price_text,
        period: r.period as PriceRow["period"],
        checked_at: r.checked_at,
      });
      out.set(r.app_id, rows);
    }
    return out;
  }

  writePrices(country: string, prices: Map<string, PriceRow[]>): void {
    const sorted = [...prices.keys()].sort().flatMap((id) => prices.get(id)!);
    writeFileSync(join(this.root, country, "prices.csv"), toCsv(PRICE_COLUMNS, sorted));
  }

  readPages(country: string): Map<string, PageRow> {
    const path = join(this.root, country, "pages.csv");
    if (!existsSync(path)) return new Map();
    return new Map(
      parseCsv(readFileSync(path, "utf8")).map((r) => [
        r.app_id,
        {
          app_id: r.app_id,
          stars_5: Number(r.stars_5),
          stars_4: Number(r.stars_4),
          stars_3: Number(r.stars_3),
          stars_2: Number(r.stars_2),
          stars_1: Number(r.stars_1),
          editors_choice: r.editors_choice === "true",
          age_rating: r.age_rating,
          size_mb: r.size_mb === "" ? null : Number(r.size_mb),
          privacy: r.privacy as PageRow["privacy"],
          tracking: r.tracking,
          checked_at: r.checked_at,
        },
      ]),
    );
  }

  writePages(country: string, pages: Map<string, PageRow>): void {
    const sorted = [...pages.keys()].sort().map((id) => pages.get(id)!);
    writeFileSync(join(this.root, country, "pages.csv"), toCsv(PAGE_COLUMNS, sorted));
  }

  /** Every release seen, grouped by app, newest first. */
  readVersions(country: string): Map<string, VersionRow[]> {
    const path = join(this.root, country, "versions.csv");
    const out = new Map<string, VersionRow[]>();
    if (!existsSync(path)) return out;
    for (const r of parseCsv(readFileSync(path, "utf8"))) {
      const rows = out.get(r.app_id) ?? [];
      rows.push({ app_id: r.app_id, version: r.version, date: r.date });
      out.set(r.app_id, rows);
    }
    return out;
  }

  writeVersions(country: string, versions: Map<string, VersionRow[]>): void {
    const sorted = [...versions.keys()].sort().flatMap((id) => versions.get(id)!);
    writeFileSync(join(this.root, country, "versions.csv"), toCsv(VERSION_COLUMNS, sorted));
  }

  readSimilar(country: string): Map<string, SimilarRow[]> {
    const path = join(this.root, country, "similar.csv");
    const out = new Map<string, SimilarRow[]>();
    if (!existsSync(path)) return out;
    for (const r of parseCsv(readFileSync(path, "utf8"))) {
      const rows = out.get(r.app_id) ?? [];
      rows.push({ ...r, position: Number(r.position) } as SimilarRow);
      out.set(r.app_id, rows);
    }
    return out;
  }

  writeSimilar(country: string, similar: Map<string, SimilarRow[]>): void {
    const sorted = [...similar.keys()].sort().flatMap((id) => similar.get(id)!);
    writeFileSync(join(this.root, country, "similar.csv"), toCsv(SIMILAR_COLUMNS, sorted));
  }

  /** Every listing change seen, oldest first. */
  readChanges(country: string): ChangeRow[] {
    const path = join(this.root, country, "changes.csv");
    if (!existsSync(path)) return [];
    return parseCsv(readFileSync(path, "utf8")).map((r) => ({
      date: r.date, app_id: r.app_id, field: r.field as ChangeField, from: r.from, to: r.to,
    }));
  }

  /** Adds changes to the log, skipping any it already has (a scan can run twice in a day). */
  addChanges(country: string, rows: ChangeRow[]): void {
    if (!rows.length) return;
    const all = this.readChanges(country);
    const id = (r: ChangeRow) => [r.date, r.app_id, r.field, r.from, r.to].join("\u0000");
    const have = new Set(all.map(id));
    const fresh = rows.filter((r) => !have.has(id(r)));
    if (!fresh.length) return;
    mkdirSync(join(this.root, country), { recursive: true });
    const sorted = [...all, ...fresh].sort((a, b) => a.date.localeCompare(b.date) || a.app_id.localeCompare(b.app_id) || a.field.localeCompare(b.field));
    writeFileSync(join(this.root, country, "changes.csv"), toCsv(CHANGE_COLUMNS, sorted));
  }

  readRemoved(country: string): RemovedRow[] {
    const path = join(this.root, country, "removed.csv");
    if (!existsSync(path)) return [];
    return parseCsv(readFileSync(path, "utf8")).map((r) => ({
      app_id: r.app_id, name: r.name, publisher: r.publisher, genre: r.genre,
      best_chart: r.best_chart as RemovedRow["best_chart"], best_genre_id: Number(r.best_genre_id), best_rank: Number(r.best_rank),
      last_charted: r.last_charted, missing_since: r.missing_since, confirmed_on: r.confirmed_on, returned_on: r.returned_on,
    }));
  }

  writeRemoved(country: string, rows: RemovedRow[]): void {
    mkdirSync(join(this.root, country), { recursive: true });
    writeFileSync(join(this.root, country, "removed.csv"), toCsv(REMOVED_COLUMNS, rows));
  }

  /** The most recent `days` snapshots, oldest first. */
  recent(country: string, days: number): Snapshot[] {
    return this.dates(country).slice(-days).map((d) => this.readSnapshot(country, d));
  }
}
