import fs from 'node:fs';

// Local runs read .env from the working directory. Values already in the environment (set by the deployment
// platform) are never overridden.
if (fs.existsSync('.env')) process.loadEnvFile('.env');

// Empty values count as unset (`||`), so a blank line in .env never yields port 0 or an empty URI.
const env = (name) => process.env[name] || undefined;

/** Database name from the connection string path (mongodb://host:27017/<db>), if any. */
function databaseFromUri(uri) {
  return /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/.exec(uri ?? '')?.[1] || undefined;
}

/** http(s) URL without a trailing slash, or undefined when unset. */
function baseUrl(value) {
  return value?.trim().replace(/\/+$/, '') || undefined;
}

/** Comma-separated values, lowercased (emails and domains compare without case). */
function list(value) {
  return (value ?? '').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
}

// MONGODB_URI is the documented name; MONGO_URL is accepted too.
const mongoUri = env('MONGODB_URI') ?? env('MONGO_URL');

export const config = {
  port: Number(env('PORT') ?? 3000),
  host: env('HOST') ?? '0.0.0.0',
  // No built-in default, so a missing setting is reported instead of silently using localhost.
  mongoUri,
  // MONGODB_DB wins, then the database in the connection string, then cc_usage.
  mongoDb: env('MONGODB_DB') ?? databaseFromUri(mongoUri) ?? 'cc_usage',
  // When set, POST /api/reports requires `Authorization: Bearer <token>`.
  ingestToken: env('INGEST_TOKEN') ?? null,
  // Address clients should use (e.g. https://tools.example.com/c/cc-usage). Shown in the setup guide when set;
  // otherwise the guide uses the address the dashboard was opened with.
  publicUrl: baseUrl(env('PUBLIC_URL')),
  // Timezone for timestamps written into Excel exports (containers usually run in UTC).
  reportTimezone: env('REPORT_TIMEZONE') ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  // Company-account sign-in for the dashboard (see auth.js). On when the tenant and API client ids are both set.
  entra: {
    tenantId: env('ENTRA_TENANT_ID') ?? null,
    apiClientId: env('ENTRA_API_CLIENT_ID') ?? null,
    // One app registration normally serves as both the page (SPA) and the API.
    spaClientId: env('ENTRA_SPA_CLIENT_ID') ?? env('ENTRA_API_CLIENT_ID') ?? null,
    requiredScope: env('ENTRA_REQUIRED_SCOPE') ?? 'access_as_user',
  },
  // Signed-in emails that may see every user's usage; everyone else sees only their own.
  adminEmails: list(env('ADMIN_EMAILS')),
  // Signed-in emails that may download the Excel report (unset: only jyso@aircode.com).
  exportEmails: list(env('EXPORT_EMAILS') ?? 'jyso@aircode.com'),
  // The company supports only Claude Code: other agents' usage (Codex) is stored and shown only for these users'
  // ids (unset: only shhong@aircode.com). Everyone else's is dropped on upload and removed on startup.
  codexEmails: list(env('CODEX_EMAILS') ?? 'shhong@aircode.com'),
  // Email domains allowed to sign in (empty: any account of the tenant, guests included).
  allowedEmailDomains: list(env('ALLOWED_EMAIL_DOMAINS')),
};

export const MISSING_MONGO_URI =
  'MONGODB_URI (or MONGO_URL) is not set. Set it in the deployment environment or in .env (e.g. mongodb://mongodb:27017/cc_usage).';

/** Settings that make the server unable to start at all. */
export function assertConfig() {
  if (config.publicUrl && !/^https?:\/\/[^/\s]+/.test(config.publicUrl)) {
    throw new Error(`PUBLIC_URL must start with http:// or https:// (got ${config.publicUrl}).`);
  }
  // Half a sign-in configuration is a typo, and starting without sign-in would silently open the dashboard.
  if (Boolean(config.entra.tenantId) !== Boolean(config.entra.apiClientId)) {
    throw new Error('ENTRA_TENANT_ID and ENTRA_API_CLIENT_ID must be set together (or both left empty to run without sign-in).');
  }
}
