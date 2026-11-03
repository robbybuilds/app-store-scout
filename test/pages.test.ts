import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  alsoSuggested,
  lowStarShare,
  mergeVersions,
  type PageRow,
  parsePage,
  releasesWithin,
  type SimilarRow,
  sizeMb,
  type VersionRow,
  versionDate,
} from "../src/pages.ts";

const html = readFileSync(new URL("fixtures/app-page.html", import.meta.url), "utf8");

test("parsePage reads stars, badges, privacy, versions, similar apps and prices from one page", () => {
  const { page, versions, similar, prices } = parsePage(html, "42", "2026-11-03");
  assert.deepEqual(page, {
    app_id: "42",
    stars_5: 150, stars_4: 10, stars_3: 4, stars_2: 3, stars_1: 15,
    editors_choice: false,
    age_rating: "12+",
    size_mb: 1228.8,
    privacy: "tracking",
    tracking: "identifiers;usage_data",
    checked_at: "2026-11-03",
  });
  assert.deepEqual(versions.map((v) => [v.version, v.date]), [["1.2.0", "2026-11-02"], ["1.1.0", "2026-10-09"], ["1.0", "2026-06-02"]]);
  assert.deepEqual(similar.map((s) => [s.position, s.similar_id, s.name, s.developer]), [[1, "111", "Rival One", "Rival Co"], [2, "222", "Rival Two", "Jane Doe"]]);
  assert.equal(prices.length, 3);
});

test("parsePage copes with a page missing the optional shelves", () => {
  const bare = html.replace(/"informationRibbon"[\s\S]*<\/script>/, '"x": {}}}}]}</script>');
  const { page, versions, similar, prices } = parsePage(bare, "1", "2026-11-03");
  assert.equal(page.privacy, "");
  assert.equal(page.size_mb, null);
  assert.equal(page.stars_5, 0);
  assert.deepEqual([versions, similar], [[], []]);
  assert.equal(prices.length, 3);
  assert.throws(() => parsePage("<html></html>", "1", "2026-11-03"), /no page data/);
});

test("versionDate and sizeMb read Apple's formats", () => {
  assert.equal(versionDate("Fri Oct 09 2026 08:00:00 GMT+0000 (Coordinated Universal Time)"), "2026-10-09");
  assert.equal(versionDate("gestern"), "");
  assert.equal(sizeMb("523,7", "MB"), 523.7);
  assert.equal(sizeMb("20.8", "GB"), 21299.2);
  assert.equal(sizeMb("?", "MB"), null);
});

test("lowStarShare ignores apps with too few ratings", () => {
  const page = { stars_5: 70, stars_4: 10, stars_3: 0, stars_2: 5, stars_1: 15 } as PageRow;
  assert.equal(lowStarShare(page), 0.2);
  assert.equal(lowStarShare({ ...page, stars_5: 1, stars_4: 0, stars_2: 0, stars_1: 1 }), null);
});

test("mergeVersions keeps releases from earlier checks and counts recent ones", () => {
  const v = (version: string, date: string): VersionRow => ({ app_id: "a", version, date });
  const saved = new Map([["a", [v("1.0", "2025-01-01")]]]);
  mergeVersions(saved, [v("1.2", "2026-10-30"), v("1.1", "2026-09-01"), v("1.0", "2025-01-01")]);
  assert.deepEqual(saved.get("a")!.map((r) => r.version), ["1.2", "1.1", "1.0"]);
  assert.equal(releasesWithin(saved.get("a")!, "2026-11-03"), 2);
  assert.equal(releasesWithin(saved.get("a")!, "2026-11-03", 30), 1);
});

test("alsoSuggested counts each outside app once per niche app", () => {
  const s = (app_id: string, similar_id: string): SimilarRow => ({ app_id, position: 1, similar_id, name: `App ${similar_id}`, developer: "", checked_at: "" });
  const result = alsoSuggested(
    [[s("a", "x"), s("a", "x"), s("a", "b")], [s("b", "x"), s("b", "y")], [s("c", "y"), s("c", "z")]],
    new Set(["a", "b", "c"]),
  );
  assert.deepEqual(result.map((r) => [r.similar_id, r.apps]), [["x", 2], ["y", 2]]);
});
