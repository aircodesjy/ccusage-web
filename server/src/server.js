import { timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { AuthError, authClientConfig, authEnabled, requireUser } from './auth.js';
import { clientPackage, packagePath } from './client-package.js';
import { assertConfig, config, MISSING_MONGO_URI } from './config.js';
import { dayCount, isCalendarDate } from './dates.js';
import { close, connectWithRetry, isReady, ping } from './db.js';
import { buildWorkbook } from './export.js';
import { isLoopback, lanAddresses } from './network.js';
import { AGENTS, parseReport, storeReport, ValidationError } from './ingest.js';
import { getCumulative, getReport, getStats, listReports, listUsers, userIdForEmail } from './stats.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MAX_RANGE_DAYS = 3 * 366;
// chart.js does not export dist/chart.umd.js, so locate it next to the package entry (works wherever npm installs it).
const require = createRequire(import.meta.url);
const chartUmd = path.join(path.dirname(require.resolve('chart.js')), 'chart.umd.js');
// MSAL.js (browser sign-in) is served by us for the same reason: the page must not depend on a CDN to sign in.
const msalBrowser = path.join(path.dirname(require.resolve('@azure/msal-browser')), '..', 'lib', 'msal-browser.min.js');

const app = express();
app.disable('x-powered-by');
// Behind the Nginx reverse proxy: take the client address from X-Forwarded-For when it comes from a private hop.
app.set('trust proxy', 'loopback, uniquelocal');

// Liveness check for the deployment platform: no auth, no database.
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.use((_req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
      // Sign-in talks to Microsoft from the page (token requests, and a hidden frame for silent renewal).
      "connect-src 'self' https://login.microsoftonline.com; frame-src https://login.microsoftonline.com; " +
      "frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
  });
  next();
});

function requireIngestToken(req, res, next) {
  if (!config.ingestToken) return next();
  const given = Buffer.from((req.get('authorization') ?? '').replace(/^Bearer\s+/i, ''));
  const expected = Buffer.from(config.ingestToken);
  if (given.length === expected.length && timingSafeEqual(given, expected)) return next();
  console.warn(`[ingest] rejected from ${req.ip}: invalid or missing bearer token`);
  res.status(401).json({ error: 'invalid or missing bearer token' });
}

const asyncRoute = (fn) => (req, res, next) => fn(req, res).catch(next);

/** Routes that read or write MongoDB answer 503 until the background connection is established. */
function requireDb(_req, res, next) {
  if (isReady()) return next();
  res.status(503).json({ error: config.mongoUri ? 'database not connected yet' : MISSING_MONGO_URI });
}

app.post(
  '/api/reports',
  requireIngestToken,
  requireDb,
  express.json({ limit: '10mb' }),
  asyncRoute(async (req, res) => {
    const stored = await storeReport(parseReport(req.body));
    const perAgent = stored.agents.map((a) => `${a.agent} ${a.totalTokens}`).join(', ');
    console.log(`[ingest] ${stored.name ? `${stored.name} <${stored.user}>` : stored.user} machine=${stored.machineId.slice(0, 8)} (${stored.hostname ?? '?'}) ${stored.since}~${stored.until} ${stored.totalTokens} tokens (${perAgent})`);
    res.status(201).json({ ok: true, ...stored });
  }),
);

/**
 * The user filter a request may use. Admins, and everyone when sign-in is off, keep the filter they asked for;
 * any other signed-in person is limited to their own user id, whatever they asked for.
 */
async function scopedUser(req, requested) {
  if (!req.auth || req.auth.role === 'admin') return requested;
  return userIdForEmail(req.auth.email);
}

// Sign-in settings for the page (public: the page needs them before anyone is signed in).
app.get('/api/auth/config', (_req, res) => res.json(authClientConfig));

// Who is signed in, their role, and the user id their own reports are stored under.
app.get(
  '/api/auth/me',
  requireUser,
  requireDb,
  asyncRoute(async (req, res) => {
    if (!req.auth) return res.json({ enabled: false });
    res.json({ enabled: true, ...req.auth, user: await userIdForEmail(req.auth.email) });
  }),
);

/** since/until (YYYY-MM-DD), optional user and optional agent from the query string, or null after sending a 400. */
function rangeQuery(req, res) {
  const { since, until, user, agent } = req.query;
  if (!isCalendarDate(since) || !isCalendarDate(until) || since > until) {
    res.status(400).json({ error: 'since and until (YYYY-MM-DD, since <= until) are required' });
    return null;
  }
  if (dayCount(since, until) > MAX_RANGE_DAYS) {
    res.status(400).json({ error: 'range must be at most 3 years' });
    return null;
  }
  if (agent !== undefined && agent !== '' && !AGENTS.includes(agent)) {
    res.status(400).json({ error: `agent must be one of ${AGENTS.join(', ')}` });
    return null;
  }
  return { since, until, user: typeof user === 'string' && user ? user : undefined, agent: agent || undefined };
}

app.get(
  '/api/stats',
  requireUser,
  requireDb,
  asyncRoute(async (req, res) => {
    const range = rangeQuery(req, res);
    if (range) res.json(await getStats({ ...range, user: await scopedUser(req, range.user) }));
  }),
);

// All-time usage per user and month (the 누적 사용량 card); takes the user and agent filters, not the date range.
app.get(
  '/api/cumulative',
  requireUser,
  requireDb,
  asyncRoute(async (req, res) => {
    const { user, agent } = req.query;
    if (agent !== undefined && agent !== '' && !AGENTS.includes(agent)) {
      res.status(400).json({ error: `agent must be one of ${AGENTS.join(', ')}` });
      return;
    }
    const requested = typeof user === 'string' && user ? user : undefined;
    res.json(await getCumulative({ user: await scopedUser(req, requested), agent: agent || undefined }));
  }),
);

// Detailed multi-sheet Excel report for the same filters as the dashboard.
app.get(
  '/api/export.xlsx',
  requireUser,
  requireDb,
  asyncRoute(async (req, res) => {
    const range = rangeQuery(req, res);
    if (!range) return;
    range.user = await scopedUser(req, range.user);
    const workbook = await buildWorkbook(range);
    const suffix = `${range.agent ? `_${range.agent}` : ''}${range.user ? `_${range.user.replace(/[^\w.@-]/g, '_')}` : ''}`;
    res.attachment(`cc-usage_${range.since}_${range.until}${suffix}.xlsx`);
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await workbook.xlsx.write(res);
    res.end();
  }),
);

app.get(
  '/api/reports',
  requireUser,
  requireDb,
  asyncRoute(async (req, res) => {
    const text = (v) => (typeof v === 'string' && v ? v : undefined);
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 500);
    const user = await scopedUser(req, text(req.query.user));
    res.json(await listReports({ user, machineId: text(req.query.machineId), limit }));
  }),
);

app.get(
  '/api/reports/:id',
  requireUser,
  requireDb,
  asyncRoute(async (req, res) => {
    const report = await getReport(req.params.id);
    // Someone else's report answers exactly like a missing one.
    const own = report && [undefined, report.user].includes(await scopedUser(req, undefined));
    if (!own) return res.status(404).json({ error: 'report not found' });
    res.json(report);
  }),
);

app.get(
  '/api/users',
  requireUser,
  requireDb,
  asyncRoute(async (req, res) => {
    const only = await scopedUser(req, undefined);
    const users = await listUsers();
    res.json(only === undefined ? users : users.filter((u) => u.user === only));
  }),
);

app.get(
  '/api/health',
  requireDb,
  asyncRoute(async (_req, res) => {
    await ping();
    res.json({ ok: true });
  }),
);

// Setup guide and client: whether uploads need a token (never the token itself), the current client package, and
// which server address to show. Network addresses are only shared with a browser on the server machine itself (the
// case where the page was opened as localhost and the guide needs an address other computers can reach).
app.get(
  '/api/client-info',
  asyncRoute(async (req, res) => {
    let client = null;
    try {
      const pkg = await clientPackage();
      client = { version: pkg.version, package: packagePath(pkg) };
    } catch (error) {
      console.error(`[client] packaging failed: ${error.message}`);
    }
    const server = {
      publicUrl: config.publicUrl ?? null,
      ...(isLoopback(req.ip) ? { addresses: lanAddresses(), hostname: os.hostname() } : {}),
    };
    res.json({ tokenRequired: Boolean(config.ingestToken), client, server });
  }),
);

// Unknown API paths answer in JSON like every other API response.
app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));

// Node.js client package for `npx <url> setup`. Any version/hash in the name serves the current package; the
// hash only makes each build a distinct URL for npm's cache.
app.get(
  /^\/client\/cc-usage-client(-[\w.-]+)?\.tgz$/,
  asyncRoute(async (_req, res) => {
    const pkg = await clientPackage();
    res.type('application/gzip').sendFile(pkg.file, { dotfiles: 'allow' }); // may live in server/.client-dist
  }),
);

app.get('/vendor/chart.umd.js', (_req, res) => res.sendFile(chartUmd));
app.get('/vendor/msal-browser.min.js', (_req, res) => res.sendFile(msalBrowser));
app.use(express.static(path.join(root, 'public')));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err); // a streamed response failed mid-way; let Express close the socket
  const reject = (status, error) => {
    console.warn(`[${req.method} ${req.path}] rejected from ${req.ip}: ${error}`);
    res.status(status).json({ error });
  };
  if (err instanceof ValidationError) return reject(400, err.message);
  if (err?.type === 'entity.parse.failed') return reject(400, 'invalid JSON body');
  if (err?.type === 'entity.too.large') return reject(413, 'report too large');
  // Other client errors raised by Express or body-parser (bad URL encoding, missing file, unsupported charset).
  const status = err?.status ?? err?.statusCode;
  if (status >= 400 && status < 500) return reject(status, err.expose ? err.message : 'bad request');
  if (err instanceof AuthError) return res.status(err.status).json({ error: err.message }); // 503: keys unavailable
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

assertConfig();
// Listen first so /health answers right away; the database connects (and retries) in the background.
const server = app.listen(config.port, config.host, () => {
  console.log(`cc-usage server listening on ${config.host}:${config.port} (db ${config.mongoDb}` +
    `${config.ingestToken ? ', ingest token required' : ''}, sign-in ${authEnabled ? 'on' : 'off'})`);
  // Running open is fine on a developer's machine and the worst mistake in production, so say it loudly.
  if (!authEnabled) console.warn('[auth] ENTRA_TENANT_ID / ENTRA_API_CLIENT_ID are not set: the dashboard is open to anyone who can reach it.');
  else if (!config.adminEmails.length) console.warn('[auth] ADMIN_EMAILS is empty: every signed-in person sees only their own usage.');
  connectWithRetry();
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    setTimeout(() => process.exit(1), 10_000).unref(); // don't hang on a long export or keep-alive connection
    server.closeIdleConnections();
    server.close(async () => {
      try {
        await close();
      } catch (error) {
        console.error('[db] close failed', error);
      }
      process.exit(0);
    });
  });
}
