# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Team Claude Code usage tracker; the client and server talk only over HTTP:

- `client/` — Node.js client (`cc-usage` bin) run on each person's machine, installed with one `npx <server>/client/…tgz setup` line. Uploads **aggregate** numbers and registers a daily upload. (The earlier Python client was removed; the Node client uses the same settings file, identity and payload.)
- `server/` — Node.js (ESM, Express 5, official `mongodb` driver) API + static dashboard (vanilla JS + Chart.js, no build step). UI text is Korean. The deployable app: `package.json`/lock live at the **repo root** and `npm start` runs `server/src/server.js`.

Deployment target is Docker Manager: Nginx reverse proxy under a sub-path `/c/<project>/`, port 3000, `GET /health`, env from `.env.example`. Docker Manager generated `Dockerfile` (**node:20-alpine**, `npm ci` + `npm start`), `.dockerignore` and `.github/workflows/deploy.yml` — don't edit them; keep the server runnable on Node 20.19 (no Node-22-only flags or APIs). See `IMPROVEMENTS.md` for the review that set this up.

There is no test suite, linter, or build. Verify changes by syntax-checking and exercising the running server (see Commands).

## Commands

```bash
# Server — run from the repo root (MongoDB is the docker container named `mongodb` on localhost:27017, no auth)
npm install
npm start                 # config.js loads .env (process.loadEnvFile, never overrides real env); local .env uses PORT=3200 and localhost MongoDB (default port is 3000)
npm run dev               # node --watch
npm run seed:sample       # 40 fake users (@sample.local), 90 days, weekly 7-day uploads through POST /api/reports
npm run seed:clean        # delete only @sample.local records
node --env-file=.env server/scripts/seed-sample.js --users 20 --days 30

# Syntax checks (no tests exist)
node --check server/src/stats.js server/public/app.js

# Node client (from client/; npm install once for local runs)
cd client && npm install
node bin/cc-usage.js send --dry-run --server http://localhost:3200 --user you@example.com   # print the body, no upload
# Test setup without touching real settings/schedules: override HOME (or XDG_CONFIG_HOME/XDG_DATA_HOME) and
# CC_USAGE_SCHEDULE_NAME (always — the default launchd label/cron tag is shared with a real install on the same account); clean Linux end-to-end: docker run --add-host=host.docker.internal:host-gateway node:22-slim …

# Inspect / reset data
docker exec mongodb mongosh cc_usage --quiet --eval 'db.reports.countDocuments()'
curl -s "localhost:3200/api/stats?since=2026-08-18&until=2026-09-16" | jq .trend
```

The server does not auto-reload in `npm start`; restart after editing `server/src/*`. Files in `server/public/` are served statically (just reload the browser).

Server env vars (all in `.env.example`, nothing else is read): `MONGODB_URI` or `MONGO_URL` (no localhost default; deploy value `mongodb://mongodb:27017/cc_usage` on docker-manager-net), `MONGODB_DB` (else the URI's db name, else `cc_usage`), `PORT` (3000), `HOST` (0.0.0.0), `INGEST_TOKEN`, `PUBLIC_URL` (address clients should use; validated as http(s)), `REPORT_TIMEZONE`. Empty values count as unset.

## Node client (`client/`)

- **Upload payload is deliberately minimal** (`usage.js`, `SCHEMA_VERSION = 3`): `range`, `periodTotal`, and `dailyTotals[]` with only token fields (`inputTokens`, `outputTokens`, `cacheCreationTokens`, `cacheReadTokens`, `totalTokens`) and `sessions` (sessions started that day). Cost, model, project, session and billing-block details must never be sent — explicit product decision (company uses Max plans; cost is meaningless and details are private).
- `usage.js` runs the **pinned** `ccusage` dependency (`20.0.20`, resolved via `require.resolve('ccusage/package.json')`) as `node <bin> claude daily|session --json --offline`. Sessions are fetched without a date filter (ccusage's session filter drops sessions) and counted by local start date. Bump the pin deliberately and re-verify the JSON shape.
- `identity.js`: ASCII `USER_RE` (same as server `ingest.js` and `public/app.js`), name normalization (NFC, collapsed whitespace, ≤50 chars, no control chars), and `machineId = sha256("cc-usage:" + OS UUID)[:32]` (macOS IOPlatformUUID / Linux machine-id / Windows MachineGuid, fallback random UUID saved in config) — changing any of these splits a person's records.
- Settings resolve option > env (`CCUSAGE_USER`, `CCUSAGE_NAME`, `CCUSAGE_SERVER`, `CCUSAGE_TOKEN`, `CCUSAGE_MACHINE_ID`) > `~/.config/cc-usage/config.json` (dir 0700, file 0600 from creation).
- The display name is **required**: `setup` fails without `--name`/`CCUSAGE_NAME`/saved name, `send` refuses to upload without one, and the prompt re-asks until given.
- `setup` with none of the value options in a TTY runs `prompt.js` (asks server → user → name → token if required → schedule → confirm; Ctrl+C/"n" exits 130 without changes), then continues as the flag path. Without a TTY it keeps the flag behavior.
- `setup` (in `cli.js`): check `/api/client-info` → validate the package path/URL shape → save config (including `--machine-id`) → `install.js` always runs `npm install --prefix <DATA_DIR> <server tarball>` (npx caches are temporary) and writes a `cc-usage` wrapper (only if the file is missing or ours) → first `send` → `schedule.js` registers launchd / cron / schtasks with absolute `process.execPath` + installed entry + `send --log`, or with `--no-schedule` removes an existing registration. Schedule failure is a warning, not fatal. State for `status` lives in `state.json`; the last body sent in `last-upload.json`.
- Windows scheduling and install are implemented but untested; macOS launchd and Linux cron were verified end to end.

## Server architecture (`server/src`)

- `config.js` — loads `.env`, parses env; `assertConfig()` only rejects an invalid `PUBLIC_URL`. `db.js` — `connectWithRetry()` runs after `listen` (retries 2 s→30 s) so `/health` passes while MongoDB is down or unset; `requireDb` in server.js answers 503 on DB routes until `isReady()`. `dates.js` — `isCalendarDate`, `dayCount`, `dateRange`, shared by ingest, stats and server.
- `ingest.js` — `parseReport` validates and normalizes the body; accepts schemaVersion 1–3 but **silently discards** cost and any detail sections from older clients. Counts must be safe integers, `cacheHitRate` 0–1, dates real calendar dates, windows ≤ 5000 days, strings without control characters. `storeReport` writes three collections:
  - `reports`: every submission kept as history (period total + daily totals).
  - `users`: latest display name per user. `name` is required: reports without it are rejected with 400 (older nameless clients must re-run `setup --name`). Stats attach `name` to users/machines/trend rows; the dashboard labels charts by name and keeps the email id for identity, color and filtering (`displayName` / `fullLabel` in `app.js`).
  - `daily`: one doc per `(user, machineId, date)`, written in one ordered `bulkWrite`: upsert active days, then delete days in the window that are now zero. Re-sending overlapping windows never double counts; different machines of the same user are summed in stats. MongoDB is a standalone node, so there are no transactions.
- `stats.js` — everything the dashboard shows comes from `GET /api/stats?since&until[&user]`, aggregated from `daily`: totals, `byDateUser`, per-user totals, per-machine latest report, and `trend`. Exports `USAGE_FIELDS`/`sumUsage`/`keepUsage` for export.js.
  - **Trend groups**: per user, a least-squares line through daily `totalTokens` over the range (missing days = 0). `change = slope*(n-1)/mean`; `>= +TREND_THRESHOLD` (0.2) → `increasing`, `<= -0.2` → `decreasing`, else `steady` (UI label 일정). Needs ≥3 days. `linearFit` in `public/app.js` draws the same line — keep them consistent.
  - `listUsers` orders users by all-time tokens; the dashboard assigns categorical color slots from this order.
- `server.js` — `GET /health` (no auth, no DB) first, then security headers (CSP `script-src 'self'`, so **no inline scripts** in `public/`), `trust proxy` for private hops. Routes: `POST /api/reports` (optional bearer `INGEST_TOKEN`), `GET /api/stats`, `/api/export.xlsx`, `/api/reports`, `/api/reports/:id`, `/api/users`, `/api/client-info` (only `tokenRequired` + client package, never the token), `/api/health` (DB ping); unknown `/api/*` → JSON 404. Serves the client tarball, `public/`, and chart.js's `chart.umd.js` found via `require.resolve('chart.js')`. The error handler maps validation/4xx errors to their status and logs rejections.
- `client-package.js` — runs `npm pack` in `client/` (60 s timeout) into `server/.client-dist/` (or the OS temp dir if not writable) when sources are newer than the build; after a failure it reuses the previous package for a minute. `/api/client-info` returns `client.package` with version+hash in the filename so npx never reuses a stale cache.
- `export.js` — `GET /api/export.xlsx` (same `since/until/user` validation as `/api/stats` via `rangeQuery`) builds an `exceljs` workbook: reuses `getStats` and adds user×day and per-day aggregations plus overlapping `reports` (capped at 20,000, noted in the summary sheet). Timestamps use `REPORT_TIMEZONE`. Totals across the summary, users, daily, user-daily and matrix sheets must agree. `uuid` is pinned to 11.x under `exceljs` via `overrides`.
- `db.js` creates indexes on startup (listed with reasons in `RECOMMENDED-INDEXES.js`); aggregations are written to use them (e.g. the machines pipeline sorts by `{user, machineId, receivedAt}`).

## Dashboard (`server/public`)

- All resource and API paths are relative (the app runs under `/c/<project>/`). The setup dialog's 서버 주소 field picks, in order: `PUBLIC_URL`, then — only when the page was opened as localhost — the server's LAN addresses/hostname (`/api/client-info` includes `server.addresses` only for loopback requests, see `server/src/network.js`), then the page's own base URL `new URL('.', location.href)` (never `location.origin`, which drops the sub-path). Users can pick another candidate or type one; loopback or non-http values show a warning.
- Header button (and the empty state) opens the **클라이언트 설정 방법** `<dialog>`: email/name inputs (both required; the command always includes `--name`, with a 홍길동 placeholder until filled) fill the one-line `npx … setup` command (package path from `/api/client-info`) plus `cc-usage status|send|uninstall`. Commands stay single-line (PowerShell has no `\` continuation); `setCode` keeps words unbroken when wrapping. Keep its commands and privacy text in sync with the client's options and payload.
- Single page; filters (7/30/90 days/custom, user) live in the URL query and re-fetch `/api/stats`; previous render is dimmed while loading. The 엑셀 다운로드 link follows the filters.
- Charts: 일별 토큰 (stacked by user, area/bar toggle), 사용자별 토큰량 (horizontal bars), 사용량 추세 (group totals, as a 7-day moving average for ranges ≥14 days, plus each group's straight trend line; line/area toggle), plus trend-group tables and users/machines tables. Every chart has a table view (`renderChartTable`); helper datasets flagged `trendLine` are excluded from legend, tooltip and table.
- Styling follows a data-viz convention: colors are CSS custom properties with separate light/dark values (charts are rebuilt on color-scheme change), categorical slots never cycle — beyond 8 users the rest fold into "기타", and color follows the entity (all-time rank), not the filtered rank. Chart-type choices persist in `localStorage` via `persistChoice`.
- Removed on purpose (don't reintroduce without asking): any cost/USD display, per-model, per-project, hour-of-day and top-session views.
