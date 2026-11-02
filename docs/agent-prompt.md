# Use it with an AI agent

Paste one of these into Claude Code, Codex, OpenClaw or any agent that can run commands and browse.

## Weekly research run

```text
In the app-store-scout repo:

1. Run `npm run scan` then `npm run report`.
2. Read reports/us/latest.md. Focus on "New and paying" and "Small and paying".
3. Find clusters: 2 or more apps from different publishers solving the same narrow need.
4. Pick the 5 most promising apps. For each, open its App Store page and read the most
   recent 1 and 2 star reviews. Group the complaints and count them.
5. Fill in templates/shortlist.md for each app and save it as research/<today>.md.

Rules:
- Ranks and ratings are facts. Never turn a rank into a revenue figure.
- If you include a download or revenue estimate, name the source, country and period,
  and label it an estimate. Never call it MRR.
- End with the one opportunity you'd test first and why, in three sentences.
```

## Look at one app

```text
In the app-store-scout repo, run `npm run app -- <app-id>` and summarise this app's
chart and ratings history. Then read its recent 1 and 2 star reviews on the App Store and
list the top 3 complaints with counts. Suggest a narrower app that fixes the top complaint
for one specific audience.
```
