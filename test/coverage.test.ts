import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type AppDetails, newAppsUrl } from "../src/apple.ts";
import { loadConfig } from "../src/config.ts";
import { type AppSignal, freshLaunches } from "../src/signals.ts";
import { type Snapshot, Store } from "../src/store.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "scout-"));
}

test("newAppsUrl points at the free and paid new-releases feeds", () => {
  assert.equal(newAppsUrl("us", "new-free"), "https://itunes.apple.com/us/rss/newfreeapplications/limit=100/json");
  assert.equal(newAppsUrl("gb", "new-paid"), "https://itunes.apple.com/gb/rss/newpaidapplications/limit=100/json");
});

test("newAppsSince keeps the first day each app was seen, within the window", () => {
  const dir = tempDir();
  try {
    const store = new Store(dir);
    store.writeNewApps("us", "2026-08-01", [{ feed: "new-free", position: 1, app_id: "old" }]);
    store.writeNewApps("us", "2026-10-30", [{ feed: "new-free", position: 1, app_id: "a" }]);
    store.writeNewApps("us", "2026-11-01", [
      { feed: "new-free", position: 3, app_id: "a" },
      { feed: "new-paid", position: 1, app_id: "b" },
    ]);
    assert.deepEqual([...store.newAppsSince("us", "2026-10-01")], [["a", "2026-10-30"], ["b", "2026-11-01"]]);
    assert.equal(store.newAppsSince("gb", "2026-10-01").size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function app(appId: string, ratingCount: number, releasedAt: string): AppDetails {
  return {
    appId, name: `App ${appId}`, publisher: "Pub", publisherId: "1", seller: "Pub Inc.", primaryGenre: "Utilities",
    price: 0, ratingCount, averageRating: 4.5, releasedAt, updatedAt: releasedAt, version: "1.0", languages: 1, url: "",
  };
}

test("freshLaunches ranks followed apps by ratings per day, keeping chart positions", () => {
  const apps = new Map([
    ["slow", app("slow", 30, "2026-10-03")], // 30 ratings in 30 days
    ["fast", app("fast", 50, "2026-10-28")], // 50 in 5 days
    ["tiny", app("tiny", 3, "2026-11-01")], // too few to rank
    ["charted", app("charted", 400, "2026-10-23")], // 40 a day, and on a chart
  ]);
  const snapshot: Snapshot = {
    date: "2026-11-02",
    charts: [],
    ratings: new Map([...apps.values()].map((a) => [a.appId, { app_id: a.appId, rating_count: a.ratingCount, average_rating: 4.5 }])),
  };
  const charted: AppSignal = {
    appId: "charted", details: apps.get("charted"), grossing: { chart: "top-grossing", genreId: 6002, rank: 40 },
    best: { chart: "top-grossing", genreId: 6002, rank: 40 }, grossingRankChange7: null, daysOnChart: 1, windowDays: 1,
    ratingCount: 400, ratingDelta7: null, ageDays: 10,
  };
  const followed = new Map(["slow", "fast", "tiny", "charted"].map((id) => [id, "2026-10-01"]));
  const result = freshLaunches([charted], followed, snapshot, apps);
  assert.deepEqual(result.map((s) => s.appId), ["charted", "fast", "slow"]);
  assert.equal(result[0].grossing?.rank, 40);
});

test("loadConfig researches only the first country when a config doesn't say", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "scout.config.json");
    const base = {
      countries: ["gb", "us"],
      charts: ["top-grossing"],
      genres: [{ id: 0, name: "All apps" }],
      report: { smallAppMaxRatings: 5000, newAppMaxAgeDays: 365, listSize: 15 },
    };
    writeFileSync(path, JSON.stringify(base));
    const config = loadConfig(path);
    assert.deepEqual(config.research.countries, ["gb"]);
    assert.equal(config.research.newApps, true);
    assert.equal(config.research.trackNewAppsDays, 90);

    writeFileSync(path, JSON.stringify({ ...base, research: { countries: ["us"], newApps: false } }));
    assert.deepEqual(loadConfig(path).research.countries, ["us"]);
    assert.equal(loadConfig(path).research.newApps, false);
    assert.equal(config.research.pages, true);

    // "prices" is the old name for "pages".
    writeFileSync(path, JSON.stringify({ ...base, research: { prices: false } }));
    assert.equal(loadConfig(path).research.pages, false);
    assert.ok(!("prices" in loadConfig(path).research));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the default config only lists genres Apple has charts for, once each", () => {
  const config = loadConfig(fileURLToPath(new URL("../scout.config.json", import.meta.url)));
  const ids = config.genres.map((g) => g.id);
  assert.equal(new Set(ids).size, ids.length);
  // Retired or empty genres: Magazines, Catalogs, Stickers, Dice, Educational and Kids games.
  for (const retired of [6021, 6022, 6025, 7007, 7008, 7010]) assert.ok(!ids.includes(retired), String(retired));
  assert.ok(config.research.countries.every((c) => config.countries.includes(c)));
});

test("apps.csv leaves out ratings, which come back from the latest ratings file", () => {
  const dir = tempDir();
  try {
    const store = new Store(dir);
    const scan = { date: "2026-11-02", scanned_at: "", source_updated_at: "", charts_ok: 1, charts_failed: 0, apps: 1 };
    store.writeSnapshot("us", scan, [{ chart: "top-grossing", genre_id: 0, rank: 1, app_id: "a" }], [app("a", 1234, "2026-01-01")]);
    const header = readFileSync(join(dir, "us", "apps.csv"), "utf8").split("\n")[0];
    assert.ok(!header.includes("ratingCount"), header);
    assert.equal(store.readApps("us").get("a")?.ratingCount, 1234);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
