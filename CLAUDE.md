# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Team coding-agent usage tracker (Claude Code and Codex, collected per agent); the client and server talk only over HTTP:

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
npm run seed:sample       # 40 fake users (@sample.local, ~1/3 also use Codex), 90 days, weekly 7-day v4 uploads through POST /api/reports
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

Server env vars (all in `.env.example`, nothing else is read): `MONGODB_URI` or `MONGO_URL` (no localhost default; deploy value `mongodb://mongodb:27017/cc_usage` on docker-manager-net), `MONGODB_DB` (else the URI's db name, else `cc_usage`), `PORT` (3000), `HOST` (0.0.0.0), `INGEST_TOKEN`, `PUBLIC_URL` (address clients should use; validated as http(s)), `REPORT_TIMEZONE`, and the sign-in settings `ENTRA_TENANT_ID` + `ENTRA_API_CLIENT_ID` (both or neither), `ENTRA_SPA_CLIENT_ID`, `ENTRA_REQUIRED_SCOPE`, `ADMIN_EMAILS`, `ALLOWED_EMAIL_DOMAINS`. Empty values count as unset.

## Node client (`client/`)

- **Upload payload is deliberately minimal** (`usage.js`, `SCHEMA_VERSION = 4`): `range` and `agents[]`, one `{ agent, periodTotal, dailyTotals[] }` per agent, with only token fields (`inputTokens`, `outputTokens`, `cacheCreationTokens`, `cacheReadTokens`, `totalTokens`) and `sessions` (sessions started that day). Cost, model, project, session and billing-block details must never be sent — explicit product decision (company uses Max plans; cost is meaningless and details are private).
- Agents (`AGENTS` in `usage.js`, same ids as `AGENTS` in server `ingest.js`): `claude` (required — its failure fails the send) and `codex` (optional — on failure it is left out with a warning on stderr/log, so the server keeps its earlier days). A machine without Codex still reports `codex` with zeros (ccusage returns empty JSON, exit 0).
- `usage.js` runs the **pinned** `ccusage` dependency (`20.0.37`, resolved via `require.resolve('ccusage/package.json')`) as `node <bin> <agent> daily|session --json --offline`. Sessions are fetched without a date filter (ccusage's session filter drops sessions) and counted by local start date: Claude `firstActivity`; Codex has none, so its `directory` (`YYYY/MM/DD`, the local start date) is used. Codex `inputTokens` already excludes cached input and its `reasoningOutputTokens` are part of `outputTokens` (never add them), so the four fields sum to ccusage's `totalTokens` for both agents. Bump the pin deliberately and re-verify the JSON shape of both agents.
- `identity.js`: ASCII `USER_RE` (same as server `ingest.js` and `public/app.js`), name normalization (NFC, collapsed whitespace, ≤50 chars, no control chars), and `machineId = sha256("cc-usage:" + OS UUID)[:32]` (macOS IOPlatformUUID / Linux machine-id / Windows MachineGuid, fallback random UUID saved in config) — changing any of these splits a person's records.
- Settings resolve option > env (`CCUSAGE_USER`, `CCUSAGE_NAME`, `CCUSAGE_SERVER`, `CCUSAGE_TOKEN`, `CCUSAGE_MACHINE_ID`) > `~/.config/cc-usage/config.json` (dir 0700, file 0600 from creation).
- The display name is **required**: `setup` fails without `--name`/`CCUSAGE_NAME`/saved name, `send` refuses to upload without one, and the prompt re-asks until given.
- `setup` with none of the value options in a TTY runs `prompt.js` (asks server → user → name → token if required → schedule → confirm; Ctrl+C/"n" exits 130 without changes), then continues as the flag path. Without a TTY it keeps the flag behavior.
- `setup` (in `cli.js`): check `/api/client-info` → validate the package path/URL shape → save config (including `--machine-id`) → `install.js` always runs `npm install --prefix <DATA_DIR> <server tarball>` (npx caches are temporary) and writes a `cc-usage` wrapper (only if the file is missing or ours) → first `send` → `schedule.js` registers launchd / cron / schtasks with absolute `process.execPath` + installed entry + `send --log`, or with `--no-schedule` removes an existing registration. Schedule failure is a warning, not fatal. State for `status` lives in `state.json`; the last body sent in `last-upload.json`.
- Windows scheduling and install are implemented but untested; macOS launchd and Linux cron were verified end to end.

## Server architecture (`server/src`)

- `config.js` — loads `.env`, parses env; `assertConfig()` only rejects an invalid `PUBLIC_URL`. `db.js` — `connectWithRetry()` runs after `listen` (retries 2 s→30 s) so `/health` passes while MongoDB is down or unset; `requireDb` in server.js answers 503 on DB routes until `isReady()`. `dates.js` — `isCalendarDate`, `dayCount`, `dateRange`, shared by ingest, stats and server.
- `auth.js` — company-account sign-in (Microsoft Entra ID), on only when `ENTRA_TENANT_ID` and `ENTRA_API_CLIENT_ID` are set (local runs stay open; the server warns at startup and `/api/auth/config` reports `enabled`). The browser signs in with MSAL.js (SPA + PKCE, no client secret); `verifyToken` checks signature (RS256 only, keys via `jose`), issuer, audience, `ver` 2.0, tenant, the `access_as_user` scope and the email domain. `requireUser` sets `req.auth = { email, name, role }`; `role` is `admin` for `ADMIN_EMAILS`, else `user`. In server.js `scopedUser()` forces every non-admin's `user` filter to their own id (`userIdForEmail` in stats.js, case-insensitive match against stored ids) — **every new read route must go through `requireUser` and `scopedUser`**. `POST /api/reports` stays on `INGEST_TOKEN` (unattended daily uploads cannot sign in).
- `ingest.js` — `parseReport` validates and normalizes the body; accepts schemaVersion 1–4 (1–3 have top-level `periodTotal`/`dailyTotals` and are treated as one `claude` agent, `LEGACY_AGENT`) but **silently discards** cost and any detail sections from older clients. v4 `agents[]` must be non-empty, known (`AGENTS`) and unique; the stored `periodTotal` is the sum over agents. Counts must be safe integers, `cacheHitRate` 0–1, dates real calendar dates, windows ≤ 5000 days, strings without control characters. `storeReport` writes three collections:
  - `reports`: every submission kept as history (combined `periodTotal` + `agents[]` with each agent's period and daily totals; reports stored before v4 have top-level `dailyTotals` and no `agents` — readers fall back to `claude`, see `withAgents` in stats.js).
  - `users`: latest display name per user. `name` is required: reports without it are rejected with 400 (older nameless clients must re-run `setup --name`). Stats attach `name` to users/machines/trend rows; the dashboard labels charts by name and keeps the email id for identity, color and filtering (`displayName` / `fullLabel` in `app.js`).
  - `daily`: one doc per `(user, machineId, hostname, agent, date)` — a machine is `machineId` **plus** `hostname`, because cloned Linux images share `/etc/machine-id` and would otherwise overwrite each other. Written in one ordered `bulkWrite`: per agent in the report, upsert active days, then delete that agent's days in the window that are now zero (an agent missing from a report is left untouched). On startup `db.js` sets `agent: 'claude'` on older docs before the routes open. Re-sending overlapping windows never double counts; different machines of the same user are summed in stats. Renaming a host starts a new machine (its last window, 7 days by default, then counts twice). MongoDB is a standalone node, so there are no transactions.
- `stats.js` — everything the dashboard shows comes from `GET /api/stats?since&until[&user][&agent]`, aggregated from `daily` (with `agent`, only that agent; without, all agents summed): totals, `byDateUser`, `byAgent`, `byDateAgent`, per-user totals (with `agents: { agent: tokens }`), per-machine latest report (with the `agents` it covered, not filtered by agent), and `trend`. Exports `USAGE_FIELDS`/`sumUsage`/`keepUsage` for export.js.
  - **Trend groups**: per user, a least-squares line through daily `totalTokens` over the range (missing days = 0). `change = slope*(n-1)/mean`; `>= +TREND_THRESHOLD` (0.2) → `increasing`, `<= -0.2` → `decreasing`, else `steady` (UI label 일정). Needs ≥3 days. `linearFit` in `public/app.js` draws the same line — keep them consistent.
  - `listUsers` orders users by all-time tokens; the dashboard assigns categorical color slots from this order.
- `server.js` — `GET /health` (no auth, no DB) first, then security headers (CSP `script-src 'self'`, so **no inline scripts** in `public/`), `trust proxy` for private hops. Routes: `POST /api/reports` (optional bearer `INGEST_TOKEN`), `GET /api/stats`, `/api/export.xlsx`, `/api/reports`, `/api/reports/:id`, `/api/users`, `/api/client-info` (only `tokenRequired` + client package, never the token), `/api/health` (DB ping), `/api/auth/config` (public) and `/api/auth/me`; unknown `/api/*` → JSON 404. The read routes (`stats`, `export.xlsx`, `reports`, `users`, `auth/me`) require sign-in when it is on. Serves the client tarball, `public/`, chart.js's `chart.umd.js` found via `require.resolve('chart.js')` and MSAL's `msal-browser.min.js` (pinned `@azure/msal-browser` 2.38.4; the CSP allows `login.microsoftonline.com` for connect/frame only). The error handler maps validation/4xx errors to their status and logs rejections.
- `client-package.js` — runs `npm pack` in `client/` (60 s timeout) into `server/.client-dist/` (or the OS temp dir if not writable) when sources are newer than the build; after a failure it reuses the previous package for a minute. `/api/client-info` returns `client.package` with version+hash in the filename so npx never reuses a stale cache.
- `export.js` — `GET /api/export.xlsx` (same `since/until/user/agent` validation as `/api/stats` via `rangeQuery`; unknown `agent` → 400) builds an `exceljs` workbook: reuses `getStats` and adds user×day, per-day and agent×day aggregations plus overlapping `reports` (capped at 20,000, noted in the summary sheet; with an agent filter only reports covering it, with its numbers). Timestamps use `REPORT_TIMEZONE`. Totals across the summary, users, daily, agent-daily, user-daily and matrix sheets must agree. `uuid` is pinned to 11.x under `exceljs` via `overrides`.
- `db.js` creates indexes on startup (listed with reasons in `RECOMMENDED-INDEXES.js`); aggregations are written to use them (e.g. the machines pipeline sorts by `{user, machineId, hostname, receivedAt}`; startup drops the pre-hostname `daily`/`reports` indexes).

## Dashboard (`server/public`)

- All resource and API paths are relative (the app runs under `/c/<project>/`). The setup dialog's 서버 주소 field picks, in order: `PUBLIC_URL`, then — only when the page was opened as localhost — the server's LAN addresses/hostname (`/api/client-info` includes `server.addresses` only for loopback requests, see `server/src/network.js`), then the page's own base URL `new URL('.', location.href)` (never `location.origin`, which drops the sub-path). Users can pick another candidate or type one; loopback or non-http values show a warning.
- Header button (and the empty state) opens the **클라이언트 설정 방법** `<dialog>`: email/name inputs (both required; the command always includes `--name`, with a 홍길동 placeholder until filled) fill the one-line `npx … setup` command (package path from `/api/client-info`) plus `cc-usage status|send|uninstall`. Commands stay single-line (PowerShell has no `\` continuation); `setCode` keeps words unbroken when wrapping. Keep its commands and privacy text in sync with the client's options and payload.
- `auth.js` (imported by `app.js`): `initAuth()` runs before anything loads; signed-out visitors see only `#auth-gate` (`body.signed-out`). The gate is a copy of the company chatbot's sign-in card (logo and Pretendard in `public/brand/`, always light) — keep the two looking the same. All API calls go through `apiFetch` (adds the bearer token), including the Excel download, which is fetched as a blob when sign-in is on because a plain link cannot carry the token. Non-admins get the user filter hidden and the setup dialog's user id fixed to their sign-in email, so their uploads land under an id they can see. The redirect URI is `new URL('.', location.href).href` and must be registered with the trailing slash.
- Single page; filters (7/30/90 days/custom, user, agent) live in the URL query and re-fetch `/api/stats`; previous render is dimmed while loading. The 엑셀 다운로드 link follows the filters.
- Charts: 일별 토큰 (stacked by user, area/bar toggle), 에이전트별 일별 토큰 (stacked bars, only without an agent filter and when ≥2 agents were used; the users table then also gets one column per agent), 사용자별 토큰량 (horizontal bars), 사용량 추세 (group totals, as a 7-day moving average for ranges ≥14 days, plus each group's straight trend line; line/area toggle), plus trend-group tables and users/machines tables. Every chart has a table view (`renderChartTable`); helper datasets flagged `trendLine` are excluded from legend, tooltip and table.
- Agent labels live in `AGENT_LABEL` (app.js, export.js) and the `<select name="agent">` options; each agent has a fixed color token `--agent-<id>` in style.css. Adding an agent means updating both `AGENTS` lists, these labels and the token.
- Styling follows a data-viz convention: colors are CSS custom properties with separate light/dark values (charts are rebuilt on color-scheme change), categorical slots never cycle — beyond 8 users the rest fold into "기타", and color follows the entity (all-time rank), not the filtered rank. Chart-type choices persist in `localStorage` via `persistChoice`.
- Removed on purpose (don't reintroduce without asking): any cost/USD display, per-model, per-project, hour-of-day and top-session views.
