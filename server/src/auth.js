import { createRemoteJWKSet, errors, jwtVerify } from 'jose';
import { config } from './config.js';

// Company-account sign-in (Microsoft Entra ID). The browser signs in with MSAL.js (SPA + PKCE, so there is no
// client secret) and sends the access token as `Authorization: Bearer`; this module only verifies it.
// `aud` is the app boundary: use an app registration of this dashboard's own, or tokens issued for another
// internal app pass here too.

const { tenantId, apiClientId, spaClientId, requiredScope } = config.entra;

/** Sign-in is on only when both ids are set; assertConfig() rejects a half-configured server. */
export const authEnabled = Boolean(tenantId && apiClientId);

/** What the browser needs to start a sign-in. None of this is secret (it all appears in the login URL). */
export const authClientConfig = authEnabled
  ? { enabled: true, tenantId, clientId: spaClientId, scope: `api://${apiClientId}/${requiredScope}` }
  : { enabled: false };

let remoteKeys;
// Signing keys are fetched once and cached by jose (re-fetched when an unknown key id shows up).
const tenantKeys = () =>
  (remoteKeys ??= createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`)));

export class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.expose = true; // the message is written for the person signing in
  }
}

const SIGN_IN = '로그인이 필요합니다.';

/** Lowercased address, or null unless it is one plain `name@domain` (rejects `a@evil.com@company.com`). */
function normalizeEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[^@\s]+@[^@\s]+$/.test(email) ? email : null;
}

/**
 * Verifies an Entra access token and returns `{ email, name, role }`. Throws AuthError: 401 for a missing or bad
 * token, 403 for a valid token that may not use this app, 503 when Microsoft's signing keys cannot be fetched.
 * `keys` is only passed by tests.
 */
export async function verifyToken(token, keys = tenantKeys()) {
  let payload;
  try {
    ({ payload } = await jwtVerify(token, keys, {
      algorithms: ['RS256'], // fixed, so `alg: none` or an HS256 token signed with the public key never passes
      issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
      audience: apiClientId,
      requiredClaims: ['exp', 'iat'],
    }));
  } catch (error) {
    // Not being able to fetch the keys says nothing about the token: answering 401 would only loop the sign-in.
    const keysUnavailable =
      !(error instanceof errors.JOSEError) || error instanceof errors.JWKSTimeout || error.code === 'ERR_JOSE_GENERIC';
    if (!keysUnavailable) throw new AuthError(401, SIGN_IN);
    console.error(`[auth] could not load the signing keys: ${error.message}`);
    throw new AuthError(503, '인증 서비스에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.');
  }

  if (payload.ver !== '2.0' || !payload.oid) throw new AuthError(401, SIGN_IN);
  // Without the tenant check any personal Microsoft account could read the company's usage.
  if (String(payload.tid ?? '').toLowerCase() !== tenantId.toLowerCase()) {
    throw new AuthError(403, '회사 계정으로만 이용할 수 있습니다.');
  }
  // Delegated (signed-in person) tokens only: without `scp` a service called on its own behalf.
  if (typeof payload.scp !== 'string' || !payload.scp.split(' ').includes(requiredScope)) {
    throw new AuthError(403, '이 앱에 대한 권한이 없습니다.');
  }

  const email = normalizeEmail(payload.preferred_username ?? payload.upn);
  // Guests and partner accounts belong to the tenant but have another domain, so the domain is checked as well.
  const domains = config.allowedEmailDomains;
  if (!email || (domains.length && !domains.includes(email.split('@')[1]))) {
    throw new AuthError(403, `${domains.join(', ') || '회사'} 계정만 이용할 수 있습니다. (현재 계정: ${email ?? '이메일 없음'})`);
  }

  return {
    email,
    name: typeof payload.name === 'string' ? payload.name : null,
    // Admins see everyone, everyone else only their own usage. The list is ours (ADMIN_EMAILS), not a token claim.
    role: config.adminEmails.includes(email) ? 'admin' : 'user',
    // The Excel download is a separate list (EXPORT_EMAILS): being an admin does not include it.
    canExport: config.exportEmails.includes(email),
    // Whether this person's own Codex usage is kept (CODEX_EMAILS); otherwise the page shows Claude Code only.
    codex: config.codexEmails.includes(email),
  };
}

/**
 * Express middleware for the dashboard's read APIs. Sets `req.auth`; with sign-in off (local runs) it passes
 * everything through and `req.auth` stays undefined, which the routes treat as "no restriction".
 */
export async function requireUser(req, _res, next) {
  if (!authEnabled) return next();
  const [scheme, token, ...rest] = (req.get('authorization') ?? '').split(/\s+/);
  if (scheme?.toLowerCase() !== 'bearer' || !token || rest.length) throw new AuthError(401, SIGN_IN);
  req.auth = await verifyToken(token);
  next();
}
