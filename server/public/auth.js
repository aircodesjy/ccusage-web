/* global msal */

// Company-account (Microsoft) sign-in. Active only when the server turns it on (api/auth/config); otherwise
// every function here is a pass-through and the dashboard works as before.
// MSAL keeps the tokens (sessionStorage) and renews them; nothing is stored here.

const $ = (sel) => document.querySelector(sel);

let settings = { enabled: false };
let client = null;

/** Who is signed in: `{ enabled, email, name, role: 'admin' | 'user', user }` (user: the id their reports use). */
export const session = { enabled: false };

function showGate(message = '', { error = false, canSignIn = true } = {}) {
  document.body.classList.add('signed-out');
  $('#auth-gate').hidden = false;
  $('#login').hidden = !canSignIn;
  const status = $('#auth-status');
  status.textContent = message;
  status.classList.toggle('error', error);
}

async function authHeaders() {
  if (!settings.enabled) return {};
  const account = client.getActiveAccount();
  if (!account) {
    showGate();
    throw new Error('로그인이 필요합니다.');
  }
  const request = { scopes: [settings.scope], account };
  try {
    return { Authorization: `Bearer ${(await client.acquireTokenSilent(request)).accessToken}` };
  } catch {
    // Silent renewal failed (session expired, consent needed): send the person through the sign-in page again.
    await client.acquireTokenRedirect(request);
    throw new Error('로그인이 필요합니다.');
  }
}

/** fetch() with the signed-in person's token. */
export async function apiFetch(url, options = {}) {
  return fetch(url, { ...options, headers: { ...options.headers, ...(await authHeaders()) } });
}

/** Error text from an API response (`{ error }`), falling back to the status code. */
export async function errorText(res) {
  const body = await res.json().catch(() => null);
  return body?.error ?? `HTTP ${res.status}`;
}

/**
 * Signs the visitor in when the server requires it. Resolves true when the dashboard may load (signed in, or
 * sign-in is off) and false when the sign-in screen is showing instead.
 */
export async function initAuth() {
  try {
    settings = await (await fetch('api/auth/config')).json();
  } catch {
    showGate('로그인 설정을 불러오지 못했습니다. 잠시 후 새로고침해 주세요.', { error: true, canSignIn: false });
    return false;
  }
  if (!settings.enabled) return true;

  if (typeof msal === 'undefined') {
    showGate('로그인 모듈(vendor/msal-browser.min.js)을 불러오지 못했습니다.', { error: true, canSignIn: false });
    return false;
  }
  client = new msal.PublicClientApplication({
    auth: {
      clientId: settings.clientId,
      authority: `https://login.microsoftonline.com/${settings.tenantId}`,
      // The page's own address including the reverse-proxy sub-path; it must be registered exactly like this.
      redirectUri: new URL('.', location.href).href,
    },
    cache: { cacheLocation: 'sessionStorage' },
  });
  $('#login').addEventListener('click', () => {
    showGate('로그인 화면으로 이동합니다…');
    client.loginRedirect({ scopes: [settings.scope] }).catch(() => showGate('로그인을 시작할 수 없습니다.', { error: true }));
  });
  $('#logout').addEventListener('click', () => client.logoutRedirect({ account: client.getActiveAccount() }));

  let failed = false;
  try {
    // Returning from the sign-in page: this must run first or the account is not picked up.
    const result = await client.handleRedirectPromise();
    if (result?.account) client.setActiveAccount(result.account);
  } catch {
    failed = true;
  }
  const account = client.getActiveAccount() ?? client.getAllAccounts()[0];
  if (!account) {
    showGate(failed ? '로그인에 실패했습니다. 다시 시도해 주세요.' : '', { error: failed });
    return false;
  }
  client.setActiveAccount(account);

  // The server decides whether this account may use the dashboard, and as what.
  let res;
  try {
    res = await apiFetch('api/auth/me');
  } catch {
    return false; // the sign-in screen or a redirect is already showing
  }
  if (!res.ok) {
    $('#logout').hidden = res.status !== 403; // a refused account needs a way to switch to another one
    $('#auth-gate .gate-card').append($('#logout'));
    showGate(await errorText(res), { error: true, canSignIn: false });
    return false;
  }
  Object.assign(session, await res.json());
  const label = session.name ? `${session.name} (${session.email})` : session.email;
  $('#account').textContent = session.role === 'admin' ? `${label} · 관리자` : label;
  $('#account').hidden = false;
  $('#logout').hidden = false;
  return true;
}
