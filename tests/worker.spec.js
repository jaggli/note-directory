// worker.js runs directly in Node here, with Google's endpoints stubbed
const { test, expect } = require("@playwright/test");

const ORIGIN = "https://note.example";
const env = {
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "secret",
  COOKIE_KEY: Buffer.alloc(32, 7).toString("base64"),
  ASSETS: { fetch: () => new Response("asset") },
};

// Playwright's loader turns the ES module into CommonJS
const worker = require("../worker.js").default;
let google; // requests the Worker sent to Google
let googleReply;
const realFetch = globalThis.fetch;

test.beforeEach(() => {
  google = [];
  googleReply = () => Response.json({ access_token: "at", expires_in: 3599, refresh_token: "google-refresh-token" });
  globalThis.fetch = async (url, init) => {
    google.push({ url: String(url), body: new URLSearchParams(init.body) });
    return googleReply();
  };
});

test.afterAll(() => {
  globalThis.fetch = realFetch;
});

const call = (path, { method = "GET", cookie, origin = ORIGIN } = {}) =>
  worker.fetch(
    new Request(ORIGIN + path, {
      method,
      redirect: "manual",
      headers: { ...(cookie && { cookie }), ...(method === "POST" && { origin }) },
    }),
    env,
  );

const cookies = (res) => res.headers.getSetCookie();
const value = (setCookie) => setCookie.split(";")[0];

async function signIn() {
  const start = await call("/auth/start");
  const state = new URL(start.headers.get("location")).searchParams.get("state");
  const res = await call(`/auth/callback?code=c&state=${state}`, {
    cookie: value(cookies(start)[0]),
  });
  return { res, rt: value(cookies(res).find((c) => c.startsWith("__Host-note_rt="))) };
}

test("start asks Google for offline access with PKCE", async () => {
  const res = await call("/auth/start");
  expect(res.status).toBe(302);
  const url = new URL(res.headers.get("location"));
  expect(url.origin).toBe("https://accounts.google.com");
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    client_id: "client-id",
    redirect_uri: ORIGIN + "/auth/callback",
    scope: "https://www.googleapis.com/auth/drive.appdata",
    access_type: "offline",
    code_challenge_method: "S256",
  });
  expect(cookies(res)[0]).toMatch(/^__Host-note_oauth=.+HttpOnly; Secure; SameSite=Lax$/);
});

test("callback stores the refresh token encrypted and returns to the app", async () => {
  const { res, rt } = await signIn();
  expect(res.headers.get("location")).toBe(ORIGIN + "/?drive=connected");
  expect(google[0].body.get("grant_type")).toBe("authorization_code");
  expect(google[0].body.get("code_verifier")).toBeTruthy();
  expect(rt).not.toContain("google-refresh-token");
  expect(cookies(res).join()).toContain("HttpOnly; Secure; SameSite=Strict");
});

test("callback with a foreign state never contacts Google", async () => {
  const start = await call("/auth/start");
  const res = await call("/auth/callback?code=c&state=forged", {
    cookie: value(cookies(start)[0]),
  });
  expect(res.headers.get("location")).toBe(ORIGIN + "/?drive=error");
  expect(google).toHaveLength(0);
});

test("token trades the cookie for an access token", async () => {
  const { rt } = await signIn();
  const res = await call("/auth/token", { method: "POST", cookie: rt });
  expect(await res.json()).toEqual({ access_token: "at", expires_in: 3599 });
  expect(google[1].body.get("refresh_token")).toBe("google-refresh-token");
  expect(res.headers.get("cache-control")).toBe("no-store");
});

test("token refuses other sites, missing and tampered cookies", async () => {
  const { rt } = await signIn();
  expect((await call("/auth/token", { method: "POST", cookie: rt, origin: "https://evil.example" })).status).toBe(403);
  expect((await call("/auth/token", { method: "POST" })).status).toBe(401);
  expect((await call("/auth/token", { method: "POST", cookie: rt.slice(0, -2) + "AA" })).status).toBe(401);
  expect(google).toHaveLength(1); // only the sign-in exchange
});

test("a revoked grant signs out and clears the cookie", async () => {
  const { rt } = await signIn();
  googleReply = () => Response.json({ error: "invalid_grant" }, { status: 400 });
  const res = await call("/auth/token", { method: "POST", cookie: rt });
  expect(res.status).toBe(401);
  expect(cookies(res)[0]).toContain("Max-Age=0");
});

test("logout revokes at Google and clears the cookie", async () => {
  const { rt } = await signIn();
  const res = await call("/auth/logout", { method: "POST", cookie: rt });
  expect(google[1].url).toBe("https://oauth2.googleapis.com/revoke");
  expect(google[1].body.get("token")).toBe("google-refresh-token");
  expect(cookies(res)[0]).toContain("Max-Age=0");
});

test("everything outside /auth/ is a static file", async () => {
  expect(await (await call("/index.html")).text()).toBe("asset");
});
