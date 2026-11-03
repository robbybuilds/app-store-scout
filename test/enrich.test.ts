import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  formatPrice,
  isStale as pricesStale,
  pageUrl,
  parsePrice,
  parsePrices,
  periodOf,
  type PriceRow,
  pricingSummary,
} from "../src/prices.ts";
import { catalogueUrl, isStale as publisherStale, looksLikeIndividual, parseCatalogue } from "../src/publishers.ts";

const page = readFileSync(new URL("fixtures/app-page.html", import.meta.url), "utf8");

test("looksLikeIndividual spots a person's name and rejects company names", () => {
  for (const name of [
    "Neil Crutchlow", "HONGBO WANG", "群群 刘", "Mark Granger", "Angel Vazquez", "Felipe Marques de Barros",
    "Jean-Paul Lanaux", "Matteo Dall'Ombra", "Anand Raj R", "Yaniv van der Stigchel",
  ]) {
    assert.ok(looksLikeIndividual(name), name);
  }
  for (const name of [
    "TEGS LABS LTD", "Wikibuy, LLC", "Lightricks Ltd.", "Western Governors University", "Stroller AB",
    "Mosaic S.r.l.", "Skyship Entertainment Company", "Tantsissa", "1st Phorm International, LLC", "",
    // Seen on the charts: legal forms written every which way, brands and institutions.
    "Anthropic PBC", "Chani Nicholas Incorporated", "Labhouse Mobile SL", "GRIMLAX TRADE,S.L.", "NarrativeLab OU",
    "Appercut Sp. z o.o.", "Frameo A/S", "Telegram FZ-LLC", "INNOVATIVE CONNECTING PTE.LIMITED", "PT SANDI DAYA GUNA",
    "Rocket Money", "Simon & Schuster", "CBS Mobile", "LG Electronics", "Citibank, N.A.", "Khan Academy",
    "Internal Revenue Service", "Core of the Heart", "Logical Images", "Sesame Workshop (Apps)",
  ]) {
    assert.ok(!looksLikeIndividual(name), name);
  }
});

test("parseCatalogue counts a publisher's apps and ratings, ignoring other publishers", () => {
  const json = {
    results: [
      { wrapperType: "artist", artistId: 42, artistName: "Jane Doe" },
      { wrapperType: "software", artistId: 42, userRatingCount: 120 },
      { wrapperType: "software", artistId: 42, userRatingCount: 30 },
      { wrapperType: "software", artistId: 7, userRatingCount: 9999 },
    ],
  };
  assert.deepEqual(parseCatalogue(json, "42", "2026-11-02"), {
    publisher_id: "42",
    publisher: "Jane Doe",
    apps: 2,
    total_ratings: 150,
    checked_at: "2026-11-02",
  });
  assert.equal(
    catalogueUrl("us", "42"),
    "https://itunes.apple.com/lookup?id=42&entity=software&limit=200&country=us",
  );
});

test("publishers are rechecked after 30 days", () => {
  const p = { publisher_id: "1", publisher: "", apps: 1, total_ratings: 0, checked_at: "2026-10-01" };
  assert.ok(publisherStale(undefined, "2026-11-02"));
  assert.ok(!publisherStale(p, "2026-10-30"));
  assert.ok(publisherStale(p, "2026-10-31"));
});

test("parsePrice reads prices in any currency format and rejects other text", () => {
  assert.equal(parsePrice("$39.99"), 39.99);
  assert.equal(parsePrice("£4.99"), 4.99);
  assert.equal(parsePrice("39,99 €"), 39.99);
  assert.equal(parsePrice("¥1,200"), 1200);
  assert.equal(parsePrice("1.299,00 kr"), 1299);
  assert.equal(parsePrice("R$ 19,90"), 19.9);
  assert.equal(parsePrice("CHF 12.00"), 12);
  assert.equal(parsePrice("Requires iOS 16.4 or later."), null);
  assert.equal(parsePrice("Yes"), null);
});

test("formatPrice copies the currency and decimal style of a sample", () => {
  assert.equal(formatPrice("$39.99", 42), "$42.00");
  assert.equal(formatPrice("39,99 €", 29.5), "29,50 €");
  assert.equal(formatPrice("¥1,200", 980), "¥980");
});

test("periodOf reads the plan length from the purchase's name", () => {
  assert.equal(periodOf("Yearly Subscription"), "yearly");
  assert.equal(periodOf("Annual Plan"), "yearly");
  assert.equal(periodOf("12 Months Premium"), "yearly");
  assert.equal(periodOf("Monthly Membership"), "monthly");
  assert.equal(periodOf("1 Month"), "monthly");
  assert.equal(periodOf("Pro Weekly"), "weekly");
  assert.equal(periodOf("Lifetime Access"), "lifetime");
  assert.equal(periodOf("6 Months"), "other");
  assert.equal(periodOf("1000 Coins"), "other");
});

test("parsePrices finds the purchase list by its shape and drops repeats", () => {
  const rows = parsePrices(page, "6777471316", "2026-11-02");
  assert.deepEqual(
    rows.map((r) => [r.item, r.price, r.price_text, r.period]),
    [
      ["Yearly Subscription", 39.99, "$39.99", "yearly"],
      ["Monthly Membership", 9.99, "$9.99", "monthly"],
      ["Lifetime Access", 99.99, "$99.99", "lifetime"],
    ],
  );
  assert.equal(pageUrl("us", "6777471316"), "https://apps.apple.com/us/app/id6777471316");
});

test("parsePrices returns nothing for an app with no purchases and throws on an unknown page", () => {
  const free = page.replace(/"In-App Purchases"[\s\S]*?\]\}/, '"In-App Purchases", "summary": "No", "items": []}');
  assert.deepEqual(parsePrices(free, "1", "2026-11-02"), []);
  assert.throws(() => parsePrices("<html></html>", "1", "2026-11-02"), /no page data/);
});

function row(app_id: string, item: string, price: number | null, period: PriceRow["period"]): PriceRow {
  return { app_id, item, price, price_text: price === null ? "" : `$${price.toFixed(2)}`, period, checked_at: "2026-11-02" };
}

test("pricingSummary counts each app once per period", () => {
  const summary = pricingSummary([
    [row("a", "Yearly", 20, "yearly"), row("a", "Yearly Pro", 60, "yearly"), row("a", "Monthly", 5, "monthly")],
    [row("b", "Annual", 30, "yearly")],
    [row("c", "", null, "")],
    [],
  ]);
  assert.equal(summary.checked, 3);
  assert.equal(summary.selling, 2);
  assert.deepEqual(summary.periods.map((p) => [p.period, p.apps, p.median, p.min, p.max]), [
    ["monthly", 1, 5, 5, 5],
    // App a's own median is 40, app b's is 30.
    ["yearly", 2, 35, 20, 60],
  ]);
});

test("prices are rechecked after a week", () => {
  assert.ok(pricesStale(undefined, "2026-11-02"));
  assert.ok(!pricesStale([row("a", "", null, "")], "2026-11-08"));
  assert.ok(pricesStale([row("a", "", null, "")], "2026-11-09"));
});
