import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { AppDetails } from "../src/apple.ts";
import { describeChange, detailChanges, purchaseChanges } from "../src/changes.ts";
import type { Chart, Config } from "../src/config.ts";
import { createServer } from "../src/mcp.ts";
import { chartMovers } from "../src/movers.ts";
import type { PriceRow } from "../src/prices.ts";
import { confirmedRemovals, droppedApps, recheckIds, type RemovedRow, updateRemoved } from "../src/removed.ts";
import { buildSite } from "../src/site.ts";
import { type ChartRow, type Snapshot, Store } from "../src/store.ts";

const config: Config = {
  countries: ["us"],
  charts: ["top-grossing", "top-free"],
  genres: [{ id: 0, name: "All apps" }, { id: 6013, name: "Health & Fitness" }, { id: 6023, name: "Food & Drink" }],
  report: { smallAppMaxRatings: 5000, newAppMaxAgeDays: 365, listSize: 10 },
  research: { countries: ["us"], niches: 10, reviewPages: 1, searchVolume: false, pages: true, newApps: false, trackNewAppsDays: 90 },
  site: { community: { name: "Test Club", url: "https://example.com/club" }, newsletter: { loopsFormId: "abc123", mailingLists: "list1" } },
};

function app(appId: string, name: string, publisher = `Pub ${appId}`, extra: Partial<AppDetails> = {}): AppDetails {
  return {
    appId, name, publisher, publisherId: `p-${publisher}`, seller: publisher, primaryGenre: "Health & Fitness", price: 0,
    ratingCount: 800, averageRating: 4.6, releasedAt: "2026-06-01", updatedAt: "2026-10-01", version: "1.0", languages: 3,
    url: `https://apps.apple.com/us/app/id${appId}`, ...extra,
  };
}

const row = (genre_id: number, rank: number, app_id: string, chart: Chart = "top-grossing"): ChartRow => ({ chart, genre_id, rank, app_id });
const snap = (date: string, charts: ChartRow[]): Snapshot => ({ date, charts, ratings: new Map() });

test("chartMovers finds climbers, fallers, arrivals, exits and first-time #1s", () => {
  const m = chartMovers([
    snap("2026-11-01", [row(6013, 1, "a"), row(6013, 2, "b"), row(6013, 3, "e")]),
    snap("2026-11-02", [row(6013, 1, "a"), row(6013, 5, "b"), row(6013, 9, "c"), row(0, 40, "c"), row(6013, 10, "x")]),
    // b overtakes a for the first time; c climbs on two charts; d is brand new; e was here on day one; x left.
    snap("2026-11-03", [row(6013, 1, "b"), row(6013, 2, "a"), row(6013, 4, "c"), row(0, 10, "c"), row(6013, 7, "d"), row(6013, 8, "e")]),
  ]);
  assert.equal(m.previousDate, "2026-11-02");
  // c gained 30 on the overall chart and 5 on its category: listed once, for the bigger move.
  assert.deepEqual(m.climbers.map((x) => [x.appId, x.genreId, x.change]), [["c", 0, 30], ["b", 6013, 4]]);
  assert.deepEqual(m.fallers.map((x) => [x.appId, x.change]), [["a", -1]]);
  assert.deepEqual(m.arrivals.map((x) => [x.appId, x.rank, x.debut]), [["d", 7, true], ["e", 8, false]]);
  assert.deepEqual(m.exits.map((x) => [x.appId, x.rank]), [["x", 10]]);
  assert.deepEqual(m.firstNumberOnes.map((x) => [x.appId, x.previous]), [["b", 5]]);
});

test("chartMovers ignores a chart that was missing yesterday, and needs two scans", () => {
  assert.equal(chartMovers([snap("2026-11-01", [row(6013, 1, "a")])]).previousDate, null);
  const m = chartMovers([snap("2026-11-01", [row(6013, 1, "a")]), snap("2026-11-02", [row(6013, 1, "a"), row(6023, 1, "f"), row(6023, 2, "g")])]);
  // Food & Drink failed to download on day one, so its apps aren't "new" on day two.
  assert.deepEqual(m.arrivals, []);
  assert.deepEqual(m.firstNumberOnes, []);
});

test("detailChanges and purchaseChanges log what changed, and nothing on first sight", () => {
  const before = app("1", "Meal Plan", "Ann", { price: 4.99 });
  assert.deepEqual(detailChanges("2026-11-03", undefined, before), []);
  assert.deepEqual(detailChanges("2026-11-03", before, { ...before, ratingCount: 9, version: "2.0" }), []);
  const changes = detailChanges("2026-11-03", before, { ...before, name: "Meal Plan: AI Recipes", price: 0, seller: "Big Co", primaryGenre: "Food & Drink" });
  assert.deepEqual(changes.map((c) => c.field), ["name", "price", "seller", "category"]);
  assert.equal(describeChange(changes[0]), "Renamed from “Meal Plan” to “Meal Plan: AI Recipes”.");
  assert.equal(describeChange(changes[1]), "Price changed from 4.99 to free.");
  // A seller column that didn't exist yet is not a change.
  assert.deepEqual(detailChanges("2026-11-03", { ...before, seller: "" }, before), []);

  const price = (item: string, text: string): PriceRow => ({ app_id: "1", item, price: Number(text.slice(1)), price_text: text, period: "yearly", checked_at: "" });
  assert.deepEqual(purchaseChanges("2026-11-10", "1", undefined, [price("Yearly", "$39.99")]), []);
  const p = purchaseChanges("2026-11-10", "1", [price("Yearly", "$39.99"), price("Weekly", "$4.99")], [price("Yearly", "$29.99"), price("Lifetime", "$79.99")]);
  assert.deepEqual(p.map((c) => [c.field, c.from, c.to]), [
    ["purchase price", "Yearly $39.99", "Yearly $29.99"],
    ["purchase added", "", "Lifetime $79.99"],
    ["purchase removed", "Weekly $4.99", ""],
  ]);
});

test("writeSnapshot logs listing changes once, even if the scan runs twice", () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-changes-"));
  try {
    const store = new Store(dir);
    const scan = (date: string) => ({ date, scanned_at: "", source_updated_at: "", charts_ok: 1, charts_failed: 0, apps: 1 });
    store.writeSnapshot("us", scan("2026-11-01"), [row(6013, 1, "1")], [app("1", "Fasting")]);
    assert.deepEqual(store.readChanges("us"), []);
    for (let i = 0; i < 2; i++) store.writeSnapshot("us", scan("2026-11-02"), [row(6013, 1, "1")], [app("1", "Fasting: Zero Hunger")]);
    assert.deepEqual(store.readChanges("us"), [{ date: "2026-11-02", app_id: "1", field: "name", from: "Fasting", to: "Fasting: Zero Hunger" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removed apps need two misses on different days, and can come back", () => {
  const snaps = [
    snap("2026-11-01", [row(6013, 3, "gone"), row(6013, 9, "gone", "top-free"), row(6013, 4, "fine"), row(6013, 5, "blip")]),
    snap("2026-11-02", [row(6013, 1, "gone", "top-free"), row(6013, 4, "fine")]),
    snap("2026-11-03", [row(6013, 4, "fine")]),
  ];
  const dropped = droppedApps(snaps);
  // A grossing place beats a higher place on another chart; the last day charted is kept.
  assert.deepEqual(dropped.get("gone"), { chart: "top-grossing", genreId: 6013, rank: 3, lastCharted: "2026-11-02" });
  assert.ok(!dropped.has("fine"));
  const apps = new Map([["gone", app("gone", "Gone App")], ["blip", app("blip", "Blip")]]);
  const checked = new Set(["gone", "blip"]);

  let rows: RemovedRow[] = updateRemoved([], "2026-11-03", dropped, checked, new Set(), apps);
  assert.deepEqual(rows.map((r) => [r.app_id, r.name, r.confirmed_on]), [["gone", "Gone App", ""], ["blip", "Blip", ""]]);
  assert.deepEqual(confirmedRemovals(rows), []);
  // The same day again changes nothing: one day's lookups can't confirm themselves.
  assert.deepEqual(updateRemoved(rows, "2026-11-03", dropped, checked, new Set(), apps), rows);

  // Next day blip is back (it never left) and gone is still missing.
  rows = updateRemoved(rows, "2026-11-04", dropped, checked, new Set(["blip"]), apps);
  assert.deepEqual(rows.map((r) => [r.app_id, r.missing_since, r.confirmed_on, r.returned_on]), [["gone", "2026-11-03", "2026-11-04", ""]]);
  assert.deepEqual(recheckIds(rows, "2026-11-20"), ["gone"]);
  assert.deepEqual(recheckIds(rows, "2027-03-01"), []);

  // A row that wasn't looked up today is left alone; when it is found again, it returned.
  assert.deepEqual(updateRemoved(rows, "2026-11-05", new Map(), new Set(), new Set(), apps), rows);
  rows = updateRemoved(rows, "2026-11-09", new Map(), new Set(["gone"]), new Set(["gone"]), apps);
  assert.equal(rows[0].returned_on, "2026-11-09");
  assert.equal(confirmedRemovals(rows).length, 1);
});

test("the site gets movers, changes, removed, API and feed, and the MCP server answers from the same data", () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-tracking-"));
  try {
    const store = new Store(join(dir, "data"));
    const scan = (date: string) => ({ date, scanned_at: "", source_updated_at: "", charts_ok: 1, charts_failed: 0, apps: 4 });
    const apps = [app("1", "Fasting Tracker Zero", "Ann Lee"), app("2", "Easy Fasting Tracker", "Bolt Ltd"), app("3", "Fasting Tracker Pro", "Cove Inc")];
    store.writeSnapshot("us", scan("2026-11-02"), [row(6013, 1, "1"), row(6013, 8, "2"), row(6013, 3, "3")], apps);
    store.writeSnapshot("us", scan("2026-11-03"), [row(6013, 1, "1"), row(6013, 2, "2"), row(6013, 5, "4")], [
      apps[0], { ...apps[1], name: "Easy Fasting Tracker <AI>" }, app("4", "Fasting Tracker Kit", "Dune LLC"),
    ]);
    store.writePages("us", new Map([["1", { app_id: "1", stars_5: 80, stars_4: 10, stars_3: 2, stars_2: 3, stars_1: 5, editors_choice: false, age_rating: "4+", size_mb: 40, privacy: "none", tracking: "", checked_at: "2026-11-03" }]]));
    store.writeRemoved("us", [{ app_id: "3", name: "Fasting Tracker Pro", publisher: "Cove Inc", genre: "Health & Fitness", best_chart: "top-grossing", best_genre_id: 6013, best_rank: 3, last_charted: "2026-11-02", missing_since: "2026-11-03", confirmed_on: "2026-11-04", returned_on: "" }]);

    const out = join(dir, "public");
    buildSite(store, config, { url: "https://example.github.io/scout", repo: "example/scout", out, assets: fileURLToPath(new URL("../web", import.meta.url)) });
    for (const path of ["movers/index.html", "changes/index.html", "removed/index.html", "api/index.html", "feed.xml", "api/v1/index.json", "api/v1/us/movers.json", "api/v1/us/charts/top-grossing.json", "api/v1/us/apps/1.json"]) {
      assert.ok(existsSync(join(out, path)), path);
    }
    const read = (path: string) => readFileSync(join(out, path), "utf8");
    const movers = read("movers/index.html");
    assert.match(movers, /Easy Fasting Tracker &lt;AI&gt;<\/a><\/td>.*?<td>#2 Health &amp; Fitness<\/td><td class="n">\+6<\/td>/s);
    assert.match(movers, /Fasting Tracker Kit<\/a> <span class="muted">first time<\/span>/);
    assert.match(read("changes/index.html"), /Renamed from “Easy Fasting Tracker” to “Easy Fasting Tracker &lt;AI&gt;”\./);
    assert.match(read("removed/index.html"), /<td>Fasting Tracker Pro<\/td>.*?#3 grossing, Health &amp; Fitness/s);
    const home = read("index.html");
    assert.match(home, /Moving on the money charts/);
    assert.match(home, /<a class="btn btn--primary" href="https:\/\/example.com\/club">Join Test Club<\/a>/);
    assert.match(home, /<link rel="alternate" type="application\/atom\+xml"/);
    // The sign-up posts to Loops' public form endpoint, tagged so Scout's readers can be told apart.
    assert.match(home, /<form class="signup" method="post" action="https:\/\/app\.loops\.so\/api\/newsletter-form\/abc123" data-signup>/);
    assert.match(home, /<input type="hidden" name="userGroup" value="App Store Scout">\n<input type="hidden" name="mailingLists" value="list1">/);
    assert.match(read("movers/index.html"), /data-signup/);
    // No form id, no form and no script.
    const bare = join(dir, "bare");
    buildSite(store, { ...config, site: { newsletter: { loopsFormId: "" } } }, { url: "https://example.github.io/scout", repo: "example/scout", out: bare, assets: fileURLToPath(new URL("../web", import.meta.url)) });
    assert.ok(!readFileSync(join(bare, "index.html"), "utf8").includes("signup"));
    assert.match(read("feed.xml"), /<title>New niche: fasting tracker<\/title>/);

    const api = JSON.parse(read("api/v1/us/movers.json"));
    assert.deepEqual(api.climbers.map((m: { id: string; places_gained: number }) => [m.id, m.places_gained]), [["2", 6]]);
    assert.equal(JSON.parse(read("api/v1/us/removed.json")).still_gone, 1);

    const server = createServer(store, config);
    const call = (name: string, args: object = {}) => {
      const res = server.handle({ id: 1, method: "tools/call", params: { name, arguments: args as Record<string, unknown> } }) as { result: { content: { text: string }[]; isError?: boolean } };
      return { ...res.result, data: res.result.isError ? null : JSON.parse(res.result.content[0].text) };
    };
    const init = server.handle({ id: 0, method: "initialize", params: { protocolVersion: "2025-03-26" } }) as { result: { protocolVersion: string } };
    assert.equal(init.result.protocolVersion, "2025-03-26");
    assert.equal(server.handle({ method: "notifications/initialized" }), null);
    const listed = server.handle({ id: 2, method: "tools/list" }) as { result: { tools: { name: string; run?: unknown }[] } };
    assert.equal(listed.result.tools.length, 9);
    assert.ok(listed.result.tools.every((t) => t.run === undefined));
    // The MCP answer is the API file, word for word.
    assert.deepEqual(call("get_movers", { limit: 100 }).data, api);
    assert.deepEqual(call("list_niches").data.niches.map((n: { term: string }) => n.term), ["fasting tracker"]);
    assert.equal(call("get_niche", { term: "fasting tracker" }).data.publishers, 3);
    assert.equal(call("search_apps", { query: "fasting kit" }).data.total, 1);
    assert.equal(call("get_app", { app_id: "2" }).data.listing_changes[0].field, "name");
    assert.equal(call("get_chart", { category: "health & fitness" }).data.rows.length, 3);
    assert.equal(call("get_listing_changes").data.total, 1);
    assert.equal(call("get_removed_apps").data.apps[0].name, "Fasting Tracker Pro");
    assert.equal(call("get_app", { app_id: "999" }).isError, true);
    assert.equal(call("get_lists", { country: "zz" }).isError, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
