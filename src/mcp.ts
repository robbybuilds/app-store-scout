// A Model Context Protocol server over stdio, so Claude, Cursor or any agent can ask Scout
// questions. It reads the CSV files in this copy of the repo: no account, no key, no call limit.
// The protocol is JSON-RPC 2.0, one message per line, small enough to speak without a library.

import { createInterface } from "node:readline";
import { CHARTS, type Chart, type Config } from "./config.ts";
import type { Store } from "./store.ts";
import {
  appView,
  changesView,
  chartView,
  type CountryData,
  countryData,
  listsView,
  moversView,
  nichesView,
  nicheView,
  removedView,
  searchView,
} from "./views.ts";

type Args = Record<string, unknown>;

interface Tool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, object>; required?: string[] };
  run: (args: Args) => unknown;
}

const PROTOCOL = "2025-06-18";

export function createServer(store: Store, config: Config) {
  const cache = new Map<string, CountryData>();
  const main = config.research.countries[0] ?? config.countries[0];
  const load = (args: Args): CountryData => {
    const country = String(args.country ?? main).toLowerCase();
    if (!config.countries.includes(country)) throw new Error(`Unknown country "${country}". Scanned countries: ${config.countries.join(", ")}.`);
    const have = cache.get(country) ?? countryData(store, config, country);
    if (!have) throw new Error(`No data for "${country}" yet. Run: npm run scan`);
    cache.set(country, have);
    return have;
  };
  const country = { type: "string", description: `Two-letter App Store country. One of: ${config.countries.join(", ")}. Default ${main}.` };
  const limit = (args: Args, fallback: number, max = 200) => Math.max(1, Math.min(max, Number(args.limit ?? fallback) || fallback));
  const genreId = (name: unknown): number | undefined => {
    if (name === undefined || name === "") return undefined;
    const g = config.genres.find((g) => g.name.toLowerCase() === String(name).toLowerCase() || String(g.id) === String(name));
    if (!g) throw new Error(`Unknown category "${name}". Categories: ${config.genres.map((g) => g.name).join(", ")}.`);
    return g.id;
  };

  const tools: Tool[] = [
    {
      name: "list_niches",
      description:
        "Today's niches in one country: phrases shared by the names of new or small apps from 3+ different publishers that are all on a top-grossing chart. Start here to find app ideas with proven demand. Returns each niche's apps with their grossing rank.",
      inputSchema: { type: "object", properties: { country } },
      run: (a) => nichesView(load(a), config),
    },
    {
      name: "get_niche",
      description:
        `One niche in depth: its apps, how crowded an App Store search for it is, what the apps charge per week, month and year, monthly Google searches, and what 1 to 3 star reviews complain about, with review examples. Works for today's niches and past ones. The deep research only exists in: ${config.research.countries.join(", ")}.`,
      inputSchema: { type: "object", properties: { term: { type: "string", description: 'The niche phrase from list_niches, e.g. "meal planner".' }, country }, required: ["term"] },
      run: (a) => {
        const d = load(a);
        const view = nicheView(store, config, d, String(a.term ?? ""));
        if (!view) throw new Error(`No niche "${a.term}" in ${d.country}. Call list_niches for today's, or search_apps to explore a word.`);
        return view;
      },
    },
    {
      name: "get_movers",
      description:
        "What moved on the top-grossing charts since the previous daily scan: biggest climbers and fallers, apps that just arrived (flagged when it is their first time), apps that left, and first-time #1s. A rank change is not a revenue figure.",
      inputSchema: { type: "object", properties: { country, limit: { type: "number", description: "Rows per list, 1 to 200. Default 25." } } },
      run: (a) => moversView(load(a), config, limit(a, 25)),
    },
    {
      name: "get_lists",
      description:
        "Four ready-made lists of apps on a top-grossing chart today: small and paying (few ratings), new and paying (released in the last year), likely solo developers (sold under a person's name), and earning without updates (not updated in a year).",
      inputSchema: { type: "object", properties: { country, limit: { type: "number", description: "Rows per list, 1 to 200. Default 25." } } },
      run: (a) => listsView(load(a), config, limit(a, 25)),
    },
    {
      name: "search_apps",
      description:
        "Search the apps on today's tracked charts by words in the name, publisher or category. Every word must match. Use it to size up an idea: how many apps share a word, how many of them are earning, from how many publishers. Only covers apps in a top 100, not the whole App Store.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: 'Words to match, e.g. "fasting" or "budget planner". Empty lists everything the filters allow.' },
          country,
          grossing_only: { type: "boolean", description: "Only apps on a top-grossing chart." },
          small_only: { type: "boolean", description: `Only apps with fewer than ${config.report.smallAppMaxRatings} ratings.` },
          new_only: { type: "boolean", description: `Only apps released in the last ${config.report.newAppMaxAgeDays} days.` },
          limit: { type: "number", description: "Most apps to return, 1 to 200. Default 50." },
        },
      },
      run: (a) => searchView(load(a), config, String(a.query ?? ""), { grossingOnly: !!a.grossing_only, smallOnly: !!a.small_only, newOnly: !!a.new_only, limit: limit(a, 50) }),
    },
    {
      name: "get_app",
      description:
        "One app by its App Store id: today's chart places, its top-grossing rank and rating count day by day, every listing change Scout saw (renames, price changes, in-app purchases added or repriced), and for researched apps its in-app purchase prices, star split, privacy label, release dates, the apps Apple suggests next to it and what its worst reviews say. Get the id from any other tool.",
      inputSchema: { type: "object", properties: { app_id: { type: "string", description: "The numeric App Store id, e.g. 6777471316." }, country }, required: ["app_id"] },
      run: (a) => {
        const d = load(a);
        const view = appView(store, config, d, String(a.app_id ?? "").replace(/^id/, ""));
        if (!view) throw new Error(`Scout has never seen app ${a.app_id} on a ${d.country} chart.`);
        return view;
      },
    },
    {
      name: "get_listing_changes",
      description:
        "Apps that changed their listing recently: new names (often an App Store search play), price changes, in-app purchases added, dropped or repriced, new sellers (the app may have been sold) and category moves. Apps on a top-grossing chart come first within each day.",
      inputSchema: { type: "object", properties: { country, days: { type: "number", description: "How far back to look, 1 to 365. Default 30." }, limit: { type: "number", description: "Most changes to return. Default 100." } } },
      run: (a) => changesView(store, config, load(a), Math.max(1, Math.min(365, Number(a.days ?? 30) || 30)), limit(a, 100, 500)),
    },
    {
      name: "get_removed_apps",
      description:
        "Apps that were on a chart and then vanished from one country's App Store, with their best chart place, the day Scout found them missing and whether they came back. A removed app that was earning leaves customers looking for a replacement.",
      inputSchema: { type: "object", properties: { country } },
      run: (a) => removedView(store, config, load(a).country),
    },
    {
      name: "get_chart",
      description:
        "Today's chart in rank order, with each app's name, publisher, rating count and release date. Top-grossing is the one that says who earns. Give a category to get one chart of 100; without one you get every category.",
      inputSchema: {
        type: "object",
        properties: {
          chart: { type: "string", enum: config.charts, description: "Default top-grossing." },
          category: { type: "string", description: `A category name, e.g. "Food & Drink", or "All apps" for the overall chart. One of: ${config.genres.map((g) => g.name).join(", ")}.` },
          country,
        },
      },
      run: (a) => {
        const chart = String(a.chart ?? "top-grossing") as Chart;
        if (!CHARTS.includes(chart) || !config.charts.includes(chart)) throw new Error(`Unknown chart "${chart}". Charts: ${config.charts.join(", ")}.`);
        return chartView(load(a), config, chart, genreId(a.category));
      },
    },
  ];

  /** Answers one JSON-RPC message. Returns null for notifications, which get no reply. */
  function handle(message: { id?: unknown; method?: string; params?: { name?: string; arguments?: Args; protocolVersion?: string } }): object | null {
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id: message.id, result });
    if (message.id === undefined || message.id === null) return null;
    switch (message.method) {
      case "initialize":
        return reply({
          protocolVersion: message.params?.protocolVersion ?? PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: "app-store-scout", version: "0.2.0" },
          instructions:
            "App Store Scout: daily App Store chart data for finding app ideas. Ranks, ratings and prices are observed from Apple's public feeds and are never downloads or revenue; don't present them as such. Start with list_niches, then get_niche for one that looks promising.",
        });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: tools.map(({ run: _run, ...t }) => ({ ...t, annotations: { readOnlyHint: true } })) });
      case "tools/call": {
        const tool = tools.find((t) => t.name === message.params?.name);
        if (!tool) return { jsonrpc: "2.0", id: message.id, error: { code: -32602, message: `Unknown tool: ${message.params?.name}` } };
        try {
          return reply({ content: [{ type: "text", text: JSON.stringify(tool.run(message.params?.arguments ?? {})) }] });
        } catch (error) {
          return reply({ content: [{ type: "text", text: (error as Error).message }], isError: true });
        }
      }
      default:
        return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } };
    }
  }

  return { tools, handle };
}

/** Serves until stdin closes. Only protocol messages go to stdout; anything else would corrupt the stream. */
export function serve(store: Store, config: Config): Promise<void> {
  const server = createServer(store, config);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let response: object | null;
    try {
      response = server.handle(JSON.parse(line));
    } catch {
      response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
    }
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  });
  return new Promise((resolve) => lines.on("close", resolve));
}
