// Apps that were on a chart and then vanished from the App Store. Each scan looks up the apps
// that dropped off the charts lately; one the Lookup API no longer knows is missing. Missing on
// two scans on different days counts as removed (one miss can be a hiccup on Apple's side), and
// if it turns up again later it's marked as returned.
//
// "Removed" is the day Scout noticed, not the day it happened, and it is per country: an app can
// leave one storefront and stay in another. Scout can't tell who removed it, Apple or the developer.

import type { AppDetails } from "./apple.ts";
import type { Chart } from "./config.ts";
import type { Snapshot } from "./store.ts";

export interface RemovedRow {
  app_id: string;
  name: string;
  publisher: string;
  genre: string;
  /** Its best place while Scout watched: a top-grossing place if it had one, else any chart. */
  best_chart: Chart | "";
  best_genre_id: number;
  best_rank: number;
  last_charted: string;
  missing_since: string;
  /** Empty until a second scan on a later day also finds it missing. */
  confirmed_on: string;
  returned_on: string;
}

export interface Dropped {
  chart: Chart;
  genreId: number;
  rank: number;
  lastCharted: string;
}

/** Apps on a chart in an earlier snapshot but on none in the latest, with their best place. */
export function droppedApps(snapshots: Snapshot[]): Map<string, Dropped> {
  const latest = snapshots.at(-1);
  const out = new Map<string, Dropped>();
  if (!latest) return out;
  const today = new Set(latest.charts.map((r) => r.app_id));
  const beats = (chart: Chart, rank: number, have: Dropped) =>
    chart === "top-grossing" && have.chart !== "top-grossing" ? true
    : chart !== "top-grossing" && have.chart === "top-grossing" ? false
    : rank < have.rank;
  for (const snap of snapshots.slice(0, -1)) {
    for (const r of snap.charts) {
      if (today.has(r.app_id)) continue;
      const have = out.get(r.app_id);
      if (!have) out.set(r.app_id, { chart: r.chart, genreId: r.genre_id, rank: r.rank, lastCharted: snap.date });
      else {
        if (beats(r.chart, r.rank, have)) Object.assign(have, { chart: r.chart, genreId: r.genre_id, rank: r.rank });
        if (snap.date > have.lastCharted) have.lastCharted = snap.date;
      }
    }
  }
  return out;
}

const DAY = 86_400_000;

/** Tracked apps worth looking up again: unconfirmed ones, and removed ones that might come back. */
export function recheckIds(rows: RemovedRow[], today: string, days = 60): string[] {
  const since = new Date(Date.parse(today) - days * DAY).toISOString().slice(0, 10);
  return rows.filter((r) => !r.returned_on && r.missing_since >= since).map((r) => r.app_id);
}

/**
 * Folds one scan's lookups into the list. `checked` is every app looked up today and `found`
 * the ones Apple still returned; an app that wasn't checked keeps its row untouched.
 */
export function updateRemoved(
  rows: RemovedRow[],
  today: string,
  dropped: Map<string, Dropped>,
  checked: Set<string>,
  found: Set<string>,
  apps: Map<string, AppDetails>,
): RemovedRow[] {
  const out: RemovedRow[] = [];
  const tracked = new Set<string>();
  for (const row of rows) {
    tracked.add(row.app_id);
    if (!checked.has(row.app_id)) { out.push(row); continue; }
    if (found.has(row.app_id)) {
      // Back after one miss: it never left. Back after a confirmed removal: it returned.
      if (!row.confirmed_on) continue;
      out.push(row.returned_on ? row : { ...row, returned_on: today });
    } else if (row.returned_on) {
      // Gone again after coming back: start a new watch.
      out.push({ ...row, missing_since: today, confirmed_on: "", returned_on: "" });
    } else if (!row.confirmed_on && row.missing_since < today) {
      out.push({ ...row, confirmed_on: today });
    } else {
      out.push(row);
    }
  }
  for (const [appId, d] of dropped) {
    if (tracked.has(appId) || !checked.has(appId) || found.has(appId)) continue;
    const details = apps.get(appId);
    out.push({
      app_id: appId,
      name: details?.name ?? "",
      publisher: details?.publisher ?? "",
      genre: details?.primaryGenre ?? "",
      best_chart: d.chart,
      best_genre_id: d.genreId,
      best_rank: d.rank,
      last_charted: d.lastCharted,
      missing_since: today,
      confirmed_on: "",
      returned_on: "",
    });
  }
  return out.sort((a, b) => b.missing_since.localeCompare(a.missing_since) || a.best_rank - b.best_rank || a.app_id.localeCompare(b.app_id));
}

/** Confirmed removals, newest first. Apps that came back stay on the list with the day they did. */
export function confirmedRemovals(rows: RemovedRow[]): RemovedRow[] {
  return rows.filter((r) => r.confirmed_on);
}
