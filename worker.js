// Google sign-in for Drive sync. Everything else is a static asset.
//
// Google only issues refresh tokens to clients that can keep a secret, so
// this Worker does the code exchange and keeps the refresh token in an
// encrypted HttpOnly cookie. The app gets short-lived access tokens from
// /auth/token without any popup. No state is stored server-side and notes
// never pass through here: the app talks to the Drive API directly.
//
// Env: GOOGLE_CLIENT_ID (var), GOOGLE_CLIENT_SECRET and COOKIE_KEY (secrets;
// COOKIE_KEY is 32 random bytes, base64).

const SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const RT_COOKIE = "__Host-note_rt";
const FLOW_COOKIE = "__Host-note_oauth";
const RT_MAX_AGE = 400 * 24 * 3600; // Chrome's cap; renewed on every use

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const route = `${req.method} ${url.pathname}`;
    if (route === "GET /auth/start") return start(url, env);
    if (route === "GET /auth/callback") return callback(req, url, env);
    if (route === "POST /auth/token") return token(req, env);
    if (route === "POST /auth/logout") return logout(req, env);
    if (url.pathname.startsWith("/auth/")) return new Response(null, { status: 404 });
    return env.ASSETS.fetch(req);
  },
};

async function start(url, env) {
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", enc(verifier))),
  );
  const google = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  google.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: url.origin + "/auth/callback",
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    // Google only returns a refresh token on consent
    prompt: "consent",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  // Lax: the callback is a cross-site navigation from Google
  return redirect(google, [
    cookie(FLOW_COOKIE, `${state}.${verifier}`, { maxAge: 600, sameSite: "Lax" }),
  ]);
}

async function callback(req, url, env) {
  const [state, verifier] = (getCookie(req, FLOW_COOKIE) || "").split(".");
  const clearFlow = cookie(FLOW_COOKIE, "", { maxAge: 0, sameSite: "Lax" });
  const fail = (reason) => redirect(new URL("/?drive=" + reason, url), [clearFlow]);
  const code = url.searchParams.get("code");
  if (!code) return fail("denied");
  if (!state || state !== url.searchParams.get("state")) {
    console.log("state mismatch", { cookie: !!state });
    return fail("error");
  }

  const res = await googleToken(env, {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: url.origin + "/auth/callback",
  });
  if (!res.ok) {
    // Google's error code only, e.g. invalid_client or redirect_uri_mismatch
    const { error, error_description } = await res.json().catch(() => ({}));
    console.log("code exchange failed", res.status, error, error_description);
    return fail("error");
  }
  const data = await res.json();
  if (!data.refresh_token) return fail("error");
  return redirect(new URL("/?drive=connected", url), [
    clearFlow,
    cookie(RT_COOKIE, await seal(env, data.refresh_token), { maxAge: RT_MAX_AGE }),
  ]);
}

async function token(req, env) {
  if (!sameOrigin(req)) return json({ error: "forbidden" }, 403);
  const rt = await open(env, getCookie(req, RT_COOKIE));
  if (!rt) return json({ error: "signed_out" }, 401);
  const res = await googleToken(env, { grant_type: "refresh_token", refresh_token: rt });
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({}));
    // Revoked by the user, or expired: only a new sign-in helps
    if (error === "invalid_grant")
      return json({ error: "signed_out" }, 401, [cookie(RT_COOKIE, "", { maxAge: 0 })]);
    return json({ error: "google_unavailable" }, 502);
  }
  const { access_token, expires_in } = await res.json();
  return json({ access_token, expires_in }, 200, [
    cookie(RT_COOKIE, await seal(env, rt), { maxAge: RT_MAX_AGE }),
  ]);
}

async function logout(req, env) {
  if (!sameOrigin(req)) return json({ error: "forbidden" }, 403);
  const rt = await open(env, getCookie(req, RT_COOKIE));
  if (rt)
    await fetch(REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: rt }),
    }).catch(() => {});
  return json({ ok: true }, 200, [cookie(RT_COOKIE, "", { maxAge: 0 })]);
}

function googleToken(env, params) {
  return fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      ...params,
    }),
  });
}

// Browsers send Origin on every POST; a mismatch is another site
function sameOrigin(req) {
  return req.headers.get("origin") === new URL(req.url).origin;
}

// ── Cookie encryption (AES-GCM) ─────────────────────

async function key(env) {
  const raw = Uint8Array.from(atob(env.COOKIE_KEY), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function seal(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(env), enc(text));
  return b64url(iv) + "." + b64url(new Uint8Array(ct));
}

// null for a missing, tampered or foreign cookie
async function open(env, value) {
  try {
    const [iv, ct] = value.split(".").map(unb64url);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await key(env), ct);
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

// ── Helpers ─────────────────────────────────────────

const enc = (s) => new TextEncoder().encode(s);

function b64url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function unb64url(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function getCookie(req, name) {
  for (const part of (req.headers.get("cookie") || "").split(/;\s*/)) {
    const i = part.indexOf("=");
    if (part.slice(0, i) === name) return part.slice(i + 1);
  }
  return null;
}

// __Host- cookies: Secure, Path=/, no Domain, so subdomains can't set them
function cookie(name, value, { maxAge, sameSite = "Strict" }) {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=${sameSite}`;
}

function redirect(location, cookies = []) {
  const headers = new Headers({ location: String(location), "cache-control": "no-store" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 302, headers });
}

function json(body, status = 200, cookies = []) {
  const headers = new Headers({
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(JSON.stringify(body), { status, headers });
}
