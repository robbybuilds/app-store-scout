// The public website: plain HTML pages built from the same data as the reports. A home page,
// one page per country, one per niche ever researched and one per researched app, plus a
// sitemap. No dependencies and no client framework, so GitHub Pages can serve it for free.
// The look comes from web/ (designed with Hallmark's Hum theme); this file only writes markup.

import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeApi } from "./api.ts";
import type { AppDetails } from "./apple.ts";
import { type ChangeRow, describeChange, recentChanges } from "./changes.ts";
import { type Config, genreName } from "./config.ts";
import { buildFeed } from "./feed.ts";
import type { Mover } from "./movers.ts";
import { alsoSuggested, lowStarShare, type PageRow, releasesWithin, totalStars } from "./pages.ts";
import { formatPrice, type PriceRow, pricingSummary } from "./prices.ts";
import { looksLikeIndividual } from "./publishers.ts";
import { confirmedRemovals, type RemovedRow } from "./removed.ts";
import { complaintThemes, isCritical } from "./reviews.ts";
import {
  type AppSignal,
  type Cluster,
  genreSummaries,
  isNew,
  isSmall,
  neglectedEarners,
  newAndPaying,
  smallAndPaying,
  soloAndPaying,
} from "./signals.ts";
import { SEARCH_SCRIPT, searchIndex } from "./site-search.ts";
import type { NicheHistory, Store } from "./store.ts";
import { type CountryData, countryData, signalOf } from "./views.ts";

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
    ["/movers/", "Movers", ""],
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
<link rel="alternate" type="application/atom+xml" title="App Store Scout: new niches" href="${href(ctx, "/feed.xml")}">
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
${newsletterBand(ctx)}${communityBand(ctx)}</main>
<footer class="footer" style="--tear: ${tear(41, 9, 48, 0)}"><div class="container">
<p class="mast" aria-hidden="true">Scout</p>
<ul>
<li><a href="${href(ctx, "/niches/")}">Every niche</a></li>
<li><a href="${href(ctx, "/movers/")}">Movers</a></li>
<li><a href="${href(ctx, "/changes/")}">Listing changes</a></li>
<li><a href="${href(ctx, "/removed/")}">Removed apps</a></li>
<li><a href="${href(ctx, "/countries/")}">Countries</a></li>
<li><a href="${href(ctx, "/about/")}">How it works</a></li>
<li><a href="${href(ctx, "/api/")}">API and MCP</a></li>
<li><a href="${href(ctx, "/feed.xml")}">Feed</a></li>
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
}${ctx.config.site?.newsletter?.loopsFormId ? SIGNUP_SCRIPT : ""}
</script>
</body>
</html>
`;
}

/**
 * The newsletter sign-up, from scout.config.json. It posts to Loops' public form endpoint, which
 * takes an email with no key. Shown once a form id is set; a fork without one shows nothing.
 */
function newsletterBand(ctx: Ctx): string {
  const n = ctx.config.site?.newsletter;
  if (!n?.loopsFormId || !/^[a-z0-9]+$/i.test(n.loopsFormId)) return "";
  return `<section class="section section--s signup-band" aria-labelledby="signup-title"><div class="container stack">
<div class="pane"><h2 id="signup-title">${esc(n.heading ?? "New niches, by email.")}</h2>
<p class="lead">${esc(n.pitch ?? "Get the niches Scout finds and the small apps climbing the charts. Free, and you can unsubscribe at any time.")}</p></div>
<form class="signup" method="post" action="https://app.loops.so/api/newsletter-form/${esc(n.loopsFormId)}" data-signup>
<label class="signup-field"><span>Email address</span><input type="email" name="email" required autocomplete="email" placeholder="you@example.com"></label>
<input type="hidden" name="userGroup" value="${esc(n.userGroup ?? "App Store Scout")}">${n.mailingLists ? `\n<input type="hidden" name="mailingLists" value="${esc(n.mailingLists)}">` : ""}
<button class="btn btn--primary" type="submit">${esc(n.cta ?? "Subscribe")}</button>
<p class="signup-status" role="status" aria-live="polite"></p>
</form>
</div></section>
`;
}

// Sends the sign-up in the background so the reader stays on the page. Without JavaScript the
// form still posts straight to Loops.
const SIGNUP_SCRIPT = `
for (const form of document.querySelectorAll("[data-signup]")) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const status = form.querySelector(".signup-status");
    const button = form.querySelector("button");
    const say = (text, ok) => { status.textContent = text; status.dataset.state = ok ? "ok" : "error"; };
    button.disabled = true;
    say("Sending…", true);
    try {
      const res = await fetch(form.action, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(new FormData(form)).toString(),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) { say("You’re on the list. Check your inbox.", true); form.reset(); }
      else if (res.status === 429) say("Too many sign-ups just now. Try again in a minute.", false);
      else say(data.message || "That didn’t go through. Check the address and try again.", false);
    } catch {
      say("Couldn’t reach the sign-up service. Check your connection and try again.", false);
    }
    button.disabled = false;
  });
}`;

/** The maker's community, from scout.config.json. A fork without one shows nothing. */
function communityBand(ctx: Ctx): string {
  const c = ctx.config.site?.community;
  if (!c?.url || !c.name) return "";
  return `<section class="section section--s section--paper2 join" aria-labelledby="join-title"><div class="container stack">
<div class="pane"><h2 id="join-title">${esc(c.heading ?? "Found a niche? Build it.")}</h2>
<p class="lead">${esc(c.pitch ?? `Scout is made by the people behind ${c.name}.`)}</p></div>
<div class="actions"><a class="btn btn--primary" href="${esc(c.url)}">${esc(c.cta ?? `Join ${c.name}`)}</a></div>
</div></section>
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

  // Small and new apps only: a giant moving ten places is noise, a newcomer doing it is a lead.
  const underdog = (m: Mover) => { const sig = d.bySignal.get(m.appId); return !!sig && (isSmall(sig, config) || isNew(sig, config)); };
  const moverItem = (m: Mover, text: string) =>
    `<li><a href="${appHref(ctx, d.country, m.appId)}">${esc(title(d.bySignal.get(m.appId), m.appId))}</a><span class="rank">${esc(text)}</span></li>`;
  // Two per category at most: a thin chart (Developer Tools) shuffles more than a deep one.
  const spread = (rows: Mover[]) => {
    const perGenre = new Map<number, number>();
    return rows.filter((m) => { const n = perGenre.get(m.genreId) ?? 0; perGenre.set(m.genreId, n + 1); return n < 2; }).slice(0, 5);
  };
  const climbs = spread(d.movers.climbers.filter(underdog));
  const arrived = spread(d.movers.arrivals.filter(underdog));
  const moversSection = climbs.length || arrived.length
    ? `<section class="section section--paper2" aria-labelledby="movers-title"><div class="container stack stack--flip">
<div class="pane"><h2 id="movers-title">Moving on the money charts</h2>
<p class="lead">New and small apps that climbed or arrived on a top-grossing chart since ${longDate(d.movers.previousDate!)}.</p>
<p><a class="link" href="${href(ctx, "/movers/")}">Every move today</a></p></div>
<ul class="cards cards--two">
${climbs.length ? `<li class="card"><div class="card-top"><h3>Biggest climbs</h3></div><ul class="apps-list apps-list--stacked">${climbs.map((m) => moverItem(m, `up ${m.change} to #${m.rank} ${genreName(config, m.genreId)}`)).join("")}</ul></li>` : ""}
${arrived.length ? `<li class="card"><div class="card-top"><h3>Just arrived</h3></div><ul class="apps-list apps-list--stacked">${arrived.map((m) => moverItem(m, `#${m.rank} ${genreName(config, m.genreId)}${m.debut ? ", first time" : ""}`)).join("")}</ul></li>` : ""}
</ul>
</div></section>`
    : "";

  const solo = soloAndPaying(d.signals).slice(0, 6);
  const soloCards = solo
    .map(
      (s) =>
        `<li class="card card--small"><h3><a href="${appHref(ctx, d.country, s.appId)}">${esc(title(s, s.appId))}</a></h3>
<p class="fact">${esc(`By ${s.details?.seller ?? ""}. ${rankText(ctx, s)}${s.ratingCount === null ? "" : `, ${plural(s.ratingCount, "rating")}`}.`)}</p></li>`,
    )
    .join("");
  const soloSection = solo.length
    ? `<section class="section" aria-labelledby="solo-title"><div class="container stack">
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
    body: hero + stack + moversSection + soloSection + figures + countries + archive,
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

  // Listing changes and releases on one timeline, so a rank move can be read against what shipped.
  const since = new Date(Date.parse(d.date) - 90 * 86_400_000).toISOString().slice(0, 10);
  const events = [
    ...store.readChanges(d.country).filter((c) => c.app_id === id).map((c) => ({ date: c.date, text: describeChange(c) })),
    ...versions.filter((v) => v.date >= since).map((v) => ({ date: v.date, text: `Released version ${v.version}.` })),
  ].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 20);
  const changeBody = events.length
    ? `<div class="table-wrap"><table class="data"><thead><tr><th>Day</th><th>What changed</th></tr></thead><tbody>${events.map((e) => `<tr><td class="nowrap">${longDate(e.date)}</td><td>${esc(e.text)}</td></tr>`).join("")}</tbody></table></div><p class="small">Releases are Apple’s dates. Other changes carry the date of the scan that first saw them.</p>`
    : "";

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
    (changeBody ? block("What changed", changeBody, true) : "") +
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
// Movers, listing changes and removed apps

function moverTable(ctx: Ctx, d: CountryData, rows: Mover[], kind: "change" | "arrival" | "exit" | "first"): string {
  if (!rows.length) return `<p class="muted">Nothing today.</p>`;
  // The place and its chart share a cell, as in every other table, so a phone keeps the change in view.
  const place = kind === "exit" ? "Was at" : "Top grossing";
  const last = { change: "Change", arrival: "", exit: "", first: "Before" }[kind];
  const body = rows
    .map((m) => {
      const s = signalOf(d, m.appId);
      const tail =
        kind === "change" ? `<td class="n">${m.change! > 0 ? `+${m.change}` : `−${Math.abs(m.change!)}`}</td>`
        : kind === "first" ? `<td class="n">${m.previous === null ? "not on it" : `#${m.previous}`}</td>`
        : "";
      const note = kind === "arrival" && m.debut ? ` <span class="muted">first time</span>` : "";
      return `<tr><td><a href="${appHref(ctx, d.country, m.appId)}">${esc(title(s ?? undefined, m.appId))}</a>${note}</td>` +
        `<td class="hide-xs">${esc(s?.details?.publisher ?? "")}</td><td>#${m.rank} ${esc(genreName(ctx.config, m.genreId))}</td>` +
        `${tail}<td class="n hide-xs">${s?.ratingCount == null ? "" : num(s.ratingCount)}</td></tr>`;
    })
    .join("");
  return `<div class="table-wrap"><table class="data"><thead><tr><th>App</th><th class="hide-xs">Publisher</th><th>${place}</th>${last ? `<th class="n">${last}</th>` : ""}<th class="n hide-xs">Ratings</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

function moversPage(ctx: Ctx, d: CountryData): void {
  const m = d.movers;
  const trail = crumbs(ctx, [["/", "Home"], ["/movers/", "Movers"]]);
  const top = 25;
  const lead = m.previousDate
    ? `What changed on ${shortName(d.country)} top-grossing charts between ${longDate(m.previousDate)} and ${longDate(m.date)}. A move means an app out-earned different neighbours than the day before, not a revenue figure.`
    : "Scout needs two days of charts to compare. Come back after the next scan.";
  const head = `<section class="doc-head"><div class="container">${trail.html}
<h1>Top-grossing movers today</h1>
<p class="lead">${esc(lead)}</p>
${m.previousDate ? summary([
  [num(m.climbers.length), "apps climbed"],
  [num(m.arrivals.length), "arrived on a chart"],
  [num(m.arrivals.filter((a) => a.debut).length), "there for the first time"],
  [num(m.exits.length), "left the charts"],
]) : ""}
</div></section>`;
  const body = !m.previousDate ? head : head +
    block("Biggest climbs", `<p>The most places gained on one chart. An app on several charts is listed once, for its biggest move.</p>` + moverTable(ctx, d, m.climbers.slice(0, top), "change"), true) +
    block("New on the charts", `<p>On a top-grossing chart today and on none yesterday, highest placed first. “First time” means Scout has never seen it on one before.</p>` + moverTable(ctx, d, m.arrivals.slice(0, top), "arrival"), true) +
    (m.firstNumberOnes.length ? block("First time at #1", `<p>Top of a category’s grossing chart today, and never before in Scout’s records.</p>` + moverTable(ctx, d, m.firstNumberOnes, "first"), true) : "") +
    block("Biggest drops", moverTable(ctx, d, m.fallers.slice(0, top), "change"), true) +
    block("Left the charts", `<p>On a top-grossing chart yesterday and on none today, by the place they held.</p>` + moverTable(ctx, d, m.exits.slice(0, top), "exit"), true);
  write(ctx, {
    path: "/movers/",
    title: `App Store top-grossing movers today (${shortName(d.country)})`,
    description: `The apps that climbed, arrived, hit #1 for the first time or dropped off ${shortName(d.country)} top-grossing charts today, across ${ctx.config.genres.length} categories.`,
    date: d.date,
    current: "/movers/",
    body,
    jsonLd: [trail.ld],
  });
}

function changeTable(ctx: Ctx, d: CountryData, rows: ChangeRow[]): string {
  if (!rows.length) return `<p class="muted">None seen yet.</p>`;
  const body = rows
    .map((c) => {
      const s = signalOf(d, c.app_id);
      return `<tr><td class="nowrap">${longDate(c.date)}</td><td><a href="${appHref(ctx, d.country, c.app_id)}">${esc(title(s ?? undefined, c.app_id))}</a></td>` +
        `<td>${esc(describeChange(c))}</td><td class="hide-xs">${esc(s?.grossing ? rankText(ctx, s) : "")}</td></tr>`;
    })
    .join("");
  return `<div class="table-wrap"><table class="data"><thead><tr><th>Seen</th><th>App</th><th>What changed</th><th class="hide-xs">Top grossing today</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

function changesPage(ctx: Ctx, d: CountryData): void {
  const trail = crumbs(ctx, [["/", "Home"], ["/changes/", "Listing changes"]]);
  const days = 30;
  const since = new Date(Date.parse(d.date) - days * 86_400_000).toISOString().slice(0, 10);
  // Apps earning today first: a rename on a grossing app is a move worth copying or avoiding.
  const rank = (c: ChangeRow) => d.bySignal.get(c.app_id)?.grossing?.rank ?? 999;
  const all = recentChanges(ctx.store.readChanges(d.country), since).sort((a, b) => b.date.localeCompare(a.date) || rank(a) - rank(b));
  const of = (...fields: string[]) => all.filter((c) => fields.includes(c.field));
  const renamed = of("name");
  const repriced = of("price", "purchase added", "purchase removed", "purchase price");
  const moved = of("seller", "publisher", "category");
  const top = 100;
  const body =
    `<section class="doc-head"><div class="container">${trail.html}
<h1>What apps changed on their listings</h1>
<p class="lead">${esc(`New names, prices, in-app purchases, sellers and categories for apps on ${shortName(d.country)} charts, from the last ${days} days. Scout compares each day’s listing with the day before.`)}</p>
${summary([[num(renamed.length), "renamed"], [num(repriced.length), "price or purchase changes"], [num(moved.length), "seller or category changes"]])}
</div></section>` +
    block("Renamed", `<p>A new name is usually a play for App Store search: watch which words get added.</p>` + changeTable(ctx, d, renamed.slice(0, top)), true) +
    block("Prices and purchases", `<p>App prices are checked daily. In-app purchases are read weekly, for the apps Scout researches.</p>` + changeTable(ctx, d, repriced.slice(0, top)), true) +
    block("Sellers and categories", `<p>A new seller can mean the app was sold. A new category is often a move to an easier chart.</p>` + changeTable(ctx, d, moved.slice(0, top)), true);
  write(ctx, {
    path: "/changes/",
    title: `App Store listing changes: renames and price changes (${shortName(d.country)})`,
    description: `Which charting apps changed their name, price, in-app purchases, seller or category in the last ${days} days on the ${shortName(d.country)} App Store.`,
    date: d.date,
    body,
    jsonLd: [trail.ld],
  });
}

function removedPage(ctx: Ctx, all: CountryData[]): void {
  const trail = crumbs(ctx, [["/", "Home"], ["/removed/", "Removed apps"]]);
  const rows = all
    .flatMap((d) => confirmedRemovals(ctx.store.readRemoved(d.country)).map((r) => ({ r, country: d.country })))
    .sort((a, b) => b.r.confirmed_on.localeCompare(a.r.confirmed_on) || a.r.best_rank - b.r.best_rank);
  const place = (r: RemovedRow) => (r.best_chart ? `#${r.best_rank} ${r.best_chart.replace("top-", "")}, ${genreName(ctx.config, r.best_genre_id)}` : "");
  const table = rows.length
    ? `<div class="table-wrap"><table class="data"><thead><tr><th>App</th><th class="hide-xs">Publisher</th><th>Country</th><th>Best place seen</th><th>Found missing</th><th class="hide-xs">Came back</th></tr></thead><tbody>${rows
        .slice(0, 300)
        .map(({ r, country }) => `<tr><td>${esc(r.name || r.app_id)}</td><td class="hide-xs">${esc(r.publisher)}</td><td>${esc(shortName(country))}</td><td>${esc(place(r))}</td><td class="nowrap">${longDate(r.missing_since)}</td><td class="hide-xs nowrap">${r.returned_on ? longDate(r.returned_on) : ""}</td></tr>`)
        .join("")}</tbody></table></div>`
    : `<p class="muted">None confirmed yet. Scout counts an app as removed once two scans on different days can’t find it, so the first ones show up two days after it starts looking.</p>`;
  const gone = rows.filter((x) => !x.r.returned_on).length;
  write(ctx, {
    path: "/removed/",
    title: "Apps removed from the App Store after charting",
    description: `Apps that were on an App Store chart and then disappeared, in ${all.length} countries, with their best chart place and whether they came back.`,
    date: all[0].date,
    body:
      `<section class="doc-head"><div class="container">${trail.html}
<h1>Apps that charted, then vanished</h1>
<p class="lead">Every day Scout looks up the apps that dropped off the charts. One that Apple no longer lists in a country, two scans running, lands here.</p>
${rows.length ? summary([[num(gone), "still gone"], [num(rows.length - gone), "came back"], [num(new Set(rows.map((x) => x.r.publisher)).size), "publishers"]]) : ""}
</div></section>` +
      block("The list", table, true) +
      block("How to read it", `<ul class="quotes"><li>The date is the day Scout noticed, not the day it happened.</li><li>It is per country: an app can leave one App Store and stay in another.</li><li>Scout can’t tell who removed it, Apple or the developer.</li><li>A removed app that was earning leaves its customers looking for a replacement.</li></ul>`),
    jsonLd: [trail.ld],
  });
}

function apiPage(ctx: Ctx, endpoints: { path: string; description: string }[], date: string): void {
  const trail = crumbs(ctx, [["/", "Home"], ["/api/", "API and MCP"]]);
  const rows = endpoints
    .map((e) => `<tr><td><a href="${href(ctx, e.path)}"><code>${esc(e.path)}</code></a></td><td>${esc(e.description)}</td></tr>`)
    .join("");
  const repo = esc(ctx.opts.repo);
  write(ctx, {
    path: "/api/",
    title: "App Store Scout API and MCP server: free, no key, no limit",
    description: "Read Scout’s daily App Store data as JSON, or connect the MCP server so Claude, Cursor or any agent can ask about niches, movers, removed apps and listing changes.",
    date,
    body:
      `<section class="doc-head"><div class="container">${trail.html}
<h1>The data, for scripts and AI agents</h1>
<p class="lead">Everything on this site is also plain JSON, rebuilt after each daily scan. No key, no sign-in and no call limit.</p></div></section>` +
      block("JSON files", `<p>Replace <code>us</code> with any scanned country. Fetch them from anywhere:</p><pre class="code">curl ${esc(ctx.opts.url)}/api/v1/us/niches.json</pre><div class="table-wrap"><table class="data"><thead><tr><th>File</th><th>What it holds</th></tr></thead><tbody>${rows}</tbody></table></div>`, true) +
      block("MCP server", `<div class="prose"><p>The MCP server runs on your computer and reads the data in your copy of the repository, so there is nothing to sign up for and nothing to meter. It needs Node 22.18 or newer.</p></div><pre class="code">git clone https://github.com/${repo}
cd ${esc(ctx.opts.repo.split("/")[1] ?? "app-store-scout")}
claude mcp add app-store-scout -- npm --prefix "$PWD" run --silent mcp</pre><p>For Cursor, VS Code or Claude Desktop, add the same command to the MCP settings: <code>npm --prefix /path/to/the/repo run --silent mcp</code>. Run <code>git pull</code> for the latest scan.</p>`) +
      block("What to ask", `<ul class="quotes"><li>Which niches have new apps earning this week, and what do their reviews complain about?</li><li>Which small apps climbed the most on a top-grossing chart today?</li><li>Which earning apps were renamed or repriced this month?</li><li>Which charting apps disappeared from the App Store?</li><li>What does every meal planner app charge for a yearly plan?</li></ul>`),
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
    (d.movers.climbers.length ? block("Climbing since the last scan", `<p>The biggest gains on a top-grossing chart since ${longDate(d.movers.previousDate!)}.</p>` + moverTable(ctx, d, d.movers.climbers.slice(0, list), "change"), true) : "") +
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
<p class="lead">${esc(`Every app on ${main.country === "us" ? "the US" : countryName(main.country)} charts today, ${num(main.signals.length)} of them, by name, publisher or category. Type a word, pick a filter, or both. The summary turns any of them into a quick niche check.`)}</p></div></section>
<section class="block block--table"><div class="container"><div class="body">
<form id="search" class="search" role="search" action="${href(ctx, "/search/")}" data-base="${ctx.base}" data-small="${config.report.smallAppMaxRatings}" data-new-days="${config.report.newAppMaxAgeDays}" data-today="${main.date}">
<div class="search-row">
<label class="field"><span>Search apps</span><input type="search" name="q" autocomplete="off" spellcheck="false" placeholder="language, fasting, budget"></label>
<label class="field field--select"><span>Category</span><select name="cat"><option value="">Any category</option></select></label>
<label class="field field--select"><span>Country</span><select name="c">${options}</select></label>
</div>
<fieldset class="checks"><legend class="visually-hidden">Only show</legend>
<label><input type="checkbox" name="grossing"> On a top-grossing chart</label>
<label><input type="checkbox" name="small"> Under ${num(config.report.smallAppMaxRatings)} ratings</label>
<label><input type="checkbox" name="fresh"> Released in the last year</label>
</fieldset>
</form>
<div id="hint"><p>Try one of these:</p><ul class="chips">${examples}<li><a href="${href(ctx, "/search/?grossing=1&amp;small=1")}">earning with under ${num(config.report.smallAppMaxRatings)} ratings</a></li></ul></div>
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
    block("What it tracks over time", `<ul class="quotes"><li><a href="${href(ctx, "/movers/")}">Movers</a>: who climbed, arrived or left a top-grossing chart since the day before.</li><li><a href="${href(ctx, "/changes/")}">Listing changes</a>: new names, prices, in-app purchases, sellers and categories, compared with the day before.</li><li><a href="${href(ctx, "/removed/")}">Removed apps</a>: charting apps Apple stops listing, confirmed on a second scan.</li><li><a href="${href(ctx, "/api/")}">JSON and an MCP server</a>, so a script or an AI agent can read all of it.</li></ul>`) +
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
  moversPage(ctx, main);
  changesPage(ctx, main);
  removedPage(ctx, all);
  apiPage(ctx, writeApi(opts.out, { url, repo: opts.repo }, store, config, all, main, ctx.appPages), main.date);
  writeFileSync(join(opts.out, "feed.xml"), buildFeed({ url, date: main.date, country: shortName(main.country), history, movers: main.movers, name: (id) => main.apps.get(id)?.name ?? "" }));
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
