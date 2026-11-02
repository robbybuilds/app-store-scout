// Snapshots live in plain CSV files so anyone can open them in a spreadsheet:
//   data/<country>/charts/YYYY-MM-DD.csv   one row per chart position
//   data/<country>/ratings/YYYY-MM-DD.csv  ratings count and average per app that day
//   data/<country>/apps.csv                latest details for every app ever seen (history is in git)
//   data/<country>/scans.csv               one line per scan: when it ran and how fresh Apple's feed was
//   data/<country>/reviews/<app-id>.csv    every review seen for the apps we research, 1 to 3 stars first
//   data/<country>/search.csv              one line per niche search per day: how crowded the search is
//   data/<country>/search/YYYY-MM-DD.csv   the top 10 App Store search results for each niche that day
//   data/<country>/volume.csv              monthly Google searches for each niche (seodata.dev)

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppDetails } from "./apple.ts";
import type { Chart } from "./config.ts";
import { parseCsv, toCsv } from "./csv.ts";
import { type Review, sortCriticalFirst } from "./reviews.ts";
import type { SearchRow, SearchSummary } from "./search.ts";
import type { Volume } from "./volume.ts";

export interface ChartRow {
  chart: Chart;
  genre_id: number;
  rank: number;
  app_id: string;
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
const SCAN_COLUMNS: (keyof ScanRow)[] = ["date", "scanned_at", "source_updated_at", "charts_ok", "charts_failed", "apps"];
const RATING_COLUMNS: (keyof RatingRow)[] = ["app_id", "rating_count", "average_rating"];
const REVIEW_COLUMNS: (keyof Review)[] = ["id", "rating", "version", "date", "title", "body"];
const SEARCH_SUMMARY_COLUMNS: (keyof SearchSummary)[] = ["date", "term", "results", "established", "new_apps", "top10_median_ratings"];
const SEARCH_COLUMNS: (keyof SearchRow)[] = ["date", "term", "position", "app_id", "name", "publisher", "rating_count", "released_at"];
const VOLUME_COLUMNS: (keyof Volume)[] = ["term", "keyword", "volume", "cpc", "competition", "similar", "checked_at"];
const APP_COLUMNS: (keyof AppDetails)[] = [
  "appId", "name", "publisher", "publisherId", "primaryGenre", "price",
  "ratingCount", "averageRating", "releasedAt", "updatedAt", "url",
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
    for (const app of apps) all.set(app.appId, app);
    const sorted = [...all.values()].sort((a, b) => a.appId.localeCompare(b.appId));
    writeFileSync(join(this.root, country, "apps.csv"), toCsv(APP_COLUMNS, sorted));

    const scansPath = join(this.root, country, "scans.csv");
    const scans = existsSync(scansPath)
      ? (parseCsv(readFileSync(scansPath, "utf8")) as unknown as ScanRow[]).filter((r) => r.date !== date)
      : [];
    writeFileSync(scansPath, toCsv(SCAN_COLUMNS, [...scans, scan]));
  }

  readApps(country: string): Map<string, AppDetails> {
    const path = join(this.root, country, "apps.csv");
    if (!existsSync(path)) return new Map();
    return new Map(
      parseCsv(readFileSync(path, "utf8")).map((r) => [
        r.appId,
        {
          appId: r.appId,
          name: r.name,
          publisher: r.publisher,
          publisherId: r.publisherId,
          primaryGenre: r.primaryGenre,
          price: Number(r.price),
          ratingCount: Number(r.ratingCount),
          averageRating: Number(r.averageRating),
          releasedAt: r.releasedAt,
          updatedAt: r.updatedAt,
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

    const ratingsPath = join(this.dir(country, "ratings"), `${date}.csv`);
    const ratings = new Map<string, RatingRow>();
    if (existsSync(ratingsPath)) {
      for (const r of parseCsv(readFileSync(ratingsPath, "utf8"))) {
        ratings.set(r.app_id, {
          app_id: r.app_id,
          rating_count: Number(r.rating_count),
          average_rating: Number(r.average_rating),
        });
      }
    }
    return { date, charts, ratings };
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

  /** The most recent `days` snapshots, oldest first. */
  recent(country: string, days: number): Snapshot[] {
    return this.dates(country).slice(-days).map((d) => this.readSnapshot(country, d));
  }
}
