import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { AppDetails } from "../src/apple.ts";
import { complaintThemes, parseReviews, type Review, reviewsUrl, sortCriticalFirst } from "../src/reviews.ts";
import { searchUrl, summariseSearch, topResults } from "../src/search.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8"));

function review(id: string, rating: number, date: string, body = ""): Review {
  return { id, rating, version: "1.0", date, title: "", body };
}

test("reviewsUrl points at the most recent reviews feed", () => {
  assert.equal(
    reviewsUrl("us", "123", 2),
    "https://itunes.apple.com/us/rss/customerreviews/page=2/id=123/sortby=mostrecent/json",
  );
});

test("parseReviews reads ratings, text and the last page, without reviewer names", () => {
  const { reviews, lastPage } = parseReviews(fixture("reviews.json"));
  assert.equal(reviews.length, 3);
  assert.deepEqual(
    reviews.map((r) => r.rating),
    [1, 2, 5],
  );
  assert.equal(reviews[1].title, "Not honest with prices");
  assert.match(reviews[0].date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(lastPage >= 1 && lastPage <= 10);
  assert.ok(!("author" in reviews[0]));
});

test("parseReviews skips the app entry some feeds lead with, and handles an empty feed", () => {
  const appEntry = { id: { label: "999" }, "im:name": { label: "Some app" } };
  const one = { id: { label: "1" }, "im:rating": { label: "4" }, title: { label: "Nice" }, content: { label: "Good\n app" } };
  const { reviews } = parseReviews({ feed: { entry: [appEntry, one] } });
  assert.deepEqual(reviews.map((r) => [r.id, r.body]), [["1", "Good app"]]);
  assert.deepEqual(parseReviews({ feed: {} }).reviews, []);
});

test("sortCriticalFirst puts 1, 2 and 3 star reviews first, newest first within a rating", () => {
  const sorted = sortCriticalFirst([
    review("a", 5, "2026-11-01"),
    review("b", 3, "2026-10-01"),
    review("c", 1, "2026-09-01"),
    review("d", 1, "2026-10-15"),
    review("e", 2, "2026-11-01"),
  ]);
  assert.deepEqual(sorted.map((r) => r.id), ["d", "c", "e", "b", "a"]);
});

test("complaintThemes counts themes in 1 to 3 star reviews only", () => {
  const { critical, themes } = complaintThemes([
    review("1", 1, "2026-11-01", "Charged me after I cancelled the free trial"),
    review("2", 2, "2026-11-01", "Keeps crashing and the subscription is too expensive"),
    review("3", 3, "2026-11-01", "Wish it had a shopping list"),
    review("4", 5, "2026-11-01", "Worth every penny of the subscription"),
  ]);
  assert.equal(critical, 3);
  assert.deepEqual(themes[0], { name: "Price and subscription", count: 2, share: 2 / 3 });
  assert.ok(themes.some((t) => t.name === "Bugs and crashes" && t.count === 1));
  assert.ok(themes.some((t) => t.name === "Missing features" && t.count === 1));
});

function result(appId: string, ratingCount: number, releasedAt: string): AppDetails {
  return {
    appId, name: `App ${appId}`, publisher: "Pub", publisherId: "1", primaryGenre: "Food & Drink",
    price: 0, ratingCount, averageRating: 4.5, releasedAt, updatedAt: releasedAt, url: "",
  };
}

test("searchUrl encodes the term", () => {
  assert.equal(
    searchUrl("us", "meal planner"),
    "https://itunes.apple.com/search?term=meal+planner&entity=software&country=us&limit=200",
  );
});

test("summariseSearch measures how crowded a search is", () => {
  const results = [
    result("1", 250_000, "2015-01-01"),
    result("2", 12_000, "2020-01-01"),
    result("3", 300, "2026-07-01"),
    result("4", 40, "2026-10-01"),
  ];
  assert.deepEqual(summariseSearch("2026-11-02", "meal planner", results), {
    date: "2026-11-02",
    term: "meal planner",
    results: 4,
    established: 2,
    new_apps: 2,
    top10_median_ratings: 6150,
  });
  assert.deepEqual(
    topResults("2026-11-02", "meal planner", results, 2).map((r) => [r.position, r.app_id]),
    [[1, "1"], [2, "2"]],
  );
});
