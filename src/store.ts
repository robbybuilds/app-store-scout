// Snapshots live in plain CSV files so anyone can open them in a spreadsheet:
//   data/<country>/charts/YYYY-MM-DD.csv   one row per chart position
//   data/<country>/ratings/YYYY-MM-DD.csv  ratings count and average per app that day
//   data/<country>/apps.csv                latest details for every app ever seen (history is in git)
//   data/<country>/scans.csv               one line per scan: when it ran and how fresh Apple's feed was

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppDetails } from "./apple.ts";
import type { Chart } from "./config.ts";
import { parseCsv, toCsv } from "./csv.ts";

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

  /** The most recent `days` snapshots, oldest first. */
  recent(country: string, days: number): Snapshot[] {
    return this.dates(country).slice(-days).map((d) => this.readSnapshot(country, d));
  }
}
