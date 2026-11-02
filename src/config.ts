import { readFileSync } from "node:fs";

export type Chart = "top-free" | "top-paid" | "top-grossing";

export interface Genre {
  /** Apple genre id; 0 means the overall chart. */
  id: number;
  name: string;
}

export interface Config {
  countries: string[];
  charts: Chart[];
  genres: Genre[];
  report: {
    /** Apps on a grossing chart with fewer ratings than this count as "small". */
    smallAppMaxRatings: number;
    /** Apps released within this many days count as "new". */
    newAppMaxAgeDays: number;
    listSize: number;
  };
}

export const CHARTS: Chart[] = ["top-free", "top-paid", "top-grossing"];

export function loadConfig(path = "scout.config.json"): Config {
  const config = JSON.parse(readFileSync(path, "utf8")) as Config;
  for (const chart of config.charts) {
    if (!CHARTS.includes(chart)) throw new Error(`Unknown chart "${chart}" in ${path}`);
  }
  return config;
}

export function genreName(config: Config, id: number): string {
  return config.genres.find((g) => g.id === id)?.name ?? `Genre ${id}`;
}
