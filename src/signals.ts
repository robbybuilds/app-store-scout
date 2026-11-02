// Turns raw snapshots into research signals. Everything here is pure so it can be tested
// with made-up snapshots. These are observations (rank, ratings, dates), never revenue.

import type { AppDetails } from "./apple.ts";
import type { Chart, Config } from "./config.ts";
import type { ChartRow, Snapshot } from "./store.ts";

export interface Position {
  chart: Chart;
  genreId: number;
  rank: number;
}

export interface AppSignal {
  appId: string;
  details: AppDetails | undefined;
  /** Best top-grossing position today (genre charts win ties). */
  grossing: Position | null;
  /** Best position on any chart today. */
  best: Position | null;
  /** Places gained on the same grossing chart over 7 days; null if not comparable. */
  grossingRankChange7: number | null;
  /** Snapshots in the window where the app was on any chart. */
  daysOnChart: number;
  windowDays: number;
  ratingCount: number | null;
  ratingDelta7: number | null;
  ageDays: number | null;
}

export interface GenreSummary {
  genreId: number;
  grossingApps: number;
  newApps: number;
  smallApps: number;
  medianRatings: number | null;
}

const DAY = 86_400_000;

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / DAY);
}

/** The latest snapshot at least `days` before the last one. */
export function snapshotDaysAgo(snapshots: Snapshot[], days: number): Snapshot | null {
  const latest = snapshots.at(-1);
  if (!latest) return null;
  for (let i = snapshots.length - 2; i >= 0; i--) {
    if (daysBetween(snapshots[i].date, latest.date) >= days) return snapshots[i];
  }
  return null;
}

function bestPosition(rows: ChartRow[]): Position | null {
  let best: ChartRow | null = null;
  for (const row of rows) {
    if (!best || row.rank < best.rank || (row.rank === best.rank && best.genre_id === 0 && row.genre_id !== 0)) {
      best = row;
    }
  }
  return best ? { chart: best.chart, genreId: best.genre_id, rank: best.rank } : null;
}

export function computeSignals(snapshots: Snapshot[], apps: Map<string, AppDetails>): AppSignal[] {
  const latest = snapshots.at(-1);
  if (!latest) return [];
  const weekAgo = snapshotDaysAgo(snapshots, 7);

  const rowsByApp = new Map<string, ChartRow[]>();
  for (const row of latest.charts) {
    const rows = rowsByApp.get(row.app_id) ?? [];
    rows.push(row);
    rowsByApp.set(row.app_id, rows);
  }

  const seen = new Map<string, number>();
  for (const snap of snapshots) {
    for (const id of new Set(snap.charts.map((r) => r.app_id))) seen.set(id, (seen.get(id) ?? 0) + 1);
  }

  return [...rowsByApp].map(([appId, rows]) => {
    const details = apps.get(appId);
    const grossing = bestPosition(rows.filter((r) => r.chart === "top-grossing"));

    let grossingRankChange7: number | null = null;
    if (grossing && weekAgo) {
      const before = weekAgo.charts.find(
        (r) => r.app_id === appId && r.chart === "top-grossing" && r.genre_id === grossing.genreId,
      );
      if (before) grossingRankChange7 = before.rank - grossing.rank;
    }

    const ratingNow = latest.ratings.get(appId)?.rating_count ?? null;
    const ratingBefore = weekAgo?.ratings.get(appId)?.rating_count ?? null;

    return {
      appId,
      details,
      grossing,
      best: bestPosition(rows),
      grossingRankChange7,
      daysOnChart: seen.get(appId) ?? 0,
      windowDays: snapshots.length,
      ratingCount: ratingNow ?? details?.ratingCount ?? null,
      ratingDelta7: ratingNow !== null && ratingBefore !== null ? ratingNow - ratingBefore : null,
      ageDays: details?.releasedAt ? daysBetween(details.releasedAt, latest.date) : null,
    };
  });
}

const byGrossingRank = (a: AppSignal, b: AppSignal) => a.grossing!.rank - b.grossing!.rank;

export function isNew(s: AppSignal, config: Config): boolean {
  return s.ageDays !== null && s.ageDays <= config.report.newAppMaxAgeDays;
}

export function isSmall(s: AppSignal, config: Config): boolean {
  return s.ratingCount !== null && s.ratingCount < config.report.smallAppMaxRatings;
}

/** On a grossing chart with few ratings: earning without a giant audience. */
export function smallAndPaying(signals: AppSignal[], config: Config): AppSignal[] {
  return signals.filter((s) => s.grossing && isSmall(s, config)).sort(byGrossingRank);
}

/** Released recently and already on a grossing chart. Rare, so worth a look. */
export function newAndPaying(signals: AppSignal[], config: Config): AppSignal[] {
  return signals.filter((s) => s.grossing && isNew(s, config)).sort(byGrossingRank);
}

/** Biggest gains on the same grossing chart over a week. */
export function grossingClimbers(signals: AppSignal[]): AppSignal[] {
  return signals
    .filter((s) => (s.grossingRankChange7 ?? 0) > 0)
    .sort((a, b) => b.grossingRankChange7! - a.grossingRankChange7!);
}

/** Fastest ratings growth over a week, relative to size (needs 7+ days of data). */
export function ratingsMomentum(signals: AppSignal[], minDelta = 25): AppSignal[] {
  const growth = (s: AppSignal) => s.ratingDelta7! / Math.max(1, s.ratingCount! - s.ratingDelta7!);
  return signals
    .filter((s) => s.ratingDelta7 !== null && s.ratingCount !== null && s.ratingDelta7 >= minDelta)
    .sort((a, b) => growth(b) - growth(a));
}

/** New apps that stayed on the charts most of the window, not one-day spikes. */
export function stayingPower(signals: AppSignal[], config: Config, minWindow = 14): AppSignal[] {
  return signals
    .filter((s) => isNew(s, config) && s.windowDays >= minWindow && s.daysOnChart / s.windowDays >= 2 / 3)
    .sort((a, b) => b.daysOnChart - a.daysOnChart || (a.best?.rank ?? 999) - (b.best?.rank ?? 999));
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** How open each genre's grossing chart looks: lots of new or small apps = room for newcomers. */
export function genreSummaries(snapshot: Snapshot, signals: AppSignal[], config: Config): GenreSummary[] {
  const byId = new Map(signals.map((s) => [s.appId, s]));
  return config.genres
    .map((genre) => {
      const ids = snapshot.charts
        .filter((r) => r.chart === "top-grossing" && r.genre_id === genre.id)
        .map((r) => r.app_id);
      const members = ids.map((id) => byId.get(id)).filter((s): s is AppSignal => !!s);
      return {
        genreId: genre.id,
        grossingApps: ids.length,
        newApps: members.filter((s) => isNew(s, config)).length,
        smallApps: members.filter((s) => isSmall(s, config)).length,
        medianRatings: median(members.map((s) => s.ratingCount).filter((n): n is number => n !== null)),
      };
    })
    .filter((g) => g.grossingApps > 0);
}

export interface Cluster {
  /** The shared phrase, e.g. "meal planner". */
  term: string;
  apps: AppSignal[];
  publishers: number;
}

// Words that say nothing about what an app does.
const STOPWORDS = new Set(
  ("app apps the and for your you with from by pro plus free new best top lite get my our its all one " +
    "official mobile edition version iphone ipad ios online smart easy simple daily").split(" "),
);

// Words that only mean something as part of a phrase ("video generator", not "video").
const TOO_VAGUE_ALONE = new Set(
  ("video photo text tracker track monitor assistant learn scanner scan maker editor manager generator " +
    "note chat health tool money planner keeper finder reader player remote widget").split(" "),
);

function stem(word: string): string {
  return word.length > 4 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
}

/** Phrases (two words, never across "&", ":" or "-") and single words from an app name. */
export function nameTerms(name: string): string[] {
  const terms = new Set<string>();
  const unigrams: string[] = [];
  for (const segment of name.toLowerCase().split(/[&:|,·・+\-–—()]/u)) {
    const words = segment
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w))
      .map(stem);
    for (let i = 1; i < words.length; i++) terms.add(`${words[i - 1]} ${words[i]}`);
    unigrams.push(...words.filter((w) => !TOO_VAGUE_ALONE.has(w)));
  }
  for (const w of unigrams) terms.add(w);
  return [...terms];
}

/**
 * Niches where several different publishers' new or small apps are all earning:
 * apps on a grossing chart that share a phrase in their names.
 */
export function nicheClusters(signals: AppSignal[], config: Config, minPublishers = 3): Cluster[] {
  const candidates = signals.filter((s) => s.grossing && s.details && (isNew(s, config) || isSmall(s, config)));
  const byTerm = new Map<string, AppSignal[]>();
  for (const s of candidates) {
    for (const term of nameTerms(s.details!.name)) {
      const list = byTerm.get(term) ?? [];
      list.push(s);
      byTerm.set(term, list);
    }
  }

  const clusters = [...byTerm]
    .map(([term, all]) => {
      // A single word can mean different things in different genres ("guide" in Medical vs Finance),
      // so keep only its most common genre. Two-word phrases are specific enough as they are.
      if (term.includes(" ")) {
        const apps = all.sort(byGrossingRank);
        return { term, apps, publishers: new Set(apps.map((s) => s.details!.publisherId)).size };
      }
      const genres = new Map<string, number>();
      for (const s of all) genres.set(s.details!.primaryGenre, (genres.get(s.details!.primaryGenre) ?? 0) + 1);
      const genre = [...genres].sort((a, b) => b[1] - a[1])[0][0];
      const apps = all.filter((s) => s.details!.primaryGenre === genre).sort(byGrossingRank);
      return { term, apps, publishers: new Set(apps.map((s) => s.details!.publisherId)).size };
    })
    .filter((c) => c.publishers >= minPublishers)
    // Phrases first, then by how many publishers, then by best rank.
    .sort(
      (a, b) =>
        b.term.split(" ").length - a.term.split(" ").length ||
        b.publishers - a.publishers ||
        a.apps[0].grossing!.rank - b.apps[0].grossing!.rank,
    );

  // Keep a single word only if it adds apps that no chosen phrase already covers.
  const chosen: Cluster[] = [];
  const covered = new Set<string>();
  for (const c of clusters) {
    const fresh = c.apps.filter((s) => !covered.has(s.appId));
    if (c.term.includes(" ") || new Set(fresh.map((s) => s.details!.publisherId)).size >= minPublishers) {
      chosen.push(c);
      for (const s of c.apps) covered.add(s.appId);
    }
  }
  return chosen.sort((a, b) => b.publishers - a.publishers || a.apps[0].grossing!.rank - b.apps[0].grossing!.rank);
}
