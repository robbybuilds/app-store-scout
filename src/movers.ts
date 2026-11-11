// What moved on a chart since the previous scan: climbers, fallers, apps that just arrived,
// apps that left, and first-time #1s. Pure, so it can be tested with made-up snapshots.
// A rank change says an app out-earned different neighbours than yesterday, never how much.

import type { Chart } from "./config.ts";
import type { Snapshot } from "./store.ts";

export interface Mover {
  appId: string;
  genreId: number;
  /** Today's place. For an app that left the chart, the place it held before leaving. */
  rank: number;
  /** Its place on the same chart in the previous scan, or null if it wasn't there. */
  previous: number | null;
  /** Places gained (positive) or lost (negative); null when there's no previous place. */
  change: number | null;
  /** For arrivals: true if the app was on no chart of this kind in any earlier saved scan. */
  debut?: boolean;
}

export interface Movers {
  chart: Chart;
  date: string;
  /** The scan these are compared with, or null when there is only one scan so far. */
  previousDate: string | null;
  climbers: Mover[];
  fallers: Mover[];
  /** On a chart today, on none of them in the previous scan. */
  arrivals: Mover[];
  /** On a chart in the previous scan, on none of them today. */
  exits: Mover[];
  /** #1 on a genre chart today, and never #1 on that chart in any earlier saved scan. */
  firstNumberOnes: Mover[];
}

const key = (genreId: number, appId: string) => `${genreId}:${appId}`;

export function chartMovers(snapshots: Snapshot[], chart: Chart = "top-grossing"): Movers {
  const latest = snapshots.at(-1);
  const prev = snapshots.at(-2);
  const out: Movers = {
    chart, date: latest?.date ?? "", previousDate: prev?.date ?? null,
    climbers: [], fallers: [], arrivals: [], exits: [], firstNumberOnes: [],
  };
  if (!latest || !prev) return out;

  const today = latest.charts.filter((r) => r.chart === chart);
  const before = prev.charts.filter((r) => r.chart === chart);
  const beforeRank = new Map(before.map((r) => [key(r.genre_id, r.app_id), r.rank]));
  // A chart that failed to download yesterday would make every app on it look new today.
  const genresBefore = new Set(before.map((r) => r.genre_id));
  const genresToday = new Set(today.map((r) => r.genre_id));
  const appsBefore = new Set(before.map((r) => r.app_id));
  const appsToday = new Set(today.map((r) => r.app_id));

  const earlier = snapshots.slice(0, -1);
  const everCharted = new Set<string>();
  const everFirst = new Set<string>();
  for (const snap of earlier) {
    for (const r of snap.charts) {
      if (r.chart !== chart) continue;
      everCharted.add(r.app_id);
      if (r.rank === 1) everFirst.add(key(r.genre_id, r.app_id));
    }
  }

  // An app can sit on several genre charts; keep the one that says the most about it.
  const keep = (list: Map<string, Mover>, m: Mover, better: (a: Mover, b: Mover) => boolean) => {
    const have = list.get(m.appId);
    if (!have || better(m, have)) list.set(m.appId, m);
  };
  const climbers = new Map<string, Mover>();
  const fallers = new Map<string, Mover>();
  const arrivals = new Map<string, Mover>();
  const exits = new Map<string, Mover>();
  // Among equal ranks, a category chart says more than the overall one.
  const higher = (a: Mover, b: Mover) => a.rank < b.rank || (a.rank === b.rank && b.genreId === 0 && a.genreId !== 0);

  for (const r of today) {
    if (!genresBefore.has(r.genre_id)) continue;
    const previous = beforeRank.get(key(r.genre_id, r.app_id)) ?? null;
    const m: Mover = { appId: r.app_id, genreId: r.genre_id, rank: r.rank, previous, change: previous === null ? null : previous - r.rank };
    if (m.change !== null && m.change > 0) keep(climbers, m, (a, b) => a.change! > b.change! || (a.change === b.change && higher(a, b)));
    if (m.change !== null && m.change < 0) keep(fallers, m, (a, b) => a.change! < b.change! || (a.change === b.change && higher(a, b)));
    if (!appsBefore.has(r.app_id)) keep(arrivals, { ...m, debut: !everCharted.has(r.app_id) }, higher);
    if (r.rank === 1 && r.genre_id !== 0 && !everFirst.has(key(r.genre_id, r.app_id))) out.firstNumberOnes.push(m);
  }
  for (const r of before) {
    if (!genresToday.has(r.genre_id) || appsToday.has(r.app_id)) continue;
    keep(exits, { appId: r.app_id, genreId: r.genre_id, rank: r.rank, previous: r.rank, change: null }, higher);
  }

  out.climbers = [...climbers.values()].sort((a, b) => b.change! - a.change! || a.rank - b.rank);
  out.fallers = [...fallers.values()].sort((a, b) => a.change! - b.change! || a.rank - b.rank);
  out.arrivals = [...arrivals.values()].sort((a, b) => a.rank - b.rank);
  out.exits = [...exits.values()].sort((a, b) => a.rank - b.rank);
  out.firstNumberOnes.sort((a, b) => a.genreId - b.genreId);
  return out;
}
