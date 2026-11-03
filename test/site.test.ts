import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { AppDetails } from "../src/apple.ts";
import type { Config } from "../src/config.ts";
import { buildSite, longDate, slug, tear } from "../src/site.ts";
import type { SearchIndex } from "../src/site-search.ts";
import { Store } from "../src/store.ts";

test("slug, longDate and tear are stable", () => {
  assert.equal(slug("Meal Planner"), "meal-planner");
  assert.equal(slug("haushaltsbuch"), "haushaltsbuch");
  assert.equal(slug("ai video <generator>"), "ai-video-generator");
  assert.equal(longDate("2026-11-03"), "3 November 2026");
  assert.equal(tear(11), tear(11));
  assert.notEqual(tear(11), tear(12));
  assert.match(tear(3), /^polygon\(0\.00% [\d.]+px, /);
});

const config: Config = {
  countries: ["us", "gb"],
  charts: ["top-grossing"],
  genres: [{ id: 0, name: "All apps" }, { id: 6013, name: "Health & Fitness" }],
  report: { smallAppMaxRatings: 5000, newAppMaxAgeDays: 365, listSize: 10 },
  research: { countries: ["us"], niches: 10, reviewPages: 1, searchVolume: false, pages: true, newApps: false, trackNewAppsDays: 90 },
};

function app(appId: string, name: string, publisher: string): AppDetails {
  return {
    appId, name, publisher, publisherId: `p-${publisher}`, seller: publisher, primaryGenre: "Health & Fitness", price: 0,
    ratingCount: 800, averageRating: 4.6, releasedAt: "2026-06-01", updatedAt: "2026-10-01", version: "1.0", languages: 3,
    url: `https://apps.apple.com/us/app/id${appId}`,
  };
}

test("buildSite writes the home, niche, app and country pages with a sitemap", () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-site-"));
  try {
    const store = new Store(join(dir, "data"));
    // Three publishers share "fasting tracker", so it's a niche; one name needs escaping.
    const apps = [app("1", "Fasting Tracker <Zero>", "Ann Lee"), app("2", "Easy Fasting Tracker", "Bolt Ltd"), app("3", "Fasting Tracker Pro", "Cove Inc")];
    for (const country of ["us", "gb"]) {
      store.writeSnapshot(
        country,
        { date: "2026-11-03", scanned_at: "", source_updated_at: "", charts_ok: 2, charts_failed: 0, apps: 3 },
        apps.map((a, i) => ({ chart: "top-grossing", genre_id: 6013, rank: i + 1, app_id: a.appId })),
        apps,
      );
    }
    store.writePages("us", new Map([["1", { app_id: "1", stars_5: 80, stars_4: 10, stars_3: 2, stars_2: 3, stars_1: 5, editors_choice: false, age_rating: "4+", size_mb: 40, privacy: "none", tracking: "", checked_at: "2026-11-03" }]]));

    const out = join(dir, "public");
    const assets = fileURLToPath(new URL("../web", import.meta.url));
    const { pages } = buildSite(store, config, { url: "https://example.github.io/scout/", repo: "example/scout", out, assets });

    for (const path of ["index.html", "niches/index.html", "niches/fasting-tracker/index.html", "apps/1/index.html", "countries/gb/index.html", "about/index.html", "404.html", "assets/style.css", ".nojekyll"]) {
      assert.ok(existsSync(join(out, path)), path);
    }
    const home = readFileSync(join(out, "index.html"), "utf8");
    // The figures count what was scanned (2 genres in the snapshot), and the other country gets a panel.
    assert.match(home, /<dt>categories<\/dt><dd>1<\/dd>/);
    assert.match(home, /<dt>countries<\/dt><dd>2<\/dd>/);
    assert.match(home, />One more App Store</);
    assert.match(home, /href="\/scout\/niches\/fasting-tracker\/"/);
    assert.match(home, /<link rel="canonical" href="https:\/\/example.github.io\/scout\/">/);
    const niche = readFileSync(join(out, "niches/fasting-tracker/index.html"), "utf8");
    assert.match(niche, /Fasting Tracker &lt;Zero&gt;/);
    assert.ok(!niche.includes("<Zero>"));
    // Only the researched app gets its own page; the others link to the App Store.
    assert.match(niche, /href="\/scout\/apps\/1\/"/);
    assert.match(niche, /href="https:\/\/apps.apple.com\/us\/app\/id2"/);

    // One search index per country: grossing apps first, categories listed once, page flag for researched apps.
    const index = JSON.parse(readFileSync(join(out, "data/search-us.json"), "utf8")) as SearchIndex;
    assert.equal(index.apps.length, 3);
    assert.deepEqual(index.apps.map((a) => [a[0], a[6], a[9]]), [["1", 1, 1], ["2", 2, 0], ["3", 3, 0]]);
    assert.deepEqual(index.categories, ["Health & Fitness"]);
    assert.ok(existsSync(join(out, "data/search-gb.json")));
    assert.match(readFileSync(join(out, "search/index.html"), "utf8"), /<option value="us">United States<\/option><option value="gb">/);

    const sitemap = readFileSync(join(out, "sitemap.xml"), "utf8");
    assert.equal((sitemap.match(/<loc>/g) ?? []).length, pages);
    assert.ok(!sitemap.includes("404"));
    assert.match(readFileSync(join(out, "robots.txt"), "utf8"), /Sitemap: https:\/\/example.github.io\/scout\/sitemap.xml/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nicheHistory remembers when each niche was first and last seen", () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-niches-"));
  try {
    const store = new Store(dir);
    store.writeNiches("us", "2026-11-01", [{ term: "recipe", app_id: "a" }, { term: "merge", app_id: "b" }]);
    store.writeNiches("us", "2026-11-03", [{ term: "recipe", app_id: "a" }, { term: "recipe", app_id: "c" }]);
    const history = store.nicheHistory("us");
    assert.deepEqual(history.map((h) => [h.term, h.firstSeen, h.lastSeen, h.daysSeen, h.appIds]), [
      ["recipe", "2026-11-01", "2026-11-03", 2, ["a", "c"]],
      ["merge", "2026-11-01", "2026-11-01", 1, ["b"]],
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
