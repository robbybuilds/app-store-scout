import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { chartUrl, parseChart, parseLookup } from "../src/apple.ts";
import { parseCsv, toCsv } from "../src/csv.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8"));

test("chartUrl builds overall and genre chart urls", () => {
  assert.equal(chartUrl("us", "top-grossing", 0), "https://itunes.apple.com/us/rss/topgrossingapplications/limit=100/json");
  assert.equal(chartUrl("gb", "top-free", 6013), "https://itunes.apple.com/gb/rss/topfreeapplications/limit=100/genre=6013/json");
});

test("parseChart reads ranks, ids and the feed timestamp", () => {
  const result = parseChart(fixture("chart.json"));
  assert.equal(result.entries.length, 2);
  assert.deepEqual(result.entries[0], {
    rank: 1,
    appId: "341232718",
    name: "MyFitnessPal: Calorie Counter",
    publisher: "MyFitnessPal, Inc.",
    genreId: 6013,
  });
  assert.equal(result.entries[1].rank, 2);
  assert.equal(result.sourceUpdatedAt, "2026-11-02T13:49:42.000Z");
});

test("parseChart handles a single entry object and an empty feed", () => {
  const single = fixture("chart.json");
  single.feed.entry = single.feed.entry[0];
  assert.equal(parseChart(single).entries.length, 1);
  assert.deepEqual(parseChart({ feed: {} }).entries, []);
});

test("parseLookup keeps the fields we track", () => {
  const [app] = parseLookup(fixture("lookup.json"));
  assert.equal(app.appId, "6448311069");
  assert.equal(app.name, "ChatGPT");
  assert.equal(app.releasedAt, "2023-05-18");
  assert.ok(app.ratingCount > 0);
  assert.ok(!app.url.includes("?"));
});

test("csv round-trips commas, quotes and newlines", () => {
  const rows = [{ a: 'Say "hi", world', b: "line\nbreak" }, { a: "plain", b: "" }];
  assert.deepEqual(parseCsv(toCsv(["a", "b"], rows)), rows);
});
