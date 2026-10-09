// In-memory stand-ins for Google Identity Services and the Drive v3 API

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, PATCH, DELETE",
};

// window.__gis counts token requests; silentOk=false simulates an expired
// Google session (silent refresh fails, only a popup would work)
const GIS_SCRIPT = `
window.__gis = window.__gis || { interactive: 0, silent: 0, silentOk: true, revoked: null };
window.google = { accounts: { oauth2: {
  initTokenClient(cfg) {
    return { requestAccessToken(opts) {
      if (opts && opts.prompt === "") {
        __gis.silent++;
        if (!__gis.silentOk) return setTimeout(() => cfg.error_callback({ type: "popup_failed_to_open" }));
      } else __gis.interactive++;
      setTimeout(() => cfg.callback({ access_token: "tok" + Math.random(), expires_in: 3600 }));
    } };
  },
  revoke(token) { __gis.revoked = token; },
} } };`;

exports.fakeGoogle = async (context) => {
  const drive = { files: [], nextId: 1, beforePatch: null };

  await context.route("https://accounts.google.com/gsi/client", (route) =>
    route.fulfill({ contentType: "text/javascript", body: GIS_SCRIPT }),
  );

  await context.route("https://www.googleapis.com/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const json = (body, status = 200) =>
      route.fulfill({
        status,
        headers: CORS,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (method === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });

    if (url.pathname === "/drive/v3/files" && method === "GET")
      return json({
        files: drive.files.map((f) => ({ id: f.id, version: String(f.version) })),
      });

    let m = url.pathname.match(/^\/drive\/v3\/files\/(.+)$/);
    if (m) {
      const file = drive.files.find((f) => f.id === m[1]);
      if (!file) return json({}, 404);
      if (method === "DELETE") {
        drive.files = drive.files.filter((f) => f !== file);
        return route.fulfill({ status: 204, headers: CORS });
      }
      if (url.searchParams.get("alt") === "media")
        return route.fulfill({ headers: CORS, contentType: "application/json", body: file.content });
      return json({ version: String(file.version) });
    }

    m = url.pathname.match(/^\/upload\/drive\/v3\/files\/(.+)$/);
    if (m && method === "PATCH") {
      if (drive.beforePatch) await drive.beforePatch();
      const file = drive.files.find((f) => f.id === m[1]);
      if (!file) return json({}, 404);
      file.content = req.postData();
      file.version++;
      return json({ id: file.id });
    }

    if (url.pathname === "/upload/drive/v3/files" && method === "POST") {
      const content = req.postData().split("\r\n\r\n")[2].split("\r\n--")[0];
      const file = { id: "f" + drive.nextId++, version: 1, content };
      drive.files.push(file);
      return json({ id: file.id });
    }
    return json({ error: "unhandled " + method + " " + url.pathname }, 400);
  });

  // Helpers acting as "another device" writing to Drive
  drive.read = (i = 0) => JSON.parse(drive.files[i].content);
  drive.write = (data, i = 0) => {
    drive.files[i].content = JSON.stringify(data);
    drive.files[i].version++;
  };
  drive.add = (data) =>
    drive.files.push({ id: "f" + drive.nextId++, version: 1, content: JSON.stringify(data) });
  return drive;
};

// Pretend the user connected Drive earlier (valid token unless `expired`)
exports.connectedSession = (context, { expired = false } = {}) =>
  context.addInitScript((expired) => {
    if (localStorage.getItem("notepad_gdrive_connected") !== null) return;
    localStorage.setItem("notepad_gdrive_connected", "true");
    localStorage.setItem(
      "notepad_gdrive_token",
      JSON.stringify({ token: "tok", expiry: Date.now() + (expired ? -1 : 3600e3) }),
    );
  }, expired);
