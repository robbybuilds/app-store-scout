# Researching App Store opportunities for free

A practical guide to finding apps and niches worth building around, using only free data. It goes with this repo's daily scans, but works on its own.

Figures checked on 2 November 2026. Free tiers change; check before relying on one.

## The one rule: know what kind of number you're looking at

Most "this app makes $50K MRR" content mixes up very different kinds of evidence. Keep them apart.

| Number | What it really is |
|---|---|
| **Chart rank** | An observed position in one country, one chart, one category, at one moment. Fact. |
| **Ratings count and average** | Public metadata. Useful to track over time; not a download count. Fact. |
| **Release and update dates** | Public metadata. Fact. |
| **Download estimate** | A third party's model. Note the provider, country, period. |
| **Revenue estimate** | A third party's model, usually gross App Store spending before Apple's cut, excluding ads and web sales. |
| **MRR** | Recurring subscription revenue normalised to a month. Only the developer knows it, unless they publish it. |
| **Profit** | Unknown without costs. Store data never tells you this. |

So when a tool says an app makes $40K a month, write it down as:

> Estimated App Store revenue: ~$40K/month (AppTrendKit, US, October 2026, gross). Actual MRR and profit unknown.

Not "$40K MRR".

This repo only collects the facts at the top of that table. That's on purpose.

## Free sources worth using

| Source | What you get free | Watch out for |
|---|---|---|
| **Apple's chart feeds** (what this repo uses) | Top free, top paid and top grossing, overall and per category, up to 100 apps, any country. No key. | Ranks, not downloads or money. The per-category and grossing feeds are Apple's older RSS format; they work today but aren't promised forever. |
| **iTunes Lookup API** (also used here) | Ratings count, average rating, release date, last update, price, publisher, for up to ~200 apps per request. | Ratings lag installs and many users never rate. |
| **iTunes Search API** (also used here) | The apps a customer sees when searching a phrase, up to 200, with the same details as Lookup. | About 20 calls a minute. Search order is Apple's, not a popularity ranking. |
| **Customer reviews feed** (also used here) | The most recent 500 reviews per app per country: rating, title, text, app version, date. | Unhappy customers are overrepresented. Old reviews drop off, so the repo keeps every review it has seen. |
| **[AppTrendKit](https://www.apptrendkit.com/)** | Estimated downloads and revenue. The 300 biggest apps are free, plus 2 more full app pages a day, or 5 with a free account. | Estimates are modelled from chart and listing signals. Their own test: within 2× of publicly reported revenue for five of seven apps, worst miss 5.7×. CSV and API are paid. |
| **[RevenueCat State of Subscription Apps](https://www.revenuecat.com/state-of-subscription-apps/)** | Category benchmarks: revenue per install, conversion, retention, pricing. 115,000+ apps, $16B+ revenue. | Aggregated from RevenueCat customers (iOS, Android and web), mostly 2025 data. Benchmarks, not any one app's numbers. |
| **[42matters iOS statistics](https://42matters.com/ios-apple-app-store-statistics-and-trends)** | Market-wide counts: total apps, free vs paid, new releases per day. | Context, not competitor data. |
| **[Appfigures](https://appfigures.com)**, **[Sensor Tower](https://sensortower.com)** | Both offer a free signup. | What's included changes; check before planning around it. |

## What the benchmarks say about categories

From RevenueCat's 2026 report (2025 data). Revenue per install (RPI) is revenue divided by installs; it is not profit or lifetime value.

| Category | Median revenue per install |
|---|---|
| Health & Fitness | $0.48 by day 14, $0.66 by day 60 (highest) |
| Business | $0.31 by day 14, $0.50 by day 60 |
| Education | $0.30 by day 14 |

Two more findings worth knowing:

- **AI apps** earn 41% more per paying user but churn 30% faster. Novelty pays once; a repeat-use job keeps paying.
- **Old apps dominate.** Apps launched before 2020 make 69% of subscription revenue; apps launched in 2025 or later make 3%. New apps are flooding in much faster than new apps are succeeding. That's why the "New and paying" list in this repo's report is the interesting one: it's rare.

## A weekly routine

1. **Let the scan run daily.** Rank on one day means little. The same app holding a grossing rank for weeks means a lot.
2. **Each week, read the report** (`reports/us/latest.md`). Start with the niches table, then *New and paying* and *Small and paying*.
3. **Look for clusters, not single apps.** The report's *Niches where newcomers are earning* section does a first pass for you. Twelve unrelated publishers with meal planners on the Food & Drink grossing chart says more than one breakout app.
4. **Pick 3 to 5 apps** and fill in [the shortlist template](../templates/shortlist.md).
5. **Spend your free estimate lookups on that shortlist**, not on browsing. Record the provider and period next to every estimate.
6. **Read the 1 to 3 star reviews.** The report's *Inside each niche* section counts complaint themes, and `data/us/reviews/<app-id>.csv` has the full text, worst first. Repeated complaints are the product spec for your narrower version.
7. **Check the search.** If the top 10 results for the niche's phrase all have tens of thousands of ratings, you'll need a narrower phrase to be found.
8. **Check you can reach the audience** without outspending a big brand on ads.

## Signals worth taking seriously

- A recent release that **stays** on a grossing chart, not one that spikes for a day.
- **Several independent publishers** serving the same narrow need.
- **Ratings growing** steadily across snapshots.
- Money evidence from **more than one source** (grossing rank, an estimate, a public revenue post).
- **Repeated complaints** that point to one specific fix.
- An audience you can reach **without competing head-on** with household names.

These are research heuristics, not proven predictors. The goal isn't "an app with a big revenue number". It's a small cluster showing demand, proof that people pay, and a specific need nobody serves well yet.
