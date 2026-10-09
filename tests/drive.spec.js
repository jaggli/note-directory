const { test, expect, openApp } = require("./fixtures");
const { fakeGoogle, connectedSession } = require("./fake-google");

const sync = (page) => page.evaluate(() => syncNow());
const note = (page, name) =>
  page.evaluate((name) => state.notes.find((n) => n.name === name) || null, name);
const remoteNote = (drive, name) => drive.read().notes.find((n) => n.name === name);

// Connected device with notes a.md, b.md already synced once
async function syncedDevice(page, context) {
  const drive = await fakeGoogle(context);
  await connectedSession(context);
  await openApp(page);
  await page.evaluate(async () => {
    await createNote("a.md", "a");
    await createNote("b.md", "b");
  });
  await sync(page);
  return drive;
}

test("first connect opens the sign-in popup once and creates the file", async ({
  page,
  context,
}) => {
  const drive = await fakeGoogle(context);
  await openApp(page);
  await page.click("#fileMenuContainer > button");
  await page.click("#btnDriveSync");
  await expect.poll(() => drive.files.length).toBe(1);
  expect(drive.read().notes.map((n) => n.name)).toContain("help.md");
  expect(await page.evaluate(() => __gis.interactive)).toBe(1);
  await expect(page.locator("#syncLabel")).toHaveText("sync");
});

test("a stale device does not revert other devices' changes", async ({
  page,
  context,
}) => {
  const drive = await syncedDevice(page, context);
  // Other device: edits a.md, creates c.md, deletes b.md
  const data = drive.read();
  const a = data.notes.find((n) => n.name === "a.md");
  const b = data.notes.find((n) => n.name === "b.md");
  a.content = "a from other device";
  a.updatedAt = Date.now() + 1000;
  data.notes = data.notes.filter((n) => n !== b);
  data.notes.push({ id: "c-id", name: "c.md", content: "c", updatedAt: Date.now() });
  data.deletedIds.push(b.id);
  data.deletedAt = { ...data.deletedAt, [b.id]: Date.now() };
  drive.write(data);

  // This device only touches an unrelated note
  await page.evaluate(() => createNote("mine.md", "mine"));
  await sync(page);

  const names = drive.read().notes.map((n) => n.name);
  expect(remoteNote(drive, "a.md").content).toBe("a from other device");
  expect(names).toContain("c.md");
  expect(names).toContain("mine.md");
  expect(names).not.toContain("b.md");
  expect((await note(page, "a.md")).content).toBe("a from other device");
  expect(await note(page, "b.md")).toBeNull();
});

test("both devices editing a note keeps both versions", async ({ page, context }) => {
  const drive = await syncedDevice(page, context);
  const data = drive.read();
  const a = data.notes.find((n) => n.name === "a.md");
  a.content = "remote edit";
  a.updatedAt = Date.now() + 1000;
  drive.write(data);
  await page.evaluate(() => {
    const n = state.notes.find((n) => n.name === "a.md");
    n.content = "local edit";
    n.updatedAt = Date.now();
  });
  await sync(page);

  const contents = await page.evaluate(() => state.notes.map((n) => [n.name, n.content]));
  expect(contents).toContainEqual(["a.md", "remote edit"]);
  expect(contents).toContainEqual(["a (conflict).md", "local edit"]);
  expect(drive.read().notes.map((n) => n.content)).toEqual(
    expect.arrayContaining(["remote edit", "local edit"]),
  );
});

test("a note edited after another device deleted it survives", async ({
  page,
  context,
}) => {
  const drive = await syncedDevice(page, context);
  const data = drive.read();
  const a = data.notes.find((n) => n.name === "a.md");
  data.notes = data.notes.filter((n) => n !== a);
  data.deletedIds.push(a.id);
  data.deletedAt = { [a.id]: Date.now() };
  drive.write(data);
  await page.evaluate(() => {
    const n = state.notes.find((n) => n.name === "a.md");
    n.content = "important late edit";
    n.updatedAt = Date.now();
  });
  await sync(page);
  expect((await note(page, "a.md"))?.content).toBe("important late edit");
  expect(remoteNote(drive, "a.md")?.content).toBe("important late edit");
});

test("remote change wins over unchanged local note despite clock skew", async ({
  page,
  context,
}) => {
  const drive = await syncedDevice(page, context);
  const data = drive.read();
  const a = data.notes.find((n) => n.name === "a.md");
  a.content = "from a device with a slow clock";
  a.updatedAt = 1;
  drive.write(data);
  await sync(page);
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("notepad_data")).notes.find((n) => n.name === "a.md"),
  );
  expect(stored.content).toBe("from a device with a slow clock");
});

test("edits made while an upload is in flight are uploaded too", async ({
  page,
  context,
}) => {
  const drive = await syncedDevice(page, context);
  let release;
  drive.beforePatch = () => new Promise((r) => (release = r));
  await page.evaluate(() => {
    const n = state.notes.find((n) => n.name === "a.md");
    n.content = "first";
    n.updatedAt = Date.now();
    scheduleDriveUpload(true);
  });
  await expect.poll(() => typeof release).toBe("function");
  await page.evaluate(() => {
    const n = state.notes.find((n) => n.name === "a.md");
    n.content = "second, typed during upload";
    n.updatedAt = Date.now();
    saveState();
    scheduleDriveUpload(true);
  });
  drive.beforePatch = null;
  release();
  await expect
    .poll(() => remoteNote(drive, "a.md").content)
    .toBe("second, typed during upload");
});

test("expired session never opens a popup on its own", async ({ page, context }) => {
  await fakeGoogle(context);
  await connectedSession(context, { expired: true });
  await context.addInitScript(() => {
    window.__gis = { interactive: 0, silent: 0, silentOk: false, revoked: null };
  });
  await openApp(page);
  await expect(page.locator("#syncLabel")).toHaveText("sync failed");
  await page.evaluate(() => {
    lastSyncCheck = 0;
    onTabResume();
    scheduleDriveUpload(true);
  });
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => __gis)).toMatchObject({ interactive: 0 });
  expect(await page.evaluate(() => __gis.silent)).toBeGreaterThan(0);

  // Clicking reconnect is allowed to open it
  await page.click(".statusbar #syncMenuContainer > button");
  await page.click('#syncMenuFailed button:has-text("reconnect")');
  await expect(page.locator("#syncLabel")).toHaveText("sync");
  expect(await page.evaluate(() => __gis.interactive)).toBe(1);
});

test("duplicate Drive files are merged into one", async ({ page, context }) => {
  const drive = await fakeGoogle(context);
  await connectedSession(context);
  const t = Date.now();
  drive.add({ notes: [{ id: "x", name: "x.md", content: "x", updatedAt: t }], deletedIds: [] });
  drive.add({ notes: [{ id: "y", name: "y.md", content: "y", updatedAt: t }], deletedIds: [] });
  await openApp(page);
  await sync(page);
  expect(drive.files).toHaveLength(1);
  const names = drive.read().notes.map((n) => n.name);
  expect(names).toEqual(expect.arrayContaining(["x.md", "y.md"]));
});

test("concurrent syncs create only one Drive file", async ({ page, context }) => {
  const drive = await fakeGoogle(context);
  await connectedSession(context);
  await openApp(page);
  await page.evaluate(() => Promise.all([syncNow(), syncNow(), syncNow()]));
  expect(drive.files).toHaveLength(1);
});

test("sign-out stops in-flight syncs and reaches other tabs", async ({
  page,
  context,
}) => {
  const drive = await syncedDevice(page, context);
  const other = await context.newPage();
  await openApp(other);
  // Headless tabs get no focus events; this is what the focus handler runs
  await page.evaluate(() => reclaimLeadership());

  let release;
  drive.beforePatch = () => new Promise((r) => (release = r));
  await page.evaluate(() => {
    state.notes[0].content = "change";
    state.notes[0].updatedAt = Date.now();
    scheduleDriveUpload(true);
  });
  await expect.poll(() => typeof release).toBe("function");
  await page.evaluate(() => driveSignOut());
  release();
  await page.waitForTimeout(200);

  expect(
    await page.evaluate(() => [gdriveConnected, localStorage.getItem("notepad_gdrive_connected")]),
  ).toEqual([false, null]);
  expect(await page.evaluate(() => __gis.revoked)).not.toBeNull();
  await expect.poll(() => other.evaluate(() => gdriveConnected)).toBe(false);
});

test("malformed remote data is ignored", async ({ page, context }) => {
  const drive = await fakeGoogle(context);
  await connectedSession(context);
  drive.add({
    notes: [{ id: 5 }, { id: "bad", name: "bad.md", content: null }, null,
      { id: "ok", name: "ok.md", content: "fine", updatedAt: Date.now() }],
    deletedIds: [1, "gone"],
    settings: { sidebarWidth: "1px;background:red" },
  });
  await openApp(page);
  await sync(page);
  const names = await page.evaluate(() => state.notes.map((n) => n.name));
  expect(names).toContain("ok.md");
  expect(names).not.toContain("bad.md");
});
