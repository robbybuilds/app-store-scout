import { type Config, genreName } from "./config.ts";
import {
  type AppSignal,
  computeSignals,
  genreSummaries,
  grossingClimbers,
  newAndPaying,
  ratingsMomentum,
  researchTargets,
  smallAndPaying,
  stayingPower,
} from "./signals.ts";
import { complaintThemes, isCritical, type Review } from "./reviews.ts";
import { ESTABLISHED_RATINGS, SEARCH_LIMIT } from "./search.ts";
import type { Store } from "./store.ts";

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");
const num = (n: number | null) => (n === null ? "?" : n.toLocaleString("en-US"));

function appLink(s: AppSignal): string {
  const name = cell(s.details?.name ?? s.appId);
  return s.details?.url ? `[${name}](${s.details.url})` : name;
}

function position(config: Config, p: AppSignal["grossing"]): string {
  return p ? `#${p.rank} ${genreName(config, p.genreId)}` : "";
}

function table(config: Config, rows: AppSignal[], extra: { title: string; value: (s: AppSignal) => string }): string {
  if (!rows.length) return "_Nothing matched today._\n";
  const lines = [
    `| | App | Publisher | Top grossing | ${extra.title} | Ratings | Released |`,
    "|--:|---|---|---|--:|--:|---|",
  ];
  rows.slice(0, config.report.listSize).forEach((s, i) => {
    lines.push(
      `| ${i + 1} | ${appLink(s)} | ${cell(s.details?.publisher ?? "")} | ${position(config, s.grossing)} | ` +
        `${extra.value(s)} | ${num(s.ratingCount)} | ${s.details?.releasedAt ?? ""} |`,
    );
  });
  return lines.join("\n") + "\n";
}

const stars = (n: number) => "★".repeat(n) + "☆".repeat(5 - n);
const pct = (share: number) => `${Math.round(share * 100)}%`;

// For each niche: how crowded its App Store search is, and what its apps' unhappy users say.
function nicheDetails(store: Store, config: Config, country: string, clusters: ReturnType<typeof researchTargets>["niches"]): string[] {
  const searches = store.readSearch(country);
  const out: string[] = [];
  out.push("## Inside each niche\n");
  out.push(
    "What a customer sees when they search the App Store for the niche, and what the niche's apps get " +
      "criticised for in their 1 to 3 star reviews. Complaints are the spec for a better version.\n",
  );
  if (!searches.size) {
    out.push("_Run `npm run research` (or a full `npm run scan`) to fill this in._\n");
    return out;
  }

  for (const c of clusters) {
    out.push(`### ${c.term}\n`);
    const search = searches.get(c.term);
    if (search) {
      const { results, established, new_apps, top10_median_ratings } = search.summary;
      const count = results >= SEARCH_LIMIT ? `${SEARCH_LIMIT}+` : String(results);
      out.push(
        `**Search:** ${count} results for "${c.term}" (Apple returns at most ${SEARCH_LIMIT}). ${established} have ${num(ESTABLISHED_RATINGS)}+ ratings, ` +
          `${new_apps} came out in the last ${config.report.newAppMaxAgeDays} days. ` +
          `The top 10 have a median of ${num(top10_median_ratings)} ratings.\n`,
      );
      if (search.top.length) {
        const top = search.top.slice(0, 5).map((t) => `${t.position}. ${cell(t.name)} (${num(t.rating_count)})`);
        out.push(`**Top search results:** ${top.join(" · ")}\n`);
      }
    }

    const reviews: (Review & { app: string })[] = c.apps.flatMap((s) =>
      store.readReviews(country, s.appId).map((r) => ({ ...r, app: s.details?.name ?? s.appId })),
    );
    const { critical, themes } = complaintThemes(reviews);
    if (!critical) {
      out.push("_No 1 to 3 star reviews collected yet._\n");
      continue;
    }
    out.push(
      `**Complaints** in ${num(critical)} reviews with 1 to 3 stars: ` +
        (themes.length ? themes.slice(0, 4).map((t) => `${t.name} ${pct(t.share)}`).join(" · ") : "no common theme") +
        "\n",
    );
    const recent = reviews
      .filter(isCritical)
      .sort((a, b) => a.rating - b.rating || b.date.localeCompare(a.date))
      .filter((r) => r.title)
      .slice(0, 3)
      .map((r) => `- ${stars(r.rating)} "${cell(r.title)}" (${cell(r.app)}, ${r.date})`);
    out.push("Worst first, newest first:\n");
    out.push(recent.join("\n") + "\n");
  }
  return out;
}

export function buildReport(store: Store, config: Config, country: string): string {
  const snapshots = store.recent(country, 30);
  const latest = snapshots.at(-1);
  if (!latest) throw new Error(`No snapshots for "${country}" yet. Run: npm run scan`);

  const signals = computeSignals(snapshots, store.readApps(country));
  const { smallAppMaxRatings: small, newAppMaxAgeDays: newDays } = config.report;
  const span = snapshots.length > 1 ? `${snapshots[0].date} to ${latest.date}` : latest.date;
  const out: string[] = [];

  out.push(`# App Store Scout: ${country.toUpperCase()}, ${latest.date}\n`);
  out.push(
    `${snapshots.length} daily snapshot${snapshots.length === 1 ? "" : "s"} (${span}), ` +
      `${signals.length} apps on the tracked charts.\n`,
  );
  out.push(
    "> Ranks, ratings and release dates are observed from Apple's public feeds. " +
      "They are **not** downloads, revenue or profit. A top-grossing rank says an app " +
      "earns more than its neighbours in that chart, nothing more. See " +
      "[the guide](../../docs/guide.md) for how to turn this into research.\n",
  );

  out.push("## Niches where newcomers are earning\n");
  out.push(
    "Phrases shared by new or small apps from **different publishers** that are all on a top-grossing chart today. " +
      "One app can be luck or a big ad budget; three unrelated publishers earning with the same idea is a niche.\n",
  );
  const clusters = researchTargets(signals, config).niches;
  if (!clusters.length) {
    out.push("_No clusters today._\n");
  } else {
    out.push("| Niche | Publishers | Examples (top-grossing rank) |");
    out.push("|---|--:|---|");
    for (const c of clusters) {
      const examples = c.apps.slice(0, 3).map((s) => `${appLink(s)} (#${s.grossing!.rank} ${genreName(config, s.grossing!.genreId)})`);
      const more = c.apps.length > 3 ? ` +${c.apps.length - 3} more` : "";
      out.push(`| **${cell(c.term)}** | ${c.publishers} | ${examples.join(", ")}${more} |`);
    }
    out.push("");
  }

  out.push(...nicheDetails(store, config, country, clusters));

  out.push("## Genres at a glance\n");
  out.push(
    `How crowded each genre's top-grossing chart looks. More new apps (released in the last ${newDays} days) ` +
      `and more small apps (under ${num(small)} ratings) suggest newcomers can still earn there.\n`,
  );
  out.push("| Genre | Apps on chart | New apps | Small apps | Median ratings |");
  out.push("|---|--:|--:|--:|--:|");
  for (const g of genreSummaries(latest, signals, config)) {
    out.push(
      `| ${genreName(config, g.genreId)} | ${g.grossingApps} | ${g.newApps} | ${g.smallApps} | ${num(g.medianRatings)} |`,
    );
  }
  out.push("");

  out.push("## Small and paying\n");
  out.push(`On a top-grossing chart with fewer than ${num(small)} ratings: earning without a huge audience.\n`);
  out.push(table(config, smallAndPaying(signals, config), { title: "Avg rating", value: (s) => String(s.details?.averageRating ?? "?") }));

  out.push("## New and paying\n");
  out.push(`Released in the last ${newDays} days and already on a top-grossing chart. Most new apps never get here.\n`);
  out.push(table(config, newAndPaying(signals, config), { title: "Age (days)", value: (s) => num(s.ageDays) }));

  out.push("## Climbing the grossing charts\n");
  if (snapshots.length < 8) {
    out.push("_Needs 7 days of snapshots. Keep the daily scan running._\n");
  } else {
    out.push("Places gained on the same top-grossing chart over the last 7 days.\n");
    out.push(table(config, grossingClimbers(signals), { title: "Places gained", value: (s) => `+${s.grossingRankChange7}` }));
  }

  out.push("## Ratings momentum\n");
  if (snapshots.length < 8) {
    out.push("_Needs 7 days of snapshots. Keep the daily scan running._\n");
  } else {
    out.push("Fastest ratings growth over 7 days relative to size. Ratings are a rough proxy for new users.\n");
    out.push(table(config, ratingsMomentum(signals), { title: "New ratings (7d)", value: (s) => `+${num(s.ratingDelta7)}` }));
  }

  out.push("## Staying power\n");
  if (snapshots.length < 14) {
    out.push("_Needs 14 days of snapshots._\n");
  } else {
    out.push(`New apps that were on a chart at least two thirds of the last ${snapshots.length} days.\n`);
    out.push(table(config, stayingPower(signals, config), { title: "Days on chart", value: (s) => `${s.daysOnChart}/${s.windowDays}` }));
  }

  out.push("## What to do with this\n");
  out.push(
    "Pick 3 to 5 apps from the lists above and fill in [the shortlist template](../../templates/shortlist.md): " +
      "what it does, who pays, evidence of traction, what reviewers complain about, and a narrower version you could build.\n",
  );
  return out.join("\n");
}
