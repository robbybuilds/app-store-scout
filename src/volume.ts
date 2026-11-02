// Monthly Google search volume for a niche, from seodata.dev (a third-party service, not Apple).
// Free: 20 lookups a day without a key, 50 with a free key in SEODATA_KEY. Volumes are monthly,
// so each niche is looked up at most once every 30 days.

export interface Volume {
  term: string;
  /** What was looked up: the niche phrase plus "app". */
  keyword: string;
  volume: number;
  /** What advertisers pay per click, in USD: a rough sign that the searchers spend money. */
  cpc: number;
  competition: number;
  /** Related phrases with their volumes, "phrase:volume" joined by "; ". */
  similar: string;
  checked_at: string;
}

export const RECHECK_DAYS = 30;

export const volumeKeyword = (term: string) => `${term} app`;

export function volumeUrl(keyword: string, country: string): string {
  return `https://api.seodata.dev/v1/keyword?q=${encodeURIComponent(keyword).replace(/%20/g, "+")}&country=${country}`;
}

interface RawVolume {
  volume?: number;
  cpc?: number;
  competition?: number;
  similar?: { keyword: string; volume: number }[];
}

export function parseVolume(json: unknown, term: string, checkedAt: string): Volume {
  const raw = json as RawVolume;
  const similar = (raw.similar ?? [])
    .filter((s) => s.keyword && s.volume > 0)
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 3)
    .map((s) => `${s.keyword.replace(/[;:]/g, " ")}:${s.volume}`)
    .join("; ");
  return {
    term,
    keyword: volumeKeyword(term),
    volume: raw.volume ?? 0,
    cpc: raw.cpc ?? 0,
    competition: raw.competition ?? 0,
    similar,
    checked_at: checkedAt,
  };
}

export function parseSimilar(similar: string): { keyword: string; volume: number }[] {
  return similar
    .split("; ")
    .filter(Boolean)
    .map((s) => {
      const i = s.lastIndexOf(":");
      return { keyword: s.slice(0, i), volume: Number(s.slice(i + 1)) };
    });
}

export class DailyLimitReached extends Error {}

/** One lookup. A keyword nobody searches for comes back as a 404 with volume 0. */
export async function fetchVolume(term: string, country: string, checkedAt: string, key?: string): Promise<Volume> {
  const res = await fetch(volumeUrl(volumeKeyword(term), country), {
    headers: key ? { authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 429) throw new DailyLimitReached("seodata.dev daily limit reached");
  if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status} from seodata.dev`);
  return parseVolume(await res.json(), term, checkedAt);
}

export function isStale(v: Volume | undefined, today: string): boolean {
  return !v || Date.parse(today) - Date.parse(v.checked_at) >= RECHECK_DAYS * 86_400_000;
}
