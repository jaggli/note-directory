const { test, expect, openApp } = require("./fixtures");
const { fakeGoogle, connectedSession } = require("./fake-google");

const SECRET = "the vault code is 4711";

// Chromium's virtual authenticator: a platform passkey with PRF that
// approves every prompt
async function authenticator(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      hasPrf: true,
    },
  });
  // Deletes every passkey, as the password manager would
  return () => cdp.send("WebAuthn.clearCredentials", { authenticatorId });
}

// Counts passkey prompts (navigator.credentials.get calls)
const countPrompts = (context) =>
  context.addInitScript(() => {
    window.passkeyPrompts = 0;
    const get = navigator.credentials.get.bind(navigator.credentials);
    navigator.credentials.get = (o) => (window.passkeyPrompts++, get(o));
  });

// New encrypted file through the menu, first setup included; returns the
// recovery key shown on the way
async function newEncrypted(page, text = SECRET) {
  await page.click("#btnNewMenu");
  await page.click('#newMenu [data-action="new-encrypted"]');
  let recovery = null;
  if (await page.evaluate(() => !loadVaults().length)) {
    await page.click("#modalConfirm");
    const modal = page.locator("#modalText");
    await expect(modal).toContainText("Your recovery key");
    recovery = (await modal.textContent()).match(/[0-9A-Z]{4}(-[0-9A-Z]{4}){7}/)[0];
    await page.click("#modalConfirm");
  }
  await keepName(page);
  await page.keyboard.type(text);
  await expect.poll(() => sealedText(page)).toBe(text);
  return recovery;
}

// The new file's name field has focus once the file exists: keep the name
async function keepName(page) {
  await expect(page.locator("#crumbInput")).toBeFocused();
  await page.keyboard.press("Enter");
}

// The open file's text, once its stored ciphertext has caught up
const sealedText = (page) =>
  page.evaluate(() => {
    const o = opened.get(state.activeId);
    return o?.sealed === realNote(state.activeId).content ? o.text : null;
  });

// Everything this browser keeps or sends: IndexedDB, localStorage, the URL,
// the Drive payload
function storedText(page) {
  return page.evaluate(async () => {
    const db = await new Promise((r) => {
      const req = indexedDB.open("note-directory");
      req.onsuccess = () => r(req.result);
    });
    const notes = await new Promise((r) => {
      const req = db.transaction("notes").objectStore("notes").getAll();
      req.onsuccess = () => r(req.result);
    });
    db.close();
    const ls = Object.keys(localStorage).map((k) => localStorage.getItem(k));
    return JSON.stringify([notes, ls, location.href, gatherDrivePayload()]);
  });
}

const activeEnc = (page) =>
  page.evaluate(() => state.notes.find((n) => n.id === state.activeId));

test("an encrypted file's text never reaches storage, the URL or Drive", async ({
  page,
}) => {
  await authenticator(page);
  await openApp(page);
  await newEncrypted(page);
  await expect(page.locator("#editor")).toHaveValue(SECRET);
  const n = await activeEnc(page);
  expect(n.enc).toBeTruthy();
  expect(n.content).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
  await page.evaluate(() => idbFlushing);
  const stored = await storedText(page);
  expect(stored).not.toContain("4711");
  expect(stored).toContain(n.content);
  expect(new URL(page.url()).hash).not.toContain("note=");
  await expect(page.locator(".note-item.active .row-lock")).toBeVisible();
  // No sharing
  await expect(page.locator("#btnShare")).toBeDisabled();
});

test("lock by hand, unlock with the passkey; reload stays decryptable", async ({
  page,
  context,
}) => {
  await countPrompts(context);
  await authenticator(page);
  await openApp(page);
  await newEncrypted(page);
  await page.evaluate(() => lockNote(state.activeId));
  await expect(page.locator("#lockState")).toBeVisible();
  await expect(page.locator("#editor")).toHaveValue("");
  await page.evaluate(() => renameNote(realNote(state.activeId), "renamed.md"));
  await expect(page.locator("#lockName")).toHaveText("renamed.md");
  const before = await page.evaluate(() => passkeyPrompts);
  await page.click('[data-action="unlock-note"]');
  await expect(page.locator("#editor")).toHaveValue(SECRET);
  expect(await page.evaluate(() => passkeyPrompts)).toBe(before + 1);

  await page.reload();
  await expect(page.locator("#lockState")).toBeVisible();
  await page.click('[data-action="unlock-note"]');
  await expect(page.locator("#editor")).toHaveValue(SECRET);
});

test("files switch without a prompt until 5 idle minutes lock them all", async ({
  page,
  context,
}) => {
  await countPrompts(context);
  await authenticator(page);
  await openApp(page);
  await newEncrypted(page, "first");
  await newEncrypted(page, "second");
  const [a, b] = await page.evaluate(() =>
    state.notes.filter((n) => n.enc).map((n) => n.id),
  );
  const prompts = await page.evaluate(() => passkeyPrompts);
  await page.evaluate((id) => switchNote(id), b);
  await expect(page.locator("#editor")).toHaveValue("first");
  await page.evaluate((id) => switchNote(id), a);
  await expect(page.locator("#editor")).toHaveValue("second");
  expect(await page.evaluate(() => passkeyPrompts)).toBe(prompts);

  await page.evaluate(() => {
    lastActivity = Date.now() - 5 * 60 * 1000 - 1;
    lockIfIdle();
  });
  await expect(page.locator("#lockState")).toBeVisible();
  expect(await page.evaluate(() => opened.size + vaultKeys.size)).toBe(0);
  expect(await page.evaluate((id) => histories[id], a)).toBeUndefined();
});

test("downloading a locked file asks for the passkey first", async ({
  page,
  context,
}) => {
  await countPrompts(context);
  await authenticator(page);
  await openApp(page);
  await newEncrypted(page);
  const id = await page.evaluate(() => state.activeId);
  await page.evaluate((id) => lockNote(id), id);
  const before = await page.evaluate(() => passkeyPrompts);
  const download = page.waitForEvent("download");
  await page.evaluate((id) => downloadNote(realNote(id)), id);
  const file = await (await download).path();
  expect(require("fs").readFileSync(file, "utf8")).toBe(SECRET);
  expect(await page.evaluate(() => passkeyPrompts)).toBe(before + 1);
});

test("search finds an encrypted file by name, never by its text", async ({
  page,
}) => {
  await authenticator(page);
  await openApp(page);
  await newEncrypted(page);
  await page.evaluate(() => createNote("plain.md", "nothing here"));
  await page.keyboard.press("ControlOrMeta+p");
  await page.keyboard.type("4711");
  await expect(page.locator(".search-no-results")).toBeVisible();
});

test("a second device opens it with the recovery key and adds its passkey", async ({
  browser,
}) => {
  const ctxA = await browser.newContext();
  const drive = await fakeGoogle(ctxA);
  await connectedSession(ctxA);
  const a = await ctxA.newPage();
  await authenticator(a);
  await openApp(a);
  const recovery = await newEncrypted(a);
  await a.evaluate(() => syncNow());
  expect(drive.files[0].content).not.toContain("4711");
  expect(drive.read().vaults).toHaveLength(1);

  // Device B: same Drive, a passkey store without A's passkey
  const ctxB = await browser.newContext();
  const driveB = await fakeGoogle(ctxB);
  driveB.files = drive.files;
  await connectedSession(ctxB);
  const b = await ctxB.newPage();
  await authenticator(b);
  await openApp(b);
  const name = await a.evaluate(() => realNote(state.activeId).name);
  await expect
    .poll(() => b.evaluate((name) => state.notes.some((n) => n.name === name), name))
    .toBe(true);
  await b.evaluate((name) => switchNote(state.notes.find((n) => n.name === name).id), name);
  await expect(b.locator("#lockState")).toBeVisible();
  await b.click('[data-action="recover-note"]');
  await b.fill("#modalInput", recovery.toLowerCase());
  await b.click("#modalConfirm");
  await expect(b.locator("#modalText")).toContainText("Add a passkey");
  await b.click("#modalConfirm");
  await expect(b.locator("#editor")).toHaveValue(SECRET);
  expect(await b.evaluate(() => loadVaults()[0].slots.length)).toBe(3);
  await ctxA.close();
  await ctxB.close();
});

test("a deleted passkey: the recovery key adds a new one to the same vault", async ({
  page,
}) => {
  const deletePasskeys = await authenticator(page);
  await openApp(page);
  const recovery = await newEncrypted(page);
  await deletePasskeys();
  await page.reload();
  await page.click("#btnNewMenu");
  await page.click('#newMenu [data-action="new-encrypted"]');
  await expect(page.locator("#modalText")).toContainText("No passkey opened");
  await page.click("#modalConfirm");
  await page.fill("#modalInput", recovery);
  await page.click("#modalConfirm");
  await expect(page.locator("#modalText")).toContainText("Add a passkey");
  await page.click("#modalConfirm");
  await keepName(page);
  await page.keyboard.type("second");
  await expect.poll(() => sealedText(page)).toBe("second");
  const vaults = await page.evaluate(() => loadVaults());
  expect(vaults).toHaveLength(1);
  expect(vaults[0].slots.filter((s) => s.kind === "passkey")).toHaveLength(2);
});

test("a deleted passkey without recovery key: start over, the new vault wins", async ({
  page,
  context,
}) => {
  await countPrompts(context);
  const deletePasskeys = await authenticator(page);
  await openApp(page);
  await newEncrypted(page);
  const oldId = await page.evaluate(() => state.activeId);
  await deletePasskeys();
  await page.reload();
  await page.click("#btnNewMenu");
  await page.click('#newMenu [data-action="new-encrypted"]');
  await expect(page.locator("#modalText")).toContainText("No passkey opened");
  await page.click("#modalCancel");
  await expect(page.locator("#modalText")).toContainText("Start over");
  await page.click("#modalConfirm");
  await expect(page.locator("#modalText")).toContainText("Encrypted files are locked");
  await page.click("#modalConfirm");
  await expect(page.locator("#modalText")).toContainText("Your recovery key");
  await page.click("#modalConfirm");
  await keepName(page);
  await page.keyboard.type("fresh");
  await expect.poll(() => sealedText(page)).toBe("fresh");
  expect(await page.evaluate(() => loadVaults().length)).toBe(2);

  // Both vaults in one prompt: the new passkey answers for its own vault
  await page.reload();
  const before = await page.evaluate(() => passkeyPrompts);
  await page.click("#btnNewMenu");
  await page.click('#newMenu [data-action="new-encrypted"]');
  await keepName(page);
  await page.keyboard.type("third");
  await expect.poll(() => sealedText(page)).toBe("third");
  expect(await page.evaluate(() => passkeyPrompts)).toBe(before + 1);
  expect(await page.evaluate((id) => isLocked(realNote(id)), oldId)).toBe(true);
});

test("without PRF support nothing about encryption shows", async ({ page, context }) => {
  await context.addInitScript(() => {
    PublicKeyCredential.getClientCapabilities = async () => ({});
  });
  await openApp(page);
  await page.click("#btnNewMenu");
  await expect(page.locator('#newMenu [data-action="new-encrypted"]')).toBeHidden();
});
