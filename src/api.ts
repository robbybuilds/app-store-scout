// The site's data as static JSON, written next to the pages on every build. GitHub Pages
// serves it with open CORS, so a script, a spreadsheet or an agent can read it with no key.
// The shapes come from views.ts, the same ones the MCP server returns.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./config.ts";
import type { Store } from "./store.ts";
import { appView, changesView, chartView, type CountryData, listsView, moversView, nichesView, nicheView, removedView } from "./views.ts";

export interface Endpoint {
  path: string;
  description: string;
}

export function writeApi(
  out: string,
  site: { url: string; repo: string },
  store: Store,
  config: Config,
  all: CountryData[],
  main: CountryData,
  appPages: Set<string>,
): Endpoint[] {
  const put = (path: string, data: unknown) => {
    const file = join(out, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data));
  };

  for (const d of all) {
    const dir = `api/v1/${d.country}`;
    put(`${dir}/niches.json`, nichesView(d, config));
    put(`${dir}/movers.json`, moversView(d, config, 100));
    put(`${dir}/lists.json`, listsView(d, config));
    put(`${dir}/changes.json`, changesView(store, config, d));
    put(`${dir}/removed.json`, removedView(store, config, d.country));
    for (const chart of config.charts) put(`${dir}/charts/${chart}.json`, chartView(d, config, chart));
  }
  // The deep research (reviews, prices, search) only exists where it runs.
  for (const d of all.filter((d) => config.research.countries.includes(d.country))) {
    for (const c of d.niches) {
      const view = nicheView(store, config, d, c.term);
      if (view) put(`api/v1/${d.country}/niches/${encodeURIComponent(c.term)}.json`, view);
    }
  }
  for (const id of appPages) {
    const view = appView(store, config, main, id);
    if (view) put(`api/v1/${main.country}/apps/${id}.json`, view);
  }

  const c = main.country;
  const endpoints: Endpoint[] = [
    { path: `/api/v1/${c}/niches.json`, description: "Today's niches: the phrase, how many publishers share it, and their apps." },
    { path: `/api/v1/${c}/niches/${encodeURIComponent(main.niches[0]?.term ?? "meal planner")}.json`, description: `One niche in depth: search crowding, prices, complaint themes and review examples. Research countries only (${config.research.countries.join(", ")}).` },
    { path: `/api/v1/${c}/movers.json`, description: "Top-grossing climbers, fallers, arrivals, exits and first-time #1s since the previous scan." },
    { path: `/api/v1/${c}/lists.json`, description: "Small and paying, new and paying, likely solo developers, and earning without updates." },
    { path: `/api/v1/${c}/changes.json`, description: "Listing changes in the last 30 days: names, prices, in-app purchases, sellers and categories." },
    { path: `/api/v1/${c}/removed.json`, description: "Charting apps that vanished from the App Store, and any that came back." },
    ...config.charts.map((chart) => ({ path: `/api/v1/${c}/charts/${chart}.json`, description: `Today's ${chart.replace("-", " ")} chart for every category, with names and ratings.` })),
    ...(appPages.size ? [{ path: `/api/v1/${c}/apps/${[...appPages][0]}.json`, description: "One researched app: chart history, listing changes, in-app prices, star split, releases and complaints." }] : []),
  ];
  put("api/v1/index.json", {
    name: "App Store Scout",
    updated: main.date,
    countries: all.map((d) => d.country),
    research_countries: config.research.countries,
    endpoints: endpoints.map((e) => ({ url: `${site.url}${e.path}`, description: e.description })),
    license: "MIT",
    source: `https://github.com/${site.repo}`,
    note: "Ranks, ratings and prices are observed from Apple's public feeds. They are not downloads or revenue.",
  });
  return [{ path: "/api/v1/index.json", description: "This list, the scan date and the countries covered." }, ...endpoints];
}
