// The public website: plain HTML pages built from the same data as the reports. A home page,
// one page per country, one per niche ever researched and one per researched app, plus a
// sitemap. No dependencies and no client framework, so GitHub Pages can serve it for free.
// The look comes from web/ (designed with Hallmark's Hum theme); this file only writes markup.

import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AppDetails } from "./apple.ts";
import { type Config, genreName } from "./config.ts";
import { alsoSuggested, lowStarShare, type PageRow, releasesWithin, totalStars } from "./pages.ts";
import { formatPrice, type PriceRow, pricingSummary } from "./prices.ts";
import { looksLikeIndividual } from "./publishers.ts";
import { complaintThemes, isCritical } from "./reviews.ts";
import {
  type AppSignal,
  type Cluster,
  computeSignals,
  daysBetween,
  genreSummaries,
  neglectedEarners,
  newAndPaying,
  researchTargets,
  smallAndPaying,
  soloAndPaying,
} from "./signals.ts";
import { SEARCH_SCRIPT, searchIndex } from "./site-search.ts";
import type { NicheHistory, Snapshot, Store } from "./store.ts";

export interface SiteOptions {
  /** Where the site is served, e.g. https://robbybuilds.github.io/app-store-scout */
  url: string;
  /** "owner/name" on GitHub, for the links back to the code and the data. */
  repo: string;
  out: string;
  /** The stylesheets (web/ in the repo). */
  assets: string;
}

export const COUNTRY_NAMES: Record<string, string> = {
  us: "United States", gb: "United Kingdom", ca: "Canada", au: "Australia", de: "Germany", fr: "France",
  jp: "Japan", kr: "South Korea", in: "India", br: "Brazil", es: "Spain", it: "Italy", nl: "Netherlands",
  mx: "Mexico", se: "Sweden", cn: "China",
};
const countryName = (c: string) => COUNTRY_NAMES[c] ?? c.toUpperCase();
const SHORT_NAMES: Record<string, string> = { us: "US", gb: "UK" };
const shortName = (c: string) => SHORT_NAMES[c] ?? countryName(c);

const esc = (text: unknown) =>
  String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (n: number) => n.toLocaleString("en-US");
/** An app's title exactly as Apple lists it. */
const title = (s: { details?: AppDetails; appId: string } | undefined, fallback = "") => s?.details?.name ?? fallback;
const pct = (share: number) => `${Math.round(share * 100)}%`;
const plural = (n: number, word: string, many = `${word}s`) => `${num(n)} ${n === 1 ? word : many}`;

export function slug(term: string): string {
  return term.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "niche";
}

/** "2026-11-03" → "3 November 2026". */
export function longDate(date: string): string {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

/**
 * A torn edge for a cut sheet, from seeded noise so every build tears the same way.
 * Returns a clip-path polygon whose top and bottom edges wobble by up to `amp` pixels.
 */
export function tear(seed: number, amp = 7, steps = 36, bottomAmp = amp): string {
  let s = seed >>> 0 || 1;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const edge = (a: number) => Array.from({ length: steps + 1 }, () => Math.round(rand() * a * 10) / 10);
  const top = edge(amp);
  const bottom = edge(bottomAmp);
  const points = [
    ...top.map((y, i) => `${((i / steps) * 100).toFixed(2)}% ${y}px`),
    ...bottom.map((y, i) => `${(100 - (i / steps) * 100).toFixed(2)}% calc(100% - ${y}px)`),
  ];
  return `polygon(${points.join(", ")})`;
}

interface Ctx {
  store: Store;
  config: Config;
  opts: SiteOptions;
  base: string;
  /** Researched app pages that exist, so links can stay on the site. */
  appPages: Set<string>;
  nichePages: Map<string, string>;
  pages: { path: string; lastmod: string }[];
}

const href = (ctx: Ctx, path: string) => `${ctx.base}${path}`;
const appStore = (country: string, id: string) => `https://apps.apple.com/${country}/app/id${id}`;

function appHref(ctx: Ctx, country: string, id: string): string {
  return country === primary(ctx) && ctx.appPages.has(id) ? href(ctx, `/apps/${id}/`) : appStore(country, id);
}

const primary = (ctx: Ctx) => ctx.config.research.countries[0] ?? ctx.config.countries[0];
const rankText = (ctx: Ctx, s: AppSignal) =>
  s.grossing ? `#${s.grossing.rank} ${genreName(ctx.config, s.grossing.genreId)}` : "not on a grossing chart";

interface PageSpec {
  path: string;
  title: string;
  description: string;
  body: string;
  date: string;
  current?: string;
  jsonLd?: object[];
  noindex?: boolean;
  /** The home page has its own stylesheet; every reference page shares data.css. */
  stylesheet?: "style.css" | "data.css";
}

function layout(ctx: Ctx, p: PageSpec): string {
  const canonical = `${ctx.opts.url}${p.path}`;
  const nav = [
    ["/search/", "Search", ""],
    ["/niches/", "Niches", ""],
    ["/countries/", "Countries", "hide-xs"],
    ["/about/", "How it works", "hide-s"],
  ]
    .map(([path, label, cls]) => {
      const current = p.current === path ? ' aria-current="page"' : "";
      return `<li${cls ? ` class="${cls}"` : ""}><a href="${href(ctx, path)}"${current}>${label}</a></li>`;
    })
    .join("");
  const ld = (p.jsonLd ?? []).map((o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, "\\u003c")}</script>`).join("\n");
  return `<!doctype html>
<html lang="en" class="no-js">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(p.title)}</title>
<meta name="description" content="${esc(p.description)}">
<link rel="canonical" href="${esc(canonical)}">
${p.noindex ? '<meta name="robots" content="noindex">\n' : ""}<meta property="og:type" content="website">
<meta property="og:title" content="${esc(p.title)}">
<meta property="og:description" content="${esc(p.description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:site_name" content="App Store Scout">
<meta name="twitter:card" content="summary">
<link rel="icon" href="${href(ctx, "/assets/favicon.svg")}" type="image/svg+xml">
<link rel="preconnect" href="https://api.fontshare.com">
<link rel="stylesheet" href="https://api.fontshare.com/v2/css?f[]=chillax@500,600&amp;display=swap">
<link rel="stylesheet" href="${href(ctx, `/assets/${p.stylesheet ?? "data.css"}`)}">
<script>document.documentElement.classList.replace("no-js", "js")</script>
${ld}
</head>
<body>
<a class="skip" href="#main">Skip to the content</a>
<div class="banner"><div class="container"><span>Updated from Apple’s charts on <time datetime="${p.date}">${longDate(p.date)}</time>.</span> <a class="nowrap" href="${href(ctx, "/about/")}">How Scout works</a></div></div>
<header class="bar"><div class="container">
<a class="wordmark" href="${href(ctx, "/")}" aria-label="App Store Scout, home">Scout</a>
<nav aria-label="Main"><ul class="nav">${nav}<li><a href="https://github.com/${esc(ctx.opts.repo)}">GitHub</a></li></ul></nav>
</div></header>
<main id="main">
${p.body}
</main>
<footer class="footer" style="--tear: ${tear(41, 9, 48, 0)}"><div class="container">
<p class="mast" aria-hidden="true">Scout</p>
<ul>
<li><a href="${href(ctx, "/niches/")}">Every niche</a></li>
<li><a href="${href(ctx, "/countries/")}">Countries</a></li>
<li><a href="${href(ctx, "/about/")}">How it works</a></li>
<li><a href="https://github.com/${esc(ctx.opts.repo)}">The code</a></li>
<li><a href="https://github.com/${esc(ctx.opts.repo)}/tree/main/data">The data, as CSV</a></li>
</ul>
<p>App Store Scout is free and open source (MIT). It isn’t affiliated with Apple. Ranks and ratings come from Apple’s public feeds and are not downloads or revenue.</p>
</div></footer>
<script>
for (const f of document.querySelectorAll("[data-switch]")) {
  const panels = document.querySelectorAll(\`[data-panel="\${f.dataset.switch}"]\`);
  const show = (v) => panels.forEach((p) => p.classList.toggle("on", p.dataset.value === v));
  f.addEventListener("change", (e) => show(e.target.value));
  show(f.querySelector("input:checked")?.value);
}
</script>
</body>
</html>
`;
}

function write(ctx: Ctx, p: PageSpec): void {
  const file = join(ctx.opts.out, p.path, "index.html");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, layout(ctx, p));
  if (!p.noindex) ctx.pages.push({ path: p.path, lastmod: p.date });
}

function crumbs(ctx: Ctx, trail: [string, string][]): { html: string; ld: object } {
  const html = `<ol class="crumbs">${trail
    .map(([path, label], i) => (i < trail.length - 1 ? `<li><a href="${href(ctx, path)}">${esc(label)}</a></li>` : `<li aria-current="page">${esc(label)}</li>`))
    .join("")}</ol>`;
  const ld = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: trail.map(([path, label], i) => ({ "@type": "ListItem", position: i + 1, name: label, item: `${ctx.opts.url}${path}` })),
  };
  return { html, ld };
}

/** A titled part of a document page. Tables take the full width with the title above; prose keeps it beside. */
function block(title: string, body: string, wide = false): string {
  return `<section class="block${wide ? " block--table" : ""}"><div class="container"><h2>${esc(title)}</h2><div class="body">${body}</div></div></section>`;
}

function summary(items: [string, string][]): string {
  return `<dl class="summary">${items.map(([v, label]) => `<div><dt>${esc(label)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>`;
}

/** The yearly price a niche's apps charge, as the page shows it, or "". */
function yearlyPrice(prices: PriceRow[][]): string {
  const yearly = pricingSummary(prices).periods.find((p) => p.period === "yearly");
  return yearly ? formatPrice(yearly.sample, yearly.median) : "";
}

interface CountryData {
  country: string;
  snapshots: Snapshot[];
  date: string;
  signals: AppSignal[];
  bySignal: Map<string, AppSignal>;
  apps: Map<string, AppDetails>;
  niches: Cluster[];
}

function countryData(store: Store, config: Config, country: string): CountryData | null {
  const snapshots = store.recent(country, 30);
  const latest = snapshots.at(-1);
  if (!latest) return null;
  const apps = store.readApps(country);
  const signals = computeSignals(snapshots, apps);
  return {
    country,
    snapshots,
    date: latest.date,
    signals,
    bySignal: new Map(signals.map((s) => [s.appId, s])),
    apps,
    niches: researchTargets(signals, config).niches,
  };
}

/** A signal for an app that may have left the charts since, so older niches still have rows. */
function signalOf(d: CountryData, id: string): AppSignal | null {
  const charted = d.bySignal.get(id);
  if (charted) return charted;
  const details = d.apps.get(id);
  if (!details) return null;
  return {
    appId: id, details, grossing: null, best: null, grossingRankChange7: null, daysOnChart: 0, windowDays: 0,
    ratingCount: details.ratingCount ?? null, ratingDelta7: null,
    ageDays: details.releasedAt ? daysBetween(details.releasedAt.slice(0, 10), d.date) : null,
  };
}

function appRows(ctx: Ctx, d: CountryData, rows: AppSignal[], extra?: { title: string; value: (s: AppSignal) => string }): string {
  if (!rows.length) return `<p class="muted">Nothing matched today.</p>`;
  const body = rows
    .map(
      (s) =>
        `<tr><td><a href="${appHref(ctx, d.country, s.appId)}">${esc(title(s, s.appId))}</a></td>` +
        `<td class="hide-xs">${esc(s.details?.publisher ?? "")}</td><td>${esc(s.grossing ? rankText(ctx, s) : "")}</td>` +
        (extra ? `<td class="n">${esc(extra.value(s))}</td>` : "") +
        `<td class="n hide-xs">${s.ratingCount === null ? "" : num(s.ratingCount)}</td></tr>`,
    )
    .join("");
  return `<div class="table-wrap"><table class="data"><thead><tr><th>App</th><th class="hide-xs">Publisher</th><th>Top grossing</th>${extra ? `<th class="n">${esc(extra.title)}</th>` : ""}<th class="n hide-xs">Ratings</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

// ---------------------------------------------------------------------------------------------
// Home

function homePage(ctx: Ctx, d: CountryData, all: CountryData[], history: NicheHistory[]): void {
  const { store, config } = ctx;
  const prices = store.readPrices(d.country);
  const scans = d.snapshots.at(-1)!;
  const appsToday = new Set(scans.charts.map((r) => r.app_id)).size;
  const niches = d.niches;

  // The day's biggest niches get the biggest tiles, so the strip reads like a ranking.
  const order = [...niches].sort((a, b) => b.publishers - a.publishers);
  const size = (c: Cluster) => { const r = order.indexOf(c); return r === 0 ? " tile--lead" : r < 4 ? " tile--big" : ""; };
  // The worst-review theme most niches share, said once, so each card only notes a different one.
  const themeOf = (c: Cluster) => complaintThemes(c.apps.flatMap((s) => store.readReviews(d.country, s.appId))).themes[0]?.name;
  const themes = new Map(niches.map((c) => [c.term, themeOf(c)]));
  const counts = new Map<string, number>();
  for (const t of themes.values()) if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
  const common = [...counts].sort((a, b) => b[1] - a[1])[0];
  const tiles = niches
    .map(
      (c, i) =>
        `<li style="--i: ${i}"><a class="tile tile--${i % 4}${size(c)}" href="${href(ctx, `/niches/${slug(c.term)}/`)}"><b>${esc(c.term)}</b><span>${plural(c.publishers, "publisher")}</span></a></li>`,
    )
    .join("");

  const hero = `<section class="hero" aria-labelledby="hero-title"><div class="container">
<div class="intro">
<h1 id="hero-title">Where small apps earn today.</h1>
<div class="side"><p class="lead">A free daily read of Apple’s charts, made for indie app makers.</p>
<div class="actions"><a class="btn btn--primary" href="#niches">See today’s niches</a><a class="btn" href="https://github.com/${esc(ctx.opts.repo)}">Star it on GitHub</a></div></div>
</div>
<figure class="board-figure">
<div class="mat sheet sheet--sugar" style="--tear: ${tear(29, 5)}" aria-hidden="true"><i class="fill"></i></div>
<div class="board sheet sheet--kraft" style="--tear: ${tear(11)}"><i class="fill" aria-hidden="true"></i>
<ul class="tiles" aria-label="Today’s niches">${tiles}</ul></div>
<figcaption>Today’s ${shortName(d.country)} niches, biggest first in size: each phrase is shared by three or more publishers on a top-grossing chart.</figcaption>
</figure>
</div></section>`;

  const cards = niches
    .map((c) => {
      const top = c.apps.slice(0, 3).map((s) => `<li><a href="${appHref(ctx, d.country, s.appId)}">${esc(title(s, s.appId))}</a><span class="rank">${esc(rankText(ctx, s))}</span></li>`).join("");
      const theme = themes.get(c.term);
      const price = yearlyPrice(c.apps.map((s) => prices.get(s.appId) ?? []));
      const facts = [
        price ? `Yearly plans around ${price}.` : "",
        theme && theme !== common?.[0] ? `Most complaints: ${theme.toLowerCase()}.` : "",
      ].filter(Boolean).join(" ");
      return `<li class="card"><div class="card-top"><h3><a href="${href(ctx, `/niches/${slug(c.term)}/`)}">${esc(c.term)}</a></h3><span class="count">${plural(c.publishers, "publisher")}</span></div>
<ul class="apps-list">${top}</ul>${facts ? `<p class="fact">${esc(facts)}</p>` : ""}</li>`;
    })
    .join("");

  const stack = `<section class="section" id="niches" aria-labelledby="niches-title"><div class="container stack">
<div class="pane"><h2 id="niches-title">Today’s ${niches.length === 10 ? "ten" : num(niches.length)} niches</h2>
<p class="lead">Unrelated publishers, one idea, all earning. One app can be luck; three is a niche.</p>
${common && common[1] > 1 ? `<p class="fact">In ${num(common[1])} of them, unhappy reviewers mostly complain about ${esc(common[0].toLowerCase())}.</p>` : ""}
<p><a class="link" href="${href(ctx, "/niches/")}">Every niche so far</a></p></div>
<ul class="cards cards--two">${cards}</ul>
</div></section>`;

  const solo = soloAndPaying(d.signals).slice(0, 6);
  const soloCards = solo
    .map(
      (s) =>
        `<li class="card card--small"><h3><a href="${appHref(ctx, d.country, s.appId)}">${esc(title(s, s.appId))}</a></h3>
<p class="fact">${esc(`By ${s.details?.seller ?? ""}. ${rankText(ctx, s)}${s.ratingCount === null ? "" : `, ${plural(s.ratingCount, "rating")}`}.`)}</p></li>`,
    )
    .join("");
  const soloSection = solo.length
    ? `<section class="section section--paper2" aria-labelledby="solo-title"><div class="container stack stack--flip">
<div class="pane"><h2 id="solo-title">Built by one person</h2>
<p class="lead">Sold under a developer’s own name, and on a top-grossing chart today.</p>
<p><a class="link" href="${href(ctx, `/countries/${d.country}/`)}">The full ${shortName(d.country)} list</a></p></div>
<ul class="cards cards--two">${soloCards}</ul>
</div></section>`
    : "";

  const figures = `<section class="section section--s pear torn" style="--tear: ${tear(23, 9, 48)}" aria-labelledby="figures-title"><div class="container">
<div class="head"><h2 id="figures-title">Every App Store top 100, every morning</h2></div>
<dl class="figures">
<div><dt>categories</dt><dd>${new Set(scans.charts.map((r) => r.genre_id)).size}</dd></div>
<div><dt>${all.length === 1 ? "country" : "countries"}</dt><dd>${all.length}</dd></div>
<div><dt>charts each</dt><dd>${config.charts.length}</dd></div>
<div><dt>${shortName(d.country)} apps today</dt><dd>${num(appsToday)}</dd></div>
</dl>
<p class="note">Scout runs at 14:00 UTC on GitHub’s free runners and saves every result as CSV. Fork the repo and the data is yours.</p>
</div></section>`;

  const others = all.filter((c) => c.country !== d.country);
  const pills = others
    .map((c, i) => `<input type="radio" name="country" id="c-${c.country}" value="${c.country}"${i === 0 ? " checked" : ""}><label for="c-${c.country}">${esc(shortName(c.country))}</label>`)
    .join("");
  const panels = others
    .map((c) => {
      const terms = c.niches.slice(0, 4).map((n, i) => `<li><span class="tile tile--${(i + 1) % 4}"><b>${esc(n.term)}</b><span>${plural(n.publishers, "publisher")}</span></span></li>`).join("");
      const small = smallAndPaying(c.signals, config);
      const examples = small.slice(0, 3).map((s) => `<li><a href="${appStore(c.country, s.appId)}">${esc(title(s, s.appId))}</a><span class="rank">${esc(rankText(ctx, s))}</span></li>`).join("");
      return `<div class="country" data-panel="country" data-value="${c.country}"><div class="side"><h3>${esc(countryName(c.country))}</h3><ul class="tiles">${terms || "<li class=\"muted\">No niches today.</li>"}</ul></div>
<div class="side"><p>${plural(small.length, "app")} with under ${num(config.report.smallAppMaxRatings)} ratings are on a top-grossing chart. The highest placed:</p><ul class="apps-list">${examples}</ul>
<p><a class="link" href="${href(ctx, `/countries/${c.country}/`)}">Open the ${esc(shortName(c.country))} page</a></p></div></div>`;
    })
    .join("");
  // Shown once a second country has data; a fresh fork or a one-country config skips it.
  const countries = !others.length ? "" : `<section class="section" aria-labelledby="countries-title"><div class="container">
<div class="head"><h2 id="countries-title">${["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"][others.length - 1] ?? num(others.length)} more App Store${others.length === 1 ? "" : "s"}</h2><p class="lead">The same scan in each country. Pick one.</p></div>
<fieldset class="seg" data-switch="country"><legend>Country</legend>${pills}</fieldset>
<div class="panels">${panels}</div>
</div></section>`;

  const rows = history
    .slice(0, 12)
    .map(
      (h) =>
        `<tr><td><a href="${href(ctx, `/niches/${slug(h.term)}/`)}">${esc(h.term)}</a></td><td class="hide-xs">${longDate(h.firstSeen)}</td><td class="n">${plural(h.daysSeen, "day")}</td><td class="n">${num(h.appIds.length)}</td></tr>`,
    )
    .join("");
  const archive = history.length
    ? `<section class="section section--paper2" aria-labelledby="archive-title"><div class="container">
<div class="head"><h2 id="archive-title">Every niche so far</h2><p class="lead">Scout keeps each niche it has researched, with the day it first turned up.</p></div>
<div class="table-wrap"><table class="index"><thead><tr><th>Niche</th><th class="hide-xs">First spotted</th><th class="n">Seen on</th><th class="n">Apps in it</th></tr></thead><tbody>${rows}</tbody></table></div>
<p class="after"><a class="link" href="${href(ctx, "/niches/")}">All ${plural(history.length, "niche")}</a></p>
</div></section>`
    : "";

  write(ctx, {
    path: "/",
    stylesheet: "style.css",
    title: "App Store Scout: where small apps earn today",
    description: `A free, open-source daily scan of Apple’s App Store charts in ${config.countries.length} countries: the niches where new and small apps earn, with prices, ratings and complaints.`,
    date: d.date,
    body: hero + stack + soloSection + figures + countries + archive,
    jsonLd: [
      {
        "@context": "https://schema.org",
        "@type": "WebSite",
        name: "App Store Scout",
        url: `${ctx.opts.url}/`,
        potentialAction: { "@type": "SearchAction", target: `${ctx.opts.url}/search/?q={query}`, "query-input": "required name=query" },
      },
      {
        "@context": "https://schema.org",
        "@type": "Dataset",
        name: "App Store Scout daily chart snapshots",
        description: `Daily snapshots of Apple’s top free, paid and grossing App Store charts in ${config.genres.length} categories and ${config.countries.length} countries, with ratings, prices, reviews and the niches they point to.`,
        url: `${ctx.opts.url}/`,
        license: "https://opensource.org/licenses/MIT",
        isAccessibleForFree: true,
        creator: { "@type": "Organization", name: "App Store Scout", url: `https://github.com/${ctx.opts.repo}` },
        spatialCoverage: config.countries.map(countryName),
        dateModified: d.date,
        distribution: [{ "@type": "DataDownload", encodingFormat: "text/csv", contentUrl: `https://github.com/${ctx.opts.repo}/tree/main/data` }],
      },
    ],
  });
}

// ---------------------------------------------------------------------------------------------
// Niches

function nichePage(ctx: Ctx, d: CountryData, h: NicheHistory, today: Cluster | undefined, related: string[]): void {
  const { store, config } = ctx;
  const apps = (today?.apps ?? h.appIds.map((id) => signalOf(d, id)).filter((s): s is AppSignal => !!s));
  if (!apps.length) return;
  const term = h.term;
  const pages = store.readPages(d.country);
  const prices = store.readPrices(d.country);
  const search = store.readSearch(d.country).get(term);
  const volume = store.readVolumes(d.country).get(term);
  const similar = store.readSimilar(d.country);
  const publishers = new Set(apps.map((s) => s.details?.publisherId ?? s.appId)).size;
  const live = h.lastSeen === d.date;

  const shares = apps.map((s) => pages.get(s.appId)).filter((p): p is PageRow => !!p).map((p) => lowStarShare(p)).filter((v): v is number => v !== null).sort((a, b) => a - b);
  const medianLow = shares.length ? shares[Math.floor(shares.length / 2)] : null;
  const price = yearlyPrice(apps.map((s) => prices.get(s.appId) ?? []));
  const heading = `${term.charAt(0).toUpperCase()}${term.slice(1)} apps`;
  const trail = crumbs(ctx, [["/", "Home"], ["/niches/", "Niches"], [`/niches/${slug(term)}/`, term]]);

  const seen = live
    ? `Spotted on ${longDate(h.firstSeen)} and seen on ${plural(h.daysSeen, "day")} so far.`
    : `Last seen on ${longDate(h.lastSeen)}, after ${plural(h.daysSeen, "day")}. These are the apps from that day.`;
  const head = `<section class="doc-head"><div class="container">${trail.html}
<h1>${esc(heading)} earning on the App Store</h1>
<p class="lead">${esc(`Unrelated publishers ${live ? "with" : "that had"} a ${term} app on a ${shortName(d.country)} top-grossing chart. ${seen}`)}</p>
${summary([
  [num(publishers), "publishers"],
  [price || "not listed", "median yearly plan"],
  [medianLow === null ? "too few" : pct(medianLow), "1 and 2 star ratings"],
  [search ? (search.summary.results >= 200 ? "200+" : num(search.summary.results)) : "not searched", "App Store search results"],
])}
</div></section>`;

  const table = appRows(ctx, d, apps, { title: "Released", value: (s) => s.details?.releasedAt?.slice(0, 10) ?? "" });

  let searchBody = "";
  if (search) {
    const { results, established, new_apps, top10_median_ratings } = search.summary;
    searchBody += `<p>A search for “${esc(term)}” returns ${results >= 200 ? "200 or more" : num(results)} apps. ${num(established)} of them have 10,000+ ratings and ${num(new_apps)} came out in the last year. The top 10 have a median of ${num(top10_median_ratings)} ratings, which is roughly what it takes to show up.</p>`;
    if (search.top.length) {
      searchBody += `<ol class="quotes">${search.top.slice(0, 5).map((t) => `<li><a href="${appHref(ctx, d.country, t.app_id)}">${esc(t.name)}</a> <span class="muted">${num(t.rating_count)} ratings</span></li>`).join("")}</ol>`;
    }
  }
  if (volume) {
    searchBody += `<p>On Google, “${esc(volume.keyword)}” gets about ${num(volume.volume)} searches a month in ${esc(countryName(d.country))}${volume.cpc ? `, and advertisers pay about $${volume.cpc.toFixed(2)} a click` : ""} (estimate from seodata.dev, ${longDate(volume.checked_at)}).</p>`;
  }

  const pricing = pricingSummary(apps.map((s) => prices.get(s.appId) ?? []));
  const periodRows = pricing.periods
    .filter((p) => p.period !== "other")
    .map((p) => `<tr><td>${esc(p.period.charAt(0).toUpperCase() + p.period.slice(1))}</td><td class="n">${esc(formatPrice(p.sample, p.median))}</td><td class="n">${esc(p.min === p.max ? "" : `${formatPrice(p.sample, p.min)} to ${formatPrice(p.sample, p.max)}`)}</td><td class="n">${num(p.apps)}</td></tr>`)
    .join("");
  const priceBody = pricing.checked
    ? `<p>${num(pricing.selling)} of ${num(pricing.checked)} apps list in-app purchases on their App Store page.</p>` +
      (periodRows ? `<div class="table-wrap"><table class="data"><thead><tr><th>Plan</th><th class="n">Median</th><th class="n">Range</th><th class="n">Apps</th></tr></thead><tbody>${periodRows}</tbody></table></div>` : "")
    : "";

  const reviews = apps.flatMap((s) => store.readReviews(d.country, s.appId).map((r) => ({ ...r, app: title(s, s.appId) })));
  const { critical, themes } = complaintThemes(reviews);
  const worst = reviews.filter(isCritical).filter((r) => r.title).sort((a, b) => a.rating - b.rating || b.date.localeCompare(a.date)).slice(0, 5);
  const complaintBody = critical
    ? `<p>From ${plural(critical, "review")} with 1 to 3 stars: ${themes.slice(0, 4).map((t) => `${esc(t.name.toLowerCase())} (${pct(t.share)})`).join(", ") || "no common theme"}.</p>` +
      `<ul class="quotes">${worst.map((r) => `<li>“${esc(r.title)}” <span class="muted">${r.rating} star${r.rating === 1 ? "" : "s"}, ${esc(r.app)}</span></li>`).join("")}</ul>`
    : "";

  const suggested = alsoSuggested(apps.map((s) => similar.get(s.appId) ?? []), new Set(apps.map((s) => s.appId))).slice(0, 8);
  const suggestBody = suggested.length
    ? `<p>The apps Apple shows under “You might also like” for these, outside this list. Each one is a competitor the charts didn’t show.</p><ul class="chips">${suggested.map((x) => `<li><a href="${appHref(ctx, d.country, x.similar_id)}">${esc(x.name)}</a> <span class="muted">${x.apps}</span></li>`).join("")}</ul>`
    : "";

  const individuals = apps.filter((s) => s.details?.seller && looksLikeIndividual(s.details.seller, s.details.name)).length;
  const makers = `<p>${num(individuals)} of ${num(apps.length)} apps are sold under a person’s own name, so they are likely made by one developer.</p>`;

  const relatedBody = related.length
    ? `<ul class="chips">${related.map((t) => `<li><a href="${href(ctx, `/niches/${slug(t)}/`)}">${esc(t)}</a></li>`).join("")}</ul>`
    : "";

  const body =
    head +
    block("The apps", table, true) +
    (searchBody ? block("What customers search", searchBody) : "") +
    (priceBody ? block("What they charge", priceBody) : "") +
    (complaintBody ? block("What reviewers complain about", complaintBody) : "") +
    (suggestBody ? block("Apple also suggests", suggestBody) : "") +
    block("Who makes them", makers) +
    (relatedBody ? block("Other niches today", relatedBody) : "");

  write(ctx, {
    path: `/niches/${slug(term)}/`,
    title: `${heading}: who earns on the App Store (${shortName(d.country)})`,
    description: `${plural(publishers, "publisher")} ${live ? "have" : "had"} a ${term} app on ${shortName(d.country)} top-grossing charts. Prices, ratings, complaints and competitors, updated daily.`,
    date: d.date,
    current: "/niches/",
    body,
    jsonLd: [
      trail.ld,
      {
        "@context": "https://schema.org",
        "@type": "ItemList",
        name: `${heading} on ${shortName(d.country)} top-grossing charts`,
        itemListElement: apps.map((s, i) => ({ "@type": "ListItem", position: i + 1, name: s.details?.name ?? s.appId, url: appStore(d.country, s.appId) })),
      },
    ],
  });
}

function nichesHub(ctx: Ctx, d: CountryData, history: NicheHistory[]): void {
  const trail = crumbs(ctx, [["/", "Home"], ["/niches/", "Niches"]]);
  const rows = history
    .map(
      (h) =>
        `<tr><td><a href="${href(ctx, `/niches/${slug(h.term)}/`)}">${esc(h.term)}</a></td><td class="hide-xs">${longDate(h.firstSeen)}</td><td>${h.lastSeen === d.date ? "today" : longDate(h.lastSeen)}</td><td class="n">${plural(h.daysSeen, "day")}</td><td class="n">${num(h.appIds.length)}</td></tr>`,
    )
    .join("");
  write(ctx, {
    path: "/niches/",
    title: `Every App Store niche Scout has found (${shortName(d.country)})`,
    description: `${plural(history.length, "niche")} where three or more publishers earned with the same idea on ${shortName(d.country)} top-grossing charts, with the day each was first spotted.`,
    date: d.date,
    current: "/niches/",
    body: `<section class="doc-head"><div class="container">${trail.html}<h1>Every niche so far</h1>
<p class="lead">${esc(`${plural(history.length, "niche")} found on ${shortName(d.country)} charts, most recent first. A niche is a phrase shared by new or small apps from three or more publishers, all on a top-grossing chart.`)}</p></div></section>
<section class="block block--wide"><div class="container"><div class="table-wrap"><table class="index"><thead><tr><th>Niche</th><th class="hide-xs">First spotted</th><th>Last seen</th><th class="n">Seen on</th><th class="n">Apps</th></tr></thead><tbody>${rows}</tbody></table></div></div></section>`,
    jsonLd: [trail.ld],
  });
}

// ---------------------------------------------------------------------------------------------
// Apps

function appPage(ctx: Ctx, d: CountryData, id: string, niches: string[]): void {
  const { store } = ctx;
  const s = signalOf(d, id);
  const details = s?.details;
  if (!s || !details) return;
  const page = store.readPages(d.country).get(id);
  const purchases = (store.readPrices(d.country).get(id) ?? []).filter((r) => r.item);
  const versions = store.readVersions(d.country).get(id) ?? [];
  const similar = store.readSimilar(d.country).get(id) ?? [];
  const reviews = store.readReviews(d.country, id);
  const trail = crumbs(ctx, [["/", "Home"], [`/countries/${d.country}/`, shortName(d.country)], [`/apps/${id}/`, title(s)]]);

  const low = page ? lowStarShare(page) : null;
  const head = `<section class="doc-head"><div class="container">${trail.html}
<h1>${esc(title(s))}</h1>
<p class="lead">${esc(`By ${details.publisher}${details.seller && details.seller !== details.publisher ? ` (sold by ${details.seller})` : ""}. ${details.primaryGenre}, released ${longDate(details.releasedAt)}.`)} <a href="${appStore(d.country, id)}">View on the App Store</a></p>
${summary([
  [s.grossing ? `#${s.grossing.rank}` : "off chart", s.grossing ? `top grossing, ${genreName(ctx.config, s.grossing.genreId)}` : "top grossing today"],
  [s.ratingCount === null ? "?" : num(s.ratingCount), "ratings"],
  [low === null ? "too few" : pct(low), "1 and 2 stars"],
  [num(releasesWithin(versions, d.date)), "releases in 90 days"],
])}
</div></section>`;

  const history = d.snapshots
    .map((snap) => {
      const ranks = snap.charts.filter((r) => r.app_id === id && r.chart === "top-grossing").sort((a, b) => a.rank - b.rank);
      return { date: snap.date, best: ranks[0], ratings: snap.ratings.get(id)?.rating_count };
    })
    .reverse()
    .slice(0, 14);
  const chartBody = `<div class="table-wrap"><table class="data"><thead><tr><th>Day</th><th>Best top-grossing place</th><th class="n">Ratings</th></tr></thead><tbody>${history
    .map((h) => `<tr><td>${longDate(h.date)}</td><td>${h.best ? `#${h.best.rank} ${esc(genreName(ctx.config, h.best.genre_id))}` : "not charting"}</td><td class="n">${h.ratings === undefined ? "" : num(h.ratings)}</td></tr>`)
    .join("")}</tbody></table></div>`;

  let starsBody = "";
  if (page && totalStars(page) > 0) {
    const total = totalStars(page);
    const rows = [5, 4, 3, 2, 1].map((n) => {
      const count = page[`stars_${n}` as keyof PageRow] as number;
      return `<div${n <= 2 ? ' class="low"' : ""}><dt>${n} star${n === 1 ? "" : "s"}</dt><span class="track"><i style="--v: ${(count / total).toFixed(3)}"></i></span><dd>${pct(count / total)}</dd></div>`;
    });
    starsBody = `<dl class="bars" aria-label="Share of ratings by star">${rows.join("")}</dl>`;
  }

  const priceBody = purchases.length
    ? `<div class="table-wrap"><table class="data"><thead><tr><th>Purchase</th><th class="n">Price</th></tr></thead><tbody>${purchases.map((r) => `<tr><td>${esc(r.item)}</td><td class="n">${esc(r.price_text)}</td></tr>`).join("")}</tbody></table></div><p class="small">As listed on the App Store page, ${longDate(purchases[0].checked_at)}. Apple shows at most 10.</p>`
    : page ? `<p>The App Store page lists no in-app purchases.</p>` : "";

  const facts: string[] = [];
  if (page?.privacy) {
    const label = { tracking: "Uses data to track you across other companies’ apps", linked: "Collects data linked to you", "not-linked": "Collects data not linked to you", none: "Says it collects no data" }[page.privacy];
    facts.push(`<li><b>Privacy label:</b> ${esc(label)}${page.tracking ? ` (${esc(page.tracking.replace(/_/g, " ").replace(/;/g, ", "))})` : ""}.</li>`);
  }
  if (versions[0]) facts.push(`<li><b>Latest release:</b> ${esc(versions[0].version)}, ${longDate(versions[0].date)}. Scout has seen ${plural(versions.length, "release")}.</li>`);
  if (page?.age_rating) facts.push(`<li><b>Age rating:</b> ${esc(page.age_rating)}</li>`);
  if (page?.size_mb) facts.push(`<li><b>Size:</b> ${num(Math.round(page.size_mb))}&nbsp;MB</li>`);
  if (details.languages) facts.push(`<li><b>Languages:</b> ${num(details.languages)}</li>`);
  const factsBody = facts.length ? `<ul class="quotes">${facts.join("")}</ul>` : "";

  const { critical, themes } = complaintThemes(reviews);
  const worst = reviews.filter(isCritical).filter((r) => r.title).slice(0, 6);
  const complaintBody = critical
    ? `<p>${plural(critical, "review")} with 1 to 3 stars. Most mention ${themes.slice(0, 3).map((t) => `${esc(t.name.toLowerCase())} (${pct(t.share)})`).join(", ") || "no common theme"}.</p><ul class="quotes">${worst.map((r) => `<li>“${esc(r.title)}” <span class="muted">${r.rating} star${r.rating === 1 ? "" : "s"}, ${longDate(r.date)}</span></li>`).join("")}</ul>`
    : "";

  const similarBody = similar.length
    ? `<ul class="chips">${similar.map((x) => `<li><a href="${appHref(ctx, d.country, x.similar_id)}">${esc(x.name)}</a></li>`).join("")}</ul>`
    : "";
  const nicheBody = niches.length
    ? `<ul class="chips">${niches.map((t) => `<li><a href="${href(ctx, `/niches/${slug(t)}/`)}">${esc(t)}</a></li>`).join("")}</ul>`
    : "";

  const body =
    head +
    block("Chart history", chartBody, true) +
    (starsBody ? block("Ratings by star", starsBody) : "") +
    (priceBody ? block("What it charges", priceBody) : "") +
    (factsBody ? block("From its App Store page", factsBody) : "") +
    (complaintBody ? block("What unhappy users say", complaintBody) : "") +
    (similarBody ? block("Apple also suggests", similarBody) : "") +
    (nicheBody ? block("Niches it belongs to", nicheBody) : "");

  write(ctx, {
    path: `/apps/${id}/`,
    title: `${details.name}: chart history, prices and reviews (${shortName(d.country)})`,
    description: `${details.name} by ${details.publisher}: ${s.grossing ? `#${s.grossing.rank} top grossing in ${genreName(ctx.config, s.grossing.genreId)}` : "chart history"}, in-app prices, ratings by star and what unhappy users say.`,
    date: d.date,
    body,
    jsonLd: [trail.ld],
  });
}

// ---------------------------------------------------------------------------------------------
// Countries and about

function countryPage(ctx: Ctx, d: CountryData): void {
  const { config } = ctx;
  const trail = crumbs(ctx, [["/", "Home"], ["/countries/", "Countries"], [`/countries/${d.country}/`, countryName(d.country)]]);
  const researched = ctx.config.research.countries.includes(d.country);
  const nicheRows = d.niches
    .map((c) => {
      const name = researched ? `<a href="${href(ctx, `/niches/${slug(c.term)}/`)}">${esc(c.term)}</a>` : esc(c.term);
      const examples = c.apps.slice(0, 3).map((s) => `<a href="${appHref(ctx, d.country, s.appId)}">${esc(title(s, s.appId))}</a>`).join(", ");
      return `<tr><td>${name}</td><td class="n">${num(c.publishers)}</td><td class="hide-xs">${examples}</td></tr>`;
    })
    .join("");
  const niches = nicheRows
    ? `<div class="table-wrap"><table class="data"><thead><tr><th>Niche</th><th class="n">Publishers</th><th class="hide-xs">Examples</th></tr></thead><tbody>${nicheRows}</tbody></table></div>`
    : `<p class="muted">No niches today.</p>`;
  const genres = genreSummaries(d.snapshots.at(-1)!, d.signals, config)
    .map((g) => `<tr><td>${esc(genreName(config, g.genreId))}</td><td class="n">${num(g.grossingApps)}</td><td class="n">${num(g.newApps)}</td><td class="n">${num(g.smallApps)}</td></tr>`)
    .join("");
  const list = ctx.config.report.listSize;
  const body =
    `<section class="doc-head"><div class="container">${trail.html}<h1>${esc(countryName(d.country))} App Store, ${longDate(d.date)}</h1>
<p class="lead">${esc(`${plural(d.signals.length, "app")} on the tracked charts today, across ${config.genres.length} categories.`)}</p></div></section>` +
    block("Niches where newcomers earn", niches, true) +
    block("Small and paying", `<p>On a top-grossing chart with fewer than ${num(config.report.smallAppMaxRatings)} ratings.</p>` + appRows(ctx, d, smallAndPaying(d.signals, config).slice(0, list)), true) +
    block("New and paying", `<p>Released in the last ${num(config.report.newAppMaxAgeDays)} days and already on a top-grossing chart.</p>` + appRows(ctx, d, newAndPaying(d.signals, config).slice(0, list), { title: "Days old", value: (s) => (s.ageDays === null ? "" : num(s.ageDays)) }), true) +
    block("Built by one person", `<p>Sold under a person’s own name. A guess from the seller’s name, usually right.</p>` + appRows(ctx, d, soloAndPaying(d.signals).slice(0, list)), true) +
    block("Earning without updates", `<p>On a top-grossing chart, but not updated in over a year.</p>` + appRows(ctx, d, neglectedEarners(d.signals, d.date).slice(0, list), { title: "Last update", value: (s) => s.details?.updatedAt?.slice(0, 10) ?? "" }), true) +
    block("Every category", `<div class="table-wrap"><table class="data"><thead><tr><th>Category</th><th class="n">Grossing apps</th><th class="n">New</th><th class="n">Small</th></tr></thead><tbody>${genres}</tbody></table></div>`, true);
  write(ctx, {
    path: `/countries/${d.country}/`,
    title: `App Store niches earning today in ${countryName(d.country)}`,
    description: `Today’s ${countryName(d.country)} App Store: niches where new and small apps earn, solo developers on the grossing charts and earning apps nobody updates.`,
    date: d.date,
    current: "/countries/",
    body,
    jsonLd: [trail.ld],
  });
}

// Search: one index file per country, and a page that reads them in the browser.
function searchPages(ctx: Ctx, all: CountryData[], main: CountryData): void {
  mkdirSync(join(ctx.opts.out, "data"), { recursive: true });
  for (const d of all) {
    const index = searchIndex(d.country, d.date, d.signals, ctx.config, d.country === main.country ? ctx.appPages : new Set());
    writeFileSync(join(ctx.opts.out, "data", `search-${d.country}.json`), JSON.stringify(index));
  }
  const { config } = ctx;
  const trail = crumbs(ctx, [["/", "Home"], ["/search/", "Search"]]);
  const options = [main, ...all.filter((d) => d !== main)].map((d) => `<option value="${d.country}">${esc(countryName(d.country))}</option>`).join("");
  const examples = ["language", "fasting", ...main.niches.slice(0, 5).map((c) => c.term)]
    .filter((t, i, list) => list.indexOf(t) === i)
    .map((t) => `<li><a href="${href(ctx, `/search/?q=${encodeURIComponent(t)}`)}">${esc(t)}</a></li>`)
    .join("");
  const body = `<section class="doc-head"><div class="container">${trail.html}<h1>Search today’s charts</h1>
<p class="lead">${esc(`Every app on ${main.country === "us" ? "the US" : countryName(main.country)} charts today, ${num(main.signals.length)} of them, by name, publisher or category. The summary turns any word into a quick niche check.`)}</p></div></section>
<section class="block block--table"><div class="container"><div class="body">
<form id="search" class="search" role="search" action="${href(ctx, "/search/")}" data-base="${ctx.base}" data-small="${config.report.smallAppMaxRatings}" data-new-days="${config.report.newAppMaxAgeDays}" data-today="${main.date}">
<div class="search-row">
<label class="field"><span>Search apps</span><input type="search" name="q" autocomplete="off" spellcheck="false" placeholder="language, fasting, budget"></label>
<label class="field field--select"><span>Country</span><select name="c">${options}</select></label>
</div>
<fieldset class="checks"><legend class="visually-hidden">Only show</legend>
<label><input type="checkbox" name="grossing"> On a top-grossing chart</label>
<label><input type="checkbox" name="small"> Under ${num(config.report.smallAppMaxRatings)} ratings</label>
<label><input type="checkbox" name="fresh"> Released in the last year</label>
</fieldset>
</form>
<div id="hint"><p>Try one of these:</p><ul class="chips">${examples}</ul></div>
<p id="status" role="status" aria-live="polite"></p>
<dl id="summary" class="summary"></dl>
<div id="results"></div>
<noscript><p>Search runs in your browser and needs JavaScript. <a href="${href(ctx, "/niches/")}">Browse every niche</a> instead.</p></noscript>
</div></div></section>
<script>${SEARCH_SCRIPT}</script>`;
  write(ctx, {
    path: "/search/",
    title: "Search the App Store charts: App Store Scout",
    description: `Search every app on today’s App Store charts in ${all.length} countries by name, publisher or category, and see how many are earning.`,
    date: main.date,
    current: "/search/",
    body,
    jsonLd: [trail.ld],
  });
}

function countriesHub(ctx: Ctx, all: CountryData[]): void {
  const trail = crumbs(ctx, [["/", "Home"], ["/countries/", "Countries"]]);
  const rows = all
    .map((d) => `<tr><td><a href="${href(ctx, `/countries/${d.country}/`)}">${esc(countryName(d.country))}</a></td><td class="hide-xs">${d.niches.slice(0, 3).map((n) => esc(n.term)).join(", ")}</td><td class="n">${num(smallAndPaying(d.signals, ctx.config).length)}</td></tr>`)
    .join("");
  write(ctx, {
    path: "/countries/",
    title: "App Store charts by country: niches and small apps earning today",
    description: `Scout scans ${all.length} App Stores every day. Compare the niches and small apps earning in each.`,
    date: all[0].date,
    current: "/countries/",
    body: `<section class="doc-head"><div class="container">${trail.html}<h1>Eight App Stores, every day</h1><p class="lead">The same scan in each country. Deeper research (search, reviews, prices) runs in the ${esc(ctx.config.research.countries.map(shortName).join(", "))}.</p></div></section>
<section class="block block--wide"><div class="container"><div class="table-wrap"><table class="index"><thead><tr><th>Country</th><th class="hide-xs">Top niches today</th><th class="n">Small apps earning</th></tr></thead><tbody>${rows}</tbody></table></div></div></section>`,
    jsonLd: [trail.ld],
  });
}

const FAQ: [string, string][] = [
  ["Does Scout show downloads or revenue?", "No. It records chart positions, ratings, prices and reviews from Apple’s public feeds. A top-grossing rank says an app earns more than its neighbours on that chart, nothing more."],
  ["What counts as a niche?", "A phrase shared by the names of new or small apps from three or more different publishers, all on a top-grossing chart the same day. One app can be luck or an ad budget; three unrelated ones is a pattern."],
  ["How fresh is the data?", "A GitHub Action scans every morning at 14:00 UTC and rebuilds this site. Each page says the date of the charts it shows."],
  ["Can I use the data?", "Yes. Every snapshot is a CSV file in the repository, under the MIT licence. Fork the repo and your copy scans every day too, for free."],
];

function aboutPage(ctx: Ctx, date: string): void {
  const { config } = ctx;
  const trail = crumbs(ctx, [["/", "Home"], ["/about/", "How it works"]]);
  const body =
    `<section class="doc-head"><div class="container">${trail.html}<h1>How Scout works</h1><p class="lead">A script, a free GitHub runner and Apple’s public feeds. Here is what it reads and what it can’t tell you.</p></div></section>` +
    block("What it reads", `<div class="prose"><p>Every day Scout saves Apple’s top free, top paid and top grossing charts for ${config.genres.length} categories in ${config.countries.length} countries, 100 apps each, then looks up every app’s ratings, release date and seller.</p><p>In the ${esc(config.research.countries.map(shortName).join(", "))} it goes further for the most promising niches: what an App Store search shows, the latest reviews, in-app purchase prices, star breakdowns, privacy labels and the apps Apple suggests alongside.</p></div>`) +
    block("What it can’t tell you", `<ul class="quotes"><li>Ranks are not downloads or money. Grossing ranks compare neighbours on one chart.</li><li>Charts stop at 100, so the long tail is invisible.</li><li>Ratings lag installs; most people never rate.</li><li>“Solo developer” is a guess from the seller’s name.</li></ul>`) +
    block("Run your own", `<p>Fork the repository, enable Actions, and your copy scans every day and publishes its own site. Or run it on your computer with Node 22.18 or newer:</p><pre class="code">git clone https://github.com/${esc(ctx.opts.repo)}
cd app-store-scout
npm run scan
npm run site</pre>`) +
    block("Questions people ask", `<dl class="faq">${FAQ.map(([q, a]) => `<div><dt>${esc(q)}</dt><dd>${esc(a)}</dd></div>`).join("")}</dl>`);
  write(ctx, {
    path: "/about/",
    title: "How App Store Scout works: sources, method and limits",
    description: "What App Store Scout reads from Apple’s public feeds every day, how it finds niches, and what the data can’t tell you.",
    date,
    current: "/about/",
    body,
    jsonLd: [
      trail.ld,
      { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: FAQ.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) },
    ],
  });
}

// ---------------------------------------------------------------------------------------------

export function buildSite(store: Store, config: Config, opts: SiteOptions): { pages: number } {
  const url = opts.url.replace(/\/+$/, "");
  const base = new URL(`${url}/`).pathname.replace(/\/+$/, "");
  const ctx: Ctx = { store, config, opts: { ...opts, url }, base, appPages: new Set(), nichePages: new Map(), pages: [] };

  const all = config.countries.map((c) => countryData(store, config, c)).filter((d): d is CountryData => !!d);
  const main = all.find((d) => d.country === primary(ctx)) ?? all[0];
  if (!main) throw new Error("No snapshots yet. Run: npm run scan");

  rmSync(opts.out, { recursive: true, force: true });
  mkdirSync(join(opts.out, "assets"), { recursive: true });
  for (const f of readdirSync(opts.assets).filter((f) => /\.(css|svg)$/.test(f))) copyFileSync(join(opts.assets, f), join(opts.out, "assets", f));

  // The niches researched so far, with today's added in case research hasn't saved them yet.
  const history = store.nicheHistory(main.country);
  for (const c of main.niches) {
    if (!history.some((h) => h.term === c.term)) history.unshift({ term: c.term, firstSeen: main.date, lastSeen: main.date, daysSeen: 1, appIds: c.apps.map((s) => s.appId) });
  }
  const pages = store.readPages(main.country);
  for (const id of pages.keys()) if (main.apps.has(id)) ctx.appPages.add(id);

  homePage(ctx, main, all, history);
  nichesHub(ctx, main, history);
  const todays = new Map(main.niches.map((c) => [c.term, c]));
  for (const h of history) {
    nichePage(ctx, main, h, todays.get(h.term), main.niches.map((c) => c.term).filter((t) => t !== h.term).slice(0, 8));
  }
  const nichesOf = new Map<string, string[]>();
  for (const h of history) for (const id of h.appIds) nichesOf.set(id, [...(nichesOf.get(id) ?? []), h.term]);
  for (const id of ctx.appPages) appPage(ctx, main, id, nichesOf.get(id) ?? []);
  for (const d of all) countryPage(ctx, d);
  countriesHub(ctx, all);
  searchPages(ctx, all, main);
  aboutPage(ctx, main.date);

  writeFileSync(
    join(opts.out, "404.html"),
    layout(ctx, {
      path: "/404.html",
      title: "Page not found: App Store Scout",
      description: "This page doesn’t exist. Niches that stop earning keep their pages, so try the list of every niche.",
      date: main.date,
      noindex: true,
      body: `<section class="doc-head"><div class="container"><h1>No page here</h1><p class="lead">The link may be old, or the app may have left the charts.</p><div class="actions"><a class="btn btn--primary" href="${href(ctx, "/niches/")}">Browse every niche</a></div></div></section>`,
    }),
  );
  writeFileSync(
    join(opts.out, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${ctx.pages
      .map((p) => `  <url><loc>${esc(`${url}${p.path}`)}</loc><lastmod>${p.lastmod}</lastmod></url>`)
      .join("\n")}\n</urlset>\n`,
  );
  writeFileSync(join(opts.out, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${url}/sitemap.xml\n`);
  writeFileSync(join(opts.out, ".nojekyll"), "");
  return { pages: ctx.pages.length };
}
