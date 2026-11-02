import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppDetails } from "../src/apple.ts";
import type { Config } from "../src/config.ts";
import {
  computeSignals,
  genreSummaries,
  grossingClimbers,
  nameTerms,
  newAndPaying,
  nicheClusters,
  ratingsMomentum,
  smallAndPaying,
  snapshotDaysAgo,
  stayingPower,
} from "../src/signals.ts";
import type { ChartRow, Snapshot } from "../src/store.ts";

const config: Config = {
  countries: ["us"],
  charts: ["top-grossing", "top-free"],
  genres: [
    { id: 0, name: "All apps" },
    { id: 6013, name: "Health & Fitness" },
  ],
  report: { smallAppMaxRatings: 5000, newAppMaxAgeDays: 365, listSize: 10 },
};

function app(appId: string, ratingCount: number, releasedAt: string): AppDetails {
  return {
    appId, name: `App ${appId}`, publisher: "Pub", publisherId: "1", primaryGenre: "Health & Fitness",
    price: 0, ratingCount, averageRating: 4.5, releasedAt, updatedAt: releasedAt, url: "",
  };
}

const apps = new Map([
  ["big", app("big", 900_000, "2015-01-01")],
  ["small-old", app("small-old", 1200, "2019-01-01")],
  ["small-new", app("small-new", 800, "2026-06-01")],
]);

function snap(date: string, charts: Partial<ChartRow>[], ratings: Record<string, number>): Snapshot {
  return {
    date,
    charts: charts.map((c) => ({ chart: "top-grossing", genre_id: 6013, rank: 1, app_id: "", ...c }) as ChartRow),
    ratings: new Map(Object.entries(ratings).map(([id, n]) => [id, { app_id: id, rating_count: n, average_rating: 4.5 }])),
  };
}

const weekAgo = snap(
  "2026-10-26",
  [{ app_id: "big", rank: 1 }, { app_id: "small-old", rank: 2 }, { app_id: "small-new", rank: 40 }],
  { big: 899_000, "small-old": 1190, "small-new": 500 },
);
const today = snap(
  "2026-11-02",
  [
    { app_id: "big", rank: 1 },
    { app_id: "small-new", rank: 5 },
    { app_id: "small-old", rank: 9 },
    { app_id: "small-new", rank: 30, genre_id: 0 },
    { app_id: "big", rank: 3, chart: "top-free", genre_id: 0 },
  ],
  { big: 900_000, "small-old": 1200, "small-new": 800 },
);
const snapshots = [weekAgo, today];
const signals = computeSignals(snapshots, apps);
const byId = (id: string) => signals.find((s) => s.appId === id)!;

test("snapshotDaysAgo finds the latest snapshot at least N days old", () => {
  assert.equal(snapshotDaysAgo(snapshots, 7)?.date, "2026-10-26");
  assert.equal(snapshotDaysAgo(snapshots, 8), null);
  assert.equal(snapshotDaysAgo([today], 1), null);
});

test("computeSignals picks the best grossing position and rank change", () => {
  const s = byId("small-new");
  assert.deepEqual(s.grossing, { chart: "top-grossing", genreId: 6013, rank: 5 });
  assert.equal(s.grossingRankChange7, 35);
  assert.equal(s.ratingDelta7, 300);
  assert.equal(s.ageDays, 154);
  assert.equal(s.daysOnChart, 2);
  assert.equal(byId("small-old").grossingRankChange7, -7);
});

test("smallAndPaying excludes big apps and sorts by grossing rank", () => {
  assert.deepEqual(smallAndPaying(signals, config).map((s) => s.appId), ["small-new", "small-old"]);
});

test("newAndPaying only keeps recent releases", () => {
  assert.deepEqual(newAndPaying(signals, config).map((s) => s.appId), ["small-new"]);
});

test("grossingClimbers only keeps apps that moved up", () => {
  assert.deepEqual(grossingClimbers(signals).map((s) => s.appId), ["small-new"]);
});

test("ratingsMomentum ranks by relative growth, ignoring tiny deltas", () => {
  assert.deepEqual(ratingsMomentum(signals).map((s) => s.appId), ["small-new", "big"]);
});

test("stayingPower needs a long enough window", () => {
  assert.deepEqual(stayingPower(signals, config), []);
  const long = Array.from({ length: 14 }, (_, i) => ({ ...today, date: `2026-11-${String(i + 1).padStart(2, "0")}` }));
  assert.deepEqual(stayingPower(computeSignals(long, apps), config).map((s) => s.appId), ["small-new"]);
});

test("genreSummaries counts new and small apps per grossing chart", () => {
  const [all, health] = genreSummaries(today, signals, config);
  assert.deepEqual(all, { genreId: 0, grossingApps: 1, newApps: 1, smallApps: 1, medianRatings: 800 });
  assert.deepEqual(health, { genreId: 6013, grossingApps: 3, newApps: 1, smallApps: 2, medianRatings: 1200 });
});

test("nameTerms keeps phrases inside segments and drops vague single words", () => {
  const terms = nameTerms("Whipp: Meal Planner & Recipes");
  assert.ok(terms.includes("meal planner"));
  assert.ok(terms.includes("recipe"));
  assert.ok(!terms.includes("planner recipe"));
  assert.ok(!terms.includes("planner"));
});

test("nicheClusters needs several publishers sharing a phrase", () => {
  const names: [string, string][] = [
    ["a", "mise - meal planner"],
    ["b", "Potto - Meal Planner"],
    ["c", "NeatEat: Meal Planner"],
    ["d", "Solo Meal Planner"],
  ];
  const sigs = names.map(([id, name], i) => ({
    ...byId("small-new"),
    appId: id,
    grossing: { chart: "top-grossing" as const, genreId: 6023, rank: i + 1 },
    details: { ...app(id, 100, "2026-06-01"), name, publisherId: id === "d" ? "a" : id },
  }));
  const [cluster] = nicheClusters(sigs, config);
  assert.equal(cluster.term, "meal planner");
  assert.equal(cluster.publishers, 3);
  assert.equal(cluster.apps.length, 4);
  assert.deepEqual(nicheClusters(sigs.slice(0, 2), config), []);
});
