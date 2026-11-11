// An Atom feed: one entry for today's scan and one for each niche on the day it was first
// spotted. Feed readers can follow it, and newsletter tools can turn it into an email.

import type { Movers } from "./movers.ts";
import type { NicheHistory } from "./store.ts";

export interface FeedInput {
  url: string;
  date: string;
  /** How the country reads in a sentence: "US". */
  country: string;
  history: NicheHistory[];
  movers: Movers;
  name: (appId: string) => string;
}

const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const slug = (term: string) => term.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "niche";
const list = (items: string[]) => (items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items[0] ?? "");

export function buildFeed(f: FeedInput): string {
  const stamp = (date: string) => `${date}T14:00:00Z`;
  const live = f.history.filter((h) => h.lastSeen === f.date).map((h) => h.term);
  const climbs = f.movers.climbers.slice(0, 3).map((m) => `${f.name(m.appId) || m.appId} (up ${m.change} to #${m.rank})`);
  const today = [
    live.length ? `Niches earning on ${f.country} top-grossing charts: ${list(live)}.` : "",
    climbs.length ? `Biggest climbs: ${list(climbs)}.` : "",
  ].filter(Boolean).join(" ");

  const entries = [
    { id: `${f.url}/#${f.date}`, link: `${f.url}/`, title: `App Store Scout, ${f.date}`, updated: f.date, summary: today || "Today's scan is in." },
    ...[...f.history]
      .sort((a, b) => b.firstSeen.localeCompare(a.firstSeen) || a.term.localeCompare(b.term))
      .slice(0, 30)
      .map((h) => {
        const apps = h.appIds.map(f.name).filter(Boolean).slice(0, 3);
        return {
          id: `${f.url}/niches/${slug(h.term)}/`,
          link: `${f.url}/niches/${slug(h.term)}/`,
          title: `New niche: ${h.term}`,
          updated: h.firstSeen,
          summary: `${h.appIds.length} new or small apps from different publishers were earning with “${h.term}” on ${f.country} top-grossing charts${apps.length ? `, among them ${list(apps)}` : ""}.`,
        };
      }),
  ];

  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>App Store Scout</title>
<subtitle>Where small apps earn: new niches from Apple's charts, every day.</subtitle>
<link href="${esc(f.url)}/feed.xml" rel="self"/>
<link href="${esc(f.url)}/"/>
<id>${esc(f.url)}/</id>
<updated>${stamp(f.date)}</updated>
<author><name>App Store Scout</name></author>
${entries
  .map((e) => `<entry><title>${esc(e.title)}</title><link href="${esc(e.link)}"/><id>${esc(e.id)}</id><updated>${stamp(e.updated)}</updated><summary>${esc(e.summary)}</summary></entry>`)
  .join("\n")}
</feed>
`;
}
