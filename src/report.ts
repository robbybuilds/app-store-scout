import { type Config, genreName } from "./config.ts";
import {
  type AppSignal,
  computeSignals,
  freshLaunches,
  genreSummaries,
  daysBetween,
  grossingClimbers,
  neglectedEarners,
  newAndPaying,
  ratingsMomentum,
  researchTargets,
  smallAndPaying,
  soloAndPaying,
  stayingPower,
} from "./signals.ts";
import { alsoSuggested, lowStarShare, type PageRow, releasesWithin, type SimilarRow, type VersionRow } from "./pages.ts";
import { formatPrice, type PeriodSummary, pricingSummary } from "./prices.ts";
import { CATALOGUE_LIMIT, looksLikeIndividual, type Publisher } from "./publishers.ts";
import { complaintThemes, isCritical, type Review } from "./reviews.ts";
import { ESTABLISHED_RATINGS, SEARCH_LIMIT } from "./search.ts";
import { parseSimilar } from "./volume.ts";
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

const PERIOD_LABELS: Record<string, string> = {
  weekly: "Weekly",
  monthly: "Monthly",
  yearly: "Yearly",
  lifetime: "Lifetime",
};

function periodText(p: PeriodSummary): string {
  const range = p.min === p.max ? "" : `, ${formatPrice(p.sample, p.min)} to ${formatPrice(p.sample, p.max)}`;
  return `${PERIOD_LABELS[p.period]} ${formatPrice(p.sample, p.median)} (${p.apps} app${p.apps === 1 ? "" : "s"}${range})`;
}

/** "3 apps" or "200+ apps" for a publisher's catalogue. */
function catalogueSize(p: Publisher | undefined): string {
  if (!p) return "?";
  return p.apps >= CATALOGUE_LIMIT ? `${CATALOGUE_LIMIT}+` : String(p.apps);
}

const stars = (n: number) => "★".repeat(n) + "☆".repeat(5 - n);
const pct = (share: number) => `${Math.round(share * 100)}%`;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// What the niche's App Store pages add: how unhappy users are, how often the apps ship,
// what their privacy labels admit to, and the competitors Apple shows next to them.
function pageLines(
  country: string,
  apps: AppSignal[],
  pages: Map<string, PageRow>,
  versions: Map<string, VersionRow[]>,
  similar: Map<string, SimilarRow[]>,
  today: string,
): string[] {
  const out: string[] = [];
  const read = apps.filter((s) => pages.has(s.appId));
  if (!read.length) return out;

  const shares = read
    .map((s) => ({ s, share: lowStarShare(pages.get(s.appId)!) }))
    .filter((x): x is { s: AppSignal; share: number } => x.share !== null)
    .sort((a, b) => b.share - a.share);
  if (shares.length) {
    const worst = shares.slice(0, 2).filter((x) => x.share >= 0.1).map((x) => `${appLink(x.s)} ${pct(x.share)}`);
    out.push(
      `**Star ratings:** in the median app, ${pct(median(shares.map((x) => x.share)))} of ratings are 1 or 2 stars` +
        (worst.length ? `. Least loved: ${worst.join(" · ")}` : "") +
        ".\n",
    );
  }

  const shipped = read.map((s) => releasesWithin(versions.get(s.appId) ?? [], today));
  const stale = apps.filter((s) => s.details?.updatedAt && daysBetween(s.details.updatedAt.slice(0, 10), today) >= 180).length;
  out.push(
    `**Updates:** the median app shipped ${plural(median(shipped), "release")} in the last 90 days` +
      (stale ? `; ${stale} of ${apps.length} haven't shipped one in 6 months` : "") +
      ".\n",
  );

  const labels = read.map((s) => pages.get(s.appId)!);
  const tracking = labels.filter((p) => p.privacy === "tracking").length;
  const none = labels.filter((p) => p.privacy === "none").length;
  out.push(
    `**Privacy labels:** ${tracking} of ${labels.length} apps use data to track you across other companies' apps` +
      (none ? `, and ${none} ${none === 1 ? "says it collects" : "say they collect"} nothing` : "") +
      ".\n",
  );

  const suggested = alsoSuggested(
    read.map((s) => similar.get(s.appId) ?? []),
    new Set(apps.map((s) => s.appId)),
  ).slice(0, 5);
  if (suggested.length) {
    const names = suggested.map(
      (x) => `[${cell(x.name)}](https://apps.apple.com/${country}/app/id${x.similar_id}) (${x.apps} of ${read.length})`,
    );
    out.push(`**Apple also suggests:** ${names.join(" · ")}. Apps Apple shows next to these that aren't in this niche's list.\n`);
  }
  return out;
}

// For each niche: how crowded its App Store search is, and what its apps' unhappy users say.
function nicheDetails(store: Store, config: Config, country: string, clusters: ReturnType<typeof researchTargets>["niches"]): string[] {
  const searches = store.readSearch(country);
  const volumes = store.readVolumes(country);
  const prices = store.readPrices(country);
  const publishers = store.readPublishers(country);
  const pages = store.readPages(country);
  const versions = store.readVersions(country);
  const similar = store.readSimilar(country);
  const today = store.dates(country).at(-1) ?? "";
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

    const volume = volumes.get(c.term);
    if (volume) {
      const cpc = volume.cpc ? `, and advertisers pay about $${volume.cpc.toFixed(2)} a click` : "";
      const related = parseSimilar(volume.similar).map((s) => `${cell(s.keyword)} (${num(s.volume)})`);
      out.push(
        `**Google searches:** "${cell(volume.keyword)}" gets about ${num(volume.volume)} a month in ${country.toUpperCase()}${cpc}` +
          (related.length ? `. Related: ${related.join(" · ")}` : "") +
          ` ([seodata.dev](https://www.seodata.dev), ${volume.checked_at}).\n`,
      );
    }

    const pricing = pricingSummary(c.apps.map((s) => prices.get(s.appId) ?? []));
    if (pricing.checked) {
      // "Premium", tip jars and credit packs don't say how long they last, so they get a count, not a price.
      const named = pricing.periods.filter((p) => p.period !== "other");
      const other = pricing.periods.find((p) => p.period === "other");
      out.push(
        `**Pricing:** ${pricing.selling} of ${pricing.checked} apps list in-app purchases on their App Store page.` +
          (named.length ? ` Median price per app: ${named.map(periodText).join(" · ")}.` : "") +
          (other ? ` ${other.apps} app${other.apps === 1 ? " sells" : "s sell"} purchases whose names don't say the plan length.` : "") +
          "\n",
      );
    }

    const known = c.apps.filter((s) => s.details?.seller);
    if (known.length) {
      const individuals = known.filter((s) => looksLikeIndividual(s.details!.seller)).length;
      const catalogues = c.apps.map((s) => publishers.get(s.details?.publisherId ?? "")).filter((p): p is Publisher => !!p);
      const oneApp = catalogues.filter((p) => p.apps === 1).length;
      out.push(
        `**Who makes them:** ${individuals} of ${known.length} apps are sold under a person's own name (likely solo developers)` +
          (catalogues.length ? `, and ${oneApp} of ${catalogues.length} publishers have no other app` : "") +
          ".\n",
      );
    }

    out.push(...pageLines(country, c.apps, pages, versions, similar, today));

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
      "One app can be luck or a big ad budget; three unrelated publishers earning with the same idea is a niche. " +
      "At most two niches per genre, so one category can't fill the list.\n",
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
      const related = c.related.length ? ` (also ${c.related.map(cell).join(", ")})` : "";
      out.push(`| **${cell(c.term)}**${related} | ${c.publishers} | ${examples.join(", ")}${more} |`);
    }
    out.push("");
  }

  if (config.research.countries.includes(country)) {
    out.push(...nicheDetails(store, config, country, clusters));
  } else {
    out.push(
      `_Search, reviews and prices are researched for ${config.research.countries.map((c) => c.toUpperCase()).join(", ")} only. ` +
        `Add "${country}" to \`research.countries\` in scout.config.json to research this country too._\n`,
    );
  }

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

  out.push("## Solo developers earning\n");
  out.push(
    "On a top-grossing chart and sold under a person's own name rather than a company's. Apple shows an individual " +
      "developer's legal name as the seller, so these are very likely one person. It's a guess from the name.\n",
  );
  const publishers = store.readPublishers(country);
  out.push(
    table(config, soloAndPaying(signals), {
      title: "Their apps",
      value: (s) => catalogueSize(publishers.get(s.details?.publisherId ?? "")),
    }),
  );

  out.push("## Small and paying\n");
  out.push(`On a top-grossing chart with fewer than ${num(small)} ratings: earning without a huge audience.\n`);
  out.push(table(config, smallAndPaying(signals, config), { title: "Avg rating", value: (s) => String(s.details?.averageRating ?? "?") }));

  out.push("## New and paying\n");
  out.push(`Released in the last ${newDays} days and already on a top-grossing chart. Most new apps never get here.\n`);
  out.push(table(config, newAndPaying(signals, config), { title: "Age (days)", value: (s) => num(s.ageDays) }));

  out.push("## Earning without updates\n");
  out.push(
    "On a top-grossing chart but not updated in over a year. People still pay for these apps while their " +
      "developers seem to have moved on: their 1 to 3 star reviews are a list of what to fix in a rival.\n",
  );
  out.push(
    table(config, neglectedEarners(signals, latest.date), {
      title: "Last update",
      value: (s) => s.details!.updatedAt.slice(0, 10),
    }),
  );

  if (config.research.countries.includes(country) && config.research.newApps) {
    const since = new Date(Date.parse(latest.date) - config.research.trackNewAppsDays * 86_400_000).toISOString().slice(0, 10);
    const followed = store.newAppsSince(country, since);
    out.push("## Fresh launches gaining ratings\n");
    out.push(
      `Apps that appeared in Apple's new-releases feeds in the last ${config.research.trackNewAppsDays} days ` +
        `(${num(followed.size)} so far), by ratings gained per day since release. A top-grossing rank means it has already reached a chart.\n`,
    );
    out.push(
      table(config, freshLaunches(signals, followed, latest, store.readApps(country)), {
        title: "Ratings a day",
        value: (s) => (s.ratingCount! / Math.max(1, s.ageDays!)).toFixed(1),
      }),
    );
  }

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
