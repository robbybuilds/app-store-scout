// The site's search runs in the browser over one small JSON file per country, written at
// build time: every app on today's charts with the few facts a search needs. Rows are arrays,
// not objects, and repeated strings (categories) are listed once, to keep the file small.

import type { AppDetails } from "./apple.ts";
import { type Config, genreName } from "./config.ts";
import type { AppSignal } from "./signals.ts";

export interface SearchIndex {
  date: string;
  country: string;
  /** Apple's primary category names, referenced by position. */
  categories: string[];
  /** Chart genre names (ours, e.g. "Games: Puzzle"), referenced by position. */
  genres: string[];
  /** [id, name, publisher, category, ratings, released, grossing rank or 0, grossing genre, best rank on any chart or 0, has a page (1/0)] */
  apps: [string, string, string, number, number, string, number, number, number, number][];
}

export function searchIndex(
  country: string,
  date: string,
  signals: AppSignal[],
  config: Config,
  appPages: Set<string>,
): SearchIndex {
  const categories: string[] = [];
  const genres: string[] = [];
  const at = (list: string[], value: string) => {
    let i = list.indexOf(value);
    if (i < 0) i = list.push(value) - 1;
    return i;
  };
  const apps: SearchIndex["apps"] = [];
  for (const s of signals) {
    const d: AppDetails | undefined = s.details;
    if (!d?.name) continue;
    apps.push([
      s.appId,
      d.name,
      d.publisher,
      at(categories, d.primaryGenre || ""),
      s.ratingCount ?? 0,
      d.releasedAt?.slice(0, 10) ?? "",
      s.grossing?.rank ?? 0,
      s.grossing ? at(genres, genreName(config, s.grossing.genreId)) : -1,
      s.best?.rank ?? 0,
      appPages.has(s.appId) ? 1 : 0,
    ]);
  }
  // Grossing apps first, then by ratings, so a search with many hits leads with earners.
  apps.sort((a, b) => (a[6] || 999) - (b[6] || 999) || b[4] - a[4]);
  return { date, country, categories, genres, apps };
}

/**
 * The search script, inlined on /search/. It reads the index for the chosen country, matches
 * every word of the query against names, publishers and categories (as word prefixes, so
 * "lang" finds "Language"), and builds the table with DOM calls, never innerHTML.
 */
export const SEARCH_SCRIPT = String.raw`
(() => {
  const form = document.querySelector("#search");
  const out = document.querySelector("#results");
  const status = document.querySelector("#status");
  const summary = document.querySelector("#summary");
  const hint = document.querySelector("#hint");
  const { base, small, newDays, today } = form.dataset;
  const cache = new Map();
  const norm = (t) => t.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
  const words = (t) => norm(t).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const stem = (w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
  const num = (n) => n.toLocaleString("en-US");
  const daysOld = (d) => (d ? (Date.parse(today) - Date.parse(d)) / 864e5 : Infinity);

  async function load(c) {
    if (!cache.has(c)) cache.set(c, fetch(base + "/data/search-" + c + ".json").then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }));
    return cache.get(c);
  }

  function el(tag, text, cls) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; }

  async function run() {
    const q = form.q.value.trim();
    const c = form.c.value;
    const only = { grossing: form.grossing.checked, small: form.small.checked, fresh: form.fresh.checked };
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (c !== form.c.options[0].value) params.set("c", c);
    for (const k of Object.keys(only)) if (only[k]) params.set(k, "1");
    history.replaceState(null, "", params.size ? "?" + params : location.pathname);
    out.replaceChildren(); summary.replaceChildren();
    hint.hidden = !!q;
    if (!q) { status.textContent = ""; return; }
    status.textContent = "Loading the index…";
    let index;
    try { index = await load(c); } catch { status.textContent = "Couldn’t load the search index. Reload the page to try again."; return; }
    const terms = words(q).map(stem);
    const hits = [];
    for (const a of index.apps) {
      const name = words(a[1]).map(stem), pub = words(a[2]).map(stem), cat = words(index.categories[a[3]] || "").map(stem);
      let score = 0;
      for (const t of terms) {
        const s = name.some((w) => w.startsWith(t)) ? 3 : cat.some((w) => w.startsWith(t)) ? 2 : pub.some((w) => w.startsWith(t)) ? 1 : 0;
        if (!s) { score = 0; break; }
        score += s;
      }
      if (!score) continue;
      if (only.grossing && !a[6]) continue;
      if (only.small && a[4] >= +small) continue;
      if (only.fresh && daysOld(a[5]) > +newDays) continue;
      hits.push([score, a]);
    }
    hits.sort((x, y) => (x[1][6] || 999) - (y[1][6] || 999) || y[0] - x[0] || y[1][4] - x[1][4]);
    const grossing = hits.filter((h) => h[1][6]);
    const smallEarning = grossing.filter((h) => h[1][4] < +small).length;
    const newEarning = grossing.filter((h) => daysOld(h[1][5]) <= +newDays).length;
    status.textContent = hits.length ? "" : "No apps on today’s charts match “" + q + "”.";
    if (!hits.length) return;
    const ratings = hits.map((h) => h[1][4]).sort((x, y) => x - y);
    const median = ratings[Math.floor(ratings.length / 2)];
    const facts = [
      [num(hits.length), hits.length === 1 ? "app matches" : "apps match"],
      [num(grossing.length), "on a top-grossing chart"],
      [num(smallEarning), "of those under " + num(+small) + " ratings"],
      [num(newEarning), "of those under a year old"],
      [num(median), "median ratings"],
    ];
    for (const [v, label] of facts) { const d = el("div"); d.append(el("dt", label), el("dd", v)); summary.append(d); }

    const table = el("table", undefined, "data");
    const head = el("tr");
    for (const [t, cls] of [["App"], ["Publisher", "hide-xs"], ["Category", "hide-xs"], ["Top grossing"], ["Ratings", "n"], ["Released", "n hide-xs"]]) head.append(el("th", t, cls));
    const thead = el("thead"); thead.append(head);
    const body = el("tbody");
    for (const [, a] of hits.slice(0, 100)) {
      const tr = el("tr");
      const name = el("td"); const link = el("a", a[1]);
      link.href = a[9] && c === form.c.options[0].value ? base + "/apps/" + a[0] + "/" : "https://apps.apple.com/" + c + "/app/id" + a[0];
      name.append(link);
      tr.append(name, el("td", a[2], "hide-xs"), el("td", index.categories[a[3]] || "", "hide-xs"),
        el("td", a[6] ? "#" + a[6] + " " + index.genres[a[7]] : ""), el("td", num(a[4]), "n"), el("td", a[5], "n hide-xs"));
      body.append(tr);
    }
    table.append(thead, body);
    const wrap = el("div", undefined, "table-wrap"); wrap.append(table);
    out.append(wrap);
    if (hits.length > 100) out.append(el("p", "Showing the first 100. Add a word or a filter to narrow it down.", "small"));
  }

  const p = new URLSearchParams(location.search);
  if (p.get("q")) form.q.value = p.get("q");
  if (p.get("c") && [...form.c.options].some((o) => o.value === p.get("c"))) form.c.value = p.get("c");
  for (const k of ["grossing", "small", "fresh"]) form[k].checked = p.get(k) === "1";
  let timer;
  form.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(run, 150); });
  form.addEventListener("submit", (e) => { e.preventDefault(); run(); });
  run();
})();
`;
