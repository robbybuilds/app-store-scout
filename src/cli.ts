#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { fetchChart, lookupApps, sleep } from "./apple.ts";
import { genreName, loadConfig } from "./config.ts";
import { fetchPrices, isStale as pricesStale } from "./prices.ts";
import { fetchPublisher, looksLikeIndividual, isStale as publisherStale } from "./publishers.ts";
import { buildReport } from "./report.ts";
import { fetchNewReviews, isCritical } from "./reviews.ts";
import { type SearchRow, type SearchSummary, searchApps, summariseSearch, topResults } from "./search.ts";
import { computeSignals, researchTargets } from "./signals.ts";
import { DailyLimitReached, fetchVolume, isStale } from "./volume.ts";
import { type ChartRow, Store } from "./store.ts";

const HELP = `app-store-scout: free App Store research from Apple's public feeds

Usage:
  app-store-scout scan   [--country us]               Save today's charts and ratings, then research
  app-store-scout research [--country us]             Only search the top niches and read reviews
  app-store-scout report [--country us] [--archive]   Write reports/<country>/latest.md
  app-store-scout app <app-id> [--country us]         Show one app's chart and ratings history

Options:
  --config <path>   Config file (default: scout.config.json)
  --data <dir>      Data folder (default: data)
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    country: { type: "string" },
    config: { type: "string", default: "scout.config.json" },
    data: { type: "string", default: "data" },
    archive: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const [command, arg] = positionals;
const config = loadConfig(values.config);
const store = new Store(values.data);
const countries = values.country ? [values.country.toLowerCase()] : config.countries;
const today = new Date().toISOString().slice(0, 10);

async function scan(country: string): Promise<void> {
  const rows: ChartRow[] = [];
  let failures = 0;
  let sourceUpdatedAt = "";

  for (const chart of config.charts) {
    for (const genre of config.genres) {
      const label = `${country} ${chart} ${genre.name}`;
      try {
        const result = await fetchChart(country, chart, genre.id);
        for (const e of result.entries) rows.push({ chart, genre_id: genre.id, rank: e.rank, app_id: e.appId });
        if (result.sourceUpdatedAt && result.sourceUpdatedAt > sourceUpdatedAt) sourceUpdatedAt = result.sourceUpdatedAt;
        console.log(`  ${label}: ${result.entries.length} apps`);
      } catch (error) {
        failures++;
        console.error(`  ${label}: failed (${(error as Error).message})`);
      }
      await sleep(300);
    }
  }
  if (!rows.length) throw new Error(`Every chart failed for ${country}; nothing saved.`);

  const ids = [...new Set(rows.map((r) => r.app_id))];
  console.log(`  looking up ${ids.length} apps...`);
  const apps = await lookupApps(country, ids);
  const charts = config.charts.length * config.genres.length;
  store.writeSnapshot(
    country,
    {
      date: today,
      scanned_at: new Date().toISOString(),
      source_updated_at: sourceUpdatedAt,
      charts_ok: charts - failures,
      charts_failed: failures,
      apps: apps.length,
    },
    rows,
    apps,
  );
  console.log(`  saved ${rows.length} chart rows and ${apps.length} apps for ${today}` + (failures ? ` (${failures} charts failed)` : ""));
  await research(country);
}

// Searches the App Store for each top niche and reads the reviews of the apps worth a closer look.
async function research(country: string): Promise<void> {
  const signals = computeSignals(store.recent(country, 30), store.readApps(country));
  const { niches, appIds } = researchTargets(signals, config);

  const summaries: SearchSummary[] = [];
  const top: SearchRow[] = [];
  for (const niche of niches) {
    try {
      const results = await searchApps(country, niche.term);
      summaries.push(summariseSearch(today, niche.term, results, config.report.newAppMaxAgeDays));
      top.push(...topResults(today, niche.term, results));
      console.log(`  search "${niche.term}": ${results.length} results`);
    } catch (error) {
      console.error(`  search "${niche.term}": failed (${(error as Error).message})`);
    }
    // The Search API allows roughly 20 calls a minute.
    await sleep(3000);
  }
  if (summaries.length) store.writeSearch(country, today, summaries, top);

  if (config.research.searchVolume) {
    const volumes = store.readVolumes(country);
    for (const niche of niches.filter((n) => isStale(volumes.get(n.term), today))) {
      try {
        const v = await fetchVolume(niche.term, country, today, process.env.SEODATA_KEY || undefined);
        volumes.set(niche.term, v);
        console.log(`  volume "${v.keyword}": ${v.volume} searches a month`);
      } catch (error) {
        console.error(`  volume "${niche.term}": ${(error as Error).message}`);
        if (error instanceof DailyLimitReached) break;
      }
      await sleep(500);
    }
    store.writeVolumes(country, volumes);
  }

  let added = 0;
  for (const appId of appIds) {
    try {
      const known = new Set(store.readReviews(country, appId).map((r) => r.id));
      const fresh = await fetchNewReviews(country, appId, known, config.research.reviewPages);
      if (fresh.length) store.addReviews(country, appId, fresh);
      added += fresh.length;
      console.log(`  reviews ${appId}: ${fresh.length} new (${fresh.filter(isCritical).length} with 1 to 3 stars)`);
    } catch (error) {
      console.error(`  reviews ${appId}: failed (${(error as Error).message})`);
    }
    await sleep(300);
  }
  // Who makes each researched app: how many other apps its publisher has. Monthly.
  const apps = store.readApps(country);
  const publishers = store.readPublishers(country);
  const publisherIds = [...new Set(appIds.map((id) => apps.get(id)?.publisherId).filter((id): id is string => !!id))];
  for (const id of publisherIds.filter((id) => publisherStale(publishers.get(id), today))) {
    try {
      const p = await fetchPublisher(country, id, today);
      publishers.set(id, p);
      console.log(`  publisher ${p.publisher || id}: ${p.apps} apps`);
    } catch (error) {
      console.error(`  publisher ${id}: failed (${(error as Error).message})`);
    }
    await sleep(300);
  }
  store.writePublishers(country, publishers);

  // What each researched app charges, from its App Store page. Weekly.
  if (config.research.prices) {
    const prices = store.readPrices(country);
    for (const appId of appIds.filter((id) => pricesStale(prices.get(id), today))) {
      try {
        const rows = await fetchPrices(country, appId, today);
        prices.set(appId, rows);
        console.log(`  prices ${appId}: ${rows.filter((r) => r.item).length} in-app purchases`);
      } catch (error) {
        console.error(`  prices ${appId}: failed (${(error as Error).message})`);
      }
      await sleep(1000);
    }
    store.writePrices(country, prices);
  }

  console.log(`  researched ${summaries.length} niches and ${appIds.length} apps (${added} new reviews)`);
}

function report(country: string): void {
  const markdown = buildReport(store, config, country);
  const latest = join("reports", country, "latest.md");
  mkdirSync(dirname(latest), { recursive: true });
  writeFileSync(latest, markdown);
  console.log(`  wrote ${latest}`);
  if (values.archive) {
    const dated = join("reports", country, `${today}.md`);
    writeFileSync(dated, markdown);
    console.log(`  wrote ${dated}`);
  }
}

function showApp(country: string, appId: string): void {
  const details = store.readApps(country).get(appId);
  console.log(details ? `${details.name} by ${details.publisher}\n${details.url}\nReleased ${details.releasedAt}, updated ${details.updatedAt}` : appId);
  if (details?.seller) {
    const person = looksLikeIndividual(details.seller) ? " (looks like an individual developer)" : "";
    const catalogue = store.readPublishers(country).get(details.publisherId);
    console.log(`Seller: ${details.seller}${person}` + (catalogue ? `, ${catalogue.apps} apps in the catalogue` : ""));
  }
  const purchases = (store.readPrices(country).get(appId) ?? []).filter((r) => r.item);
  if (purchases.length) console.log(`In-app purchases: ${purchases.map((r) => `${r.item} ${r.price_text}`).join(", ")}`);
  for (const snap of store.recent(country, 90)) {
    const positions = snap.charts
      .filter((r) => r.app_id === appId)
      .map((r) => `${r.chart} ${genreName(config, r.genre_id)} #${r.rank}`);
    const ratings = snap.ratings.get(appId)?.rating_count;
    console.log(`${snap.date}  ${ratings === undefined ? "" : `${ratings.toLocaleString("en-US")} ratings  `}${positions.join(", ") || "not charting"}`);
  }
  const critical = store.readReviews(country, appId).filter(isCritical);
  if (critical.length) {
    console.log(`\n${critical.length} reviews with 1 to 3 stars, worst first:`);
    for (const r of critical.slice(0, 20)) console.log(`  ${"★".repeat(r.rating)} ${r.date}  ${r.title}: ${r.body.slice(0, 160)}`);
  }
}

async function main(): Promise<void> {
  if (values.help || !command) return void console.log(HELP);
  for (const country of countries) {
    console.log(`${command} ${country}`);
    if (command === "scan") await scan(country);
    else if (command === "research") await research(country);
    else if (command === "report") report(country);
    else if (command === "app" && arg) showApp(country, arg);
    else return void console.log(HELP);
  }
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
