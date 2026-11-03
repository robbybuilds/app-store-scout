// Who makes an app: one person or a company, and how many other apps they publish.
// Both come from the iTunes Lookup API: every app's seller name, and a publisher's catalogue
// (lookup?id=<publisher id>&entity=software). No key.

import { fetchJson } from "./apple.ts";

export interface Publisher {
  publisher_id: string;
  publisher: string;
  /** Apps in the publisher's catalogue in this country. Apple stops at 200. */
  apps: number;
  /** Ratings across all of them. */
  total_ratings: number;
  checked_at: string;
}

export const CATALOGUE_LIMIT = 200;
export const RECHECK_DAYS = 30;

// Legal forms. Each word is checked whole, without dots ("S.L." is "sl") and split on dots
// and hyphens ("PTE.LIMITED", "FZ-LLC"), so every way of writing them is caught.
const LEGAL = new Set(
  ("inc incorporated llc ltd limited co corp corporation company gmbh ug ag ab as a/s asa aps oy oyj se sa sas sarl " +
    "srl spa sl slu sro bv bvba nv pty pte plc llp lp pllc pc kk ooo oao zao fzco fze fzllc ou oü og kg gbr ohg " +
    "lda ltda bhd sdn pt tbk cc mfg pbc sp oo trust").split(" "),
);

// Words in the names of organisations and brands, rarely in a person's.
const ORGANISATION = new Set(
  ("academy administration agency america american analytics app apps association bancorp bank bay center centre " +
    "city club college commission council county creative credit databases decisions department digital education " +
    "elearning electronics entertainment express federal financial foundation games grill group health hospital " +
    "images institute instruments insurance interactive international investments labs learning markets media " +
    "medical mobile money motor motors mutual national network office organization pharmacy publishing school " +
    "service services shop society software solutions state states storage studio studios systems tech technologies " +
    "technology university united ventures wireless workshop").split(" "),
);

// "Core of the Heart" and "Simon & Schuster" are names of things, not people.
// ("de", "van" and "dall'" stay allowed: they're common in people's names.)
const LINKING = new Set("of the and a an for so by to at in on with &".split(" "));

/**
 * Apple sells an individual developer's apps under their own legal name, and a company's
 * under the company's. So a seller with two to four words, no digits, no legal form and no
 * organisation words is very likely one person. It's a guess from the name, so the report says "likely".
 */
export function looksLikeIndividual(seller: string): boolean {
  const name = seller.trim();
  if (!name || /\d/.test(name) || /\bn\.a\.?$/i.test(name)) return false;
  const words = name.split(/[\s,]+/).filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;
  const pieces = words.flatMap((w) => {
    const lower = w.toLowerCase().replace(/[()]/g, "");
    return [lower, lower.replace(/[.'’]/g, ""), ...lower.split(/[.-]/)];
  });
  if (pieces.some((w) => LEGAL.has(w) || ORGANISATION.has(w) || LINKING.has(w))) return false;
  // An acronym next to ordinary words, like "CBS Mobile" or "LG Electronics". A name written
  // all in capitals ("HONGBO WANG") is fine.
  const acronym = (w: string) => /^\p{Lu}{2,4}$/u.test(w);
  return !(words.some(acronym) && words.some((w) => w !== w.toUpperCase()));
}

export function catalogueUrl(country: string, publisherId: string): string {
  return `https://itunes.apple.com/lookup?id=${publisherId}&entity=software&limit=${CATALOGUE_LIMIT}&country=${country}`;
}

interface RawCatalogueItem {
  wrapperType?: string;
  artistId?: number;
  artistName?: string;
  userRatingCount?: number;
}

export function parseCatalogue(json: unknown, publisherId: string, checkedAt: string): Publisher {
  const results = (json as { results?: RawCatalogueItem[] }).results ?? [];
  const apps = results.filter((r) => r.wrapperType === "software" && String(r.artistId) === publisherId);
  const artist = results.find((r) => r.wrapperType === "artist");
  return {
    publisher_id: publisherId,
    publisher: artist?.artistName ?? apps[0]?.artistName ?? "",
    apps: apps.length,
    total_ratings: apps.reduce((sum, r) => sum + (r.userRatingCount ?? 0), 0),
    checked_at: checkedAt,
  };
}

export async function fetchPublisher(country: string, publisherId: string, checkedAt: string): Promise<Publisher> {
  return parseCatalogue(await fetchJson(catalogueUrl(country, publisherId)), publisherId, checkedAt);
}

export function isStale(p: Publisher | undefined, today: string): boolean {
  return !p || Date.parse(today) - Date.parse(p.checked_at) >= RECHECK_DAYS * 86_400_000;
}
