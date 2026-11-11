# App Store Scout

**Find app ideas that are already making money.**

Every day, App Store Scout reads Apple's top-grossing charts and points out niches where several *different* publishers' new or small apps are all earning. Then it searches the App Store for each niche to see how crowded it is, reads those apps' 1, 2 and 3 star reviews to find what customers are unhappy about, checks what they charge, and flags the ones built by a single developer. It's free and open source, and it runs on GitHub Actions in your own fork.

**[See today's niches on the website](https://robbybuilds.github.io/app-store-scout/)** or [read the Markdown report](reports/us/latest.md).

![App Store Scout: niches where new and small apps are earning on the US top-grossing charts](docs/assets/social-card.png)

## What it found on day one

On 2 November 2026, the US Food & Drink top-grossing chart had **meal planners from 12 different publishers** on it. Four of them (mise, Whipp, NeatEat and Potto) launched this summer and were sitting at #4, #5, #8 and #11.

The same scan turned up AI note takers (4 publishers), AI video generators (4) and AI medical scribes (3). One app on a chart can be luck or a big ad budget. Several unrelated small teams earning with the same idea usually means real demand.

It also read 512 critical reviews of meal planner apps. **63% of them mention price, subscriptions or free trials.** A meal planner that's honest about its pricing has a head start.

## Get your own daily scan in 3 clicks

1. Click **Fork** at the top of this page.
2. In your fork, open the **Actions** tab and click **"I understand my workflows, go ahead and enable them"**.
3. Open **Actions → Daily scan → Run workflow**.

For your own copy of the website too, open **Settings → Pages** and set **Source** to **GitHub Actions**. The site rebuilds after every scan at `https://<you>.github.io/app-store-scout/`, also for free.

The first run takes a little over an hour, because it reads every app's recent reviews once. Then your fork has its first snapshots and fresh reports, one per country. After that it scans every day at 14:00 UTC and keeps a dated copy of the report every Monday. GitHub runs it for free on public repos.

Out of the box it scans 41 categories (every app category, Games and 16 game subgenres) in 8 countries: the US, UK, Canada, Australia, Germany, France, Japan and South Korea. The deeper research (App Store searches, reviews, prices and new releases) runs for the US only, because it takes longer and the complaint themes only read English. To change either, edit [`scout.config.json`](scout.config.json): `countries` for charts, `research.countries` for research.

To skip reading App Store pages (prices, star breakdowns, version history, privacy labels and similar apps), set `"pages": false` in the config.

Optional: Google search volumes come from [seodata.dev](https://www.seodata.dev), which allows 20 free lookups a day without a key. Each niche is looked up once a month, so that's usually enough. For 50 a day, get a free key there and add it in your fork under **Settings → Secrets and variables → Actions** as `SEODATA_KEY`. To turn it off, set `"searchVolume": false` in the config.

## What's in the daily report

| Section | What it shows | Ready after |
|---|---|---|
| **Niches where newcomers are earning** | Phrases shared by new or small apps from 3+ publishers on grossing charts | Day 1 |
| **Inside each niche** | How crowded the App Store search is, the top results, monthly Google searches, what the apps charge, who makes them, how many of their ratings are 1 or 2 stars, how often they ship updates, their privacy labels, the competitors Apple suggests next to them, and what 1 to 3 star reviews complain about | Day 1 |
| **Genres at a glance** | How many new and small apps made each category's grossing chart | Day 1 |
| **Solo developers earning** | Apps on a grossing chart sold under a person's own name, with how many apps that developer has | Day 1 |
| **Small and paying** | Apps on a grossing chart with fewer than 5,000 ratings | Day 1 |
| **New and paying** | Apps released in the last year that are already on a grossing chart | Day 1 |
| **Earning without updates** | Apps on a grossing chart whose developer hasn't shipped an update in over a year | Day 1 |
| **Fresh launches gaining ratings** | Apps from Apple's new-releases feeds, followed for 90 days, ranked by ratings gained per day | 1 to 2 weeks (launches need time to collect ratings) |
| **New on the grossing charts** | Apps that reached a top-grossing chart since yesterday, and which are there for the first time | Day 2 |
| **Listing changes this week** | Earning apps that changed their name, price, in-app purchases, seller or category | Day 2 |
| **Vanished from the App Store** | Charting apps Apple no longer lists, two scans running | Day 3 |
| **Climbing the grossing charts** | Places gained in a week | Day 8 |
| **Ratings momentum** | Fastest ratings growth in a week, relative to size | Day 8 |
| **Staying power** | New apps on a chart most days, rather than one-day spikes | Day 14 |

Then [the shortlist template](templates/shortlist.md) walks you from "interesting app" to "a narrower version I could build": who pays, what reviewers complain about, and whether you can reach those people.

## Run it on your computer

You need Node 22.18 or newer. There's nothing else to install.

```bash
git clone https://github.com/robbybuilds/app-store-scout
cd app-store-scout
npm run scan       # save today's charts and ratings, then search niches and read reviews
npm run report     # write reports/us/latest.md
npm run site       # build the website into public/ (open public/index.html through any local server)
npm run app -- 6777471316   # one app's chart history and its worst reviews
```

Add `-- --country gb` to scan or report another country.

## The website

The site is plain HTML that `npm run site` builds from the CSV files: a home page with today's niches, a page for every niche Scout has researched (it keeps the day each was first spotted), a page for every researched app, a page per country, a sitemap and structured data for search engines. [Search](https://robbybuilds.github.io/app-store-scout/search/?q=language) looks through every app on today's charts in any of the 8 countries. Each country's index is a small JSON file built with the site, and the summary above the results (how many match, how many are earning, how many are small or new) turns any word into a quick niche check. It has no dependencies and no tracking. The design follows [Hallmark](https://github.com/Nutlope/hallmark)'s Hum theme. The stylesheets in [`web/`](web/) start with the stamp that records each design decision.

## Let an AI agent do the legwork

[docs/agent-prompt.md](docs/agent-prompt.md) has copy-paste prompts for Claude Code, Codex or any agent that can run commands. The agent runs the scan, reads the report and the saved reviews for the most promising apps, and fills in the shortlist for you.

## Connect it to Claude, Cursor or any agent

Scout ships an MCP server. It runs on your computer and reads the data in your clone, so there's no account, no key and no call limit.

```bash
git clone https://github.com/robbybuilds/app-store-scout
cd app-store-scout
claude mcp add app-store-scout -- npm --prefix "$PWD" run --silent mcp
```

For Cursor, VS Code or Claude Desktop, add `npm --prefix /path/to/app-store-scout run --silent mcp` as a stdio server. Run `git pull` for the latest scan. Then ask things like:

- Which niches have new apps earning this week, and what do their reviews complain about?
- Which small apps climbed the most on a top-grossing chart today?
- Which earning apps were renamed or repriced this month?
- Which charting apps disappeared from the App Store?

It has nine tools: `list_niches`, `get_niche`, `get_movers`, `get_lists`, `search_apps`, `get_app`, `get_listing_changes`, `get_removed_apps` and `get_chart`.

## The website and the JSON API

Every scan rebuilds [the website](https://robbybuilds.github.io/app-store-scout/) on GitHub Pages: today's niches, [top-grossing movers](https://robbybuilds.github.io/app-store-scout/movers/), [listing changes](https://robbybuilds.github.io/app-store-scout/changes/), [removed apps](https://robbybuilds.github.io/app-store-scout/removed/), a page per niche and per researched app, and an [Atom feed](https://robbybuilds.github.io/app-store-scout/feed.xml) of new niches.

The same data is plain JSON with no key, listed at [/api/](https://robbybuilds.github.io/app-store-scout/api/):

```bash
curl https://robbybuilds.github.io/app-store-scout/api/v1/us/movers.json
```

Your fork publishes its own site and API: turn on **Settings → Pages → Source: GitHub Actions**. The "Join" banner on every page comes from `site.community` in [`scout.config.json`](scout.config.json); change it to your own link or delete it.

To collect emails, add a [Loops](https://loops.so) form: copy the form id from **Settings → Forms** in Loops and set `"newsletter": { "loopsFormId": "<id>" }` under `site` in the config. A sign-up form then appears on every page; subscribers are tagged with the user group "App Store Scout". No key goes in the repo, because Loops' form endpoint is public.

## Questions

**Is a top-grossing rank the same as revenue?**
No. It means an app out-earned the apps below it in that chart that day. Scout never turns ranks into dollar figures. [The guide](docs/guide.md) shows how to add free revenue estimates (AppTrendKit) and category benchmarks (RevenueCat) and label them honestly.

**Why not just use Sensor Tower or Appfigures?**
Use them too if you can. Scout adds a daily history that lives in your own repo as plain CSV files, so you can open it in a spreadsheet, change how it's scored, or hand it to an AI agent.

**Do I need to code?**
No. The fork-and-click setup above needs none, and the report is a page you read on GitHub.

**Does it cover Android?**
Not yet. Google Play has no free chart feed like Apple's.

**Where does the data come from?**
Four free Apple endpoints, none of which need a key: the chart feeds (ranks), the iTunes Lookup API (ratings, release dates, sellers and each publisher's other apps), the iTunes Search API (what customers see when they search for a niche) and the customer reviews feed (the most recent 500 reviews per app). In-app purchase prices, star breakdowns, version history, privacy labels and Apple's "You Might Also Like" suggestions are read from the researched apps' public App Store pages, once a week. Monthly Google search volumes come from [seodata.dev](https://www.seodata.dev), a free third-party service. Each scan saves Apple's own "last updated" time, so a stale feed can't pass as fresh data.

## The data

```text
data/us/charts/2026-11-02.csv    chart, genre_id, rank, app_id
data/us/ratings/2026-11-02.csv   app_id, rating_count, average_rating
data/us/apps.csv                 name, publisher, seller, genre, price, ratings, release date, version, languages, link
data/us/new/2026-11-02.csv       the ~220 apps in Apple's new-releases feeds that day (free and paid)
data/us/scans.csv                when each scan ran and how fresh Apple's feed was
data/us/reviews/6777471316.csv   every review seen for that app, 1 to 3 stars first
data/us/search.csv               per niche per day: results, established apps, new apps
data/us/search/2026-11-02.csv    the top 10 search results for each niche that day
data/us/volume.csv               monthly Google searches per niche, refreshed every 30 days
data/us/changes.csv              every listing change seen: names, prices, sellers, categories, purchases
data/us/removed.csv              charting apps that vanished from the App Store, and any that came back
data/us/publishers.csv           how many apps each researched publisher has, refreshed every 30 days
data/us/niches/2026-11-02.csv    the niches researched that day and the apps in each
data/us/prices.csv               each researched app's in-app purchases and prices, refreshed weekly
data/us/pages.csv                its ratings by star, privacy label, age rating, size and Editors' Choice badge, weekly
data/us/versions.csv             every release seen on those pages: version and date (Apple shows the latest 25)
data/us/similar.csv              the 10 apps Apple suggests under "You Might Also Like", in Apple's order, weekly
```

The default config covers 3 charts × 41 categories × 100 apps in 8 countries: about 12,000 chart positions and 9,000 apps per country per day. Each country adds about 540 KB a day (170 KB compressed), so roughly 1.3 MB a day across all eight once git compresses it. The US research reads reviews for about 200 apps: around 12 MB the first day, then only new reviews. Reviewer names are never saved.

## Limits

- **Ratings lag downloads.** Most people never leave a rating.
- **Charts stop at 100**, so the long tail is invisible. Following new releases from day one fills in some of it.
- **The new-releases feeds hold about 110 free and 110 paid apps** at a time, newest first. Far more apps launch each day, so it's a daily sample, not every launch.
- **The category and grossing charts use Apple's older RSS feed.** It works today, and Apple could retire it. If that happens, the scan logs the failure and saves nothing for that chart.
- **Reviews are the latest 500 per app**, and unhappy customers write more of them. Read them for themes, not as a satisfaction score. The complaint themes are keyword matches, so open the reviews before you trust a percentage.
- **Google volumes are estimates** from seodata.dev, for "<niche> app". They measure web searches, not App Store searches. Check the related phrases too: "video generator app" gets 30 searches a month, while "ai video generator" gets 165,000.
- **Search stops at 200 results**, so "190 results" means "a lot", not an exact count.
- **Prices, star breakdowns, versions and similar apps come from App Store web pages**, which have no official API. If Apple changes the page, the scan logs it and saves nothing from it. Apple lists at most 10 purchases per app, and the plan length (weekly, yearly) is guessed from each purchase's name.
- **"Solo developer" is a guess from the seller's name.** Apple shows an individual's legal name as the seller, but a company can have a name that looks like a person's, and the reverse.
- **Name-based niches are a starting point.** "Recipe" groups recipe managers with recipe magazines. Open the apps before you draw conclusions.

- **Removed means "Apple's Lookup API stopped returning it in that country"**, on two scans. The date is when Scout noticed, and it can't tell whether Apple or the developer pulled the app.
- **Listing changes carry the date of the scan that saw them.** Names and prices are compared daily; in-app purchases weekly, and only for researched apps. Subtitles and screenshots aren't tracked yet.

## Contributing

Ideas, issues and pull requests are welcome: new signals, better niche grouping, more countries in the default config. Run `npm test` before opening a PR.

If Scout helps you find an idea, a star helps other builders find it too.

## License

[MIT](LICENSE). Not affiliated with or endorsed by Apple.

---

Made by [Robby](https://github.com/robbybuilds), who teaches people to build and launch apps that make money in [Solo Software Studio](https://www.skool.com/solo-software-studio).
