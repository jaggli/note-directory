const { test, expect, openApp } = require("./fixtures");

const visible = (page, sel) =>
  page.locator(sel).evaluate((e) => e.classList.contains("visible"));

test("toolbar and menu buttons work without inline handlers", async ({
  page,
}) => {
  await openApp(page);
  const count = () => page.evaluate(() => state.notes.length);
  const n0 = await count();
  await page.click('.statusbar button:has-text("new")');
  expect(await count()).toBe(n0 + 1);

  await page.click("#fileMenuContainer > button");
  expect(await visible(page, "#fileMenu")).toBe(true);
  await page.click('#fileMenu button:has-text("help")');
  expect(await page.evaluate(() => getActiveNote().name)).toBe("help.md");
  expect(await visible(page, "#fileMenu")).toBe(false);

  await page.click("#mdTabView");
  expect(await page.evaluate(() => mdViewActive && !zenModeActive)).toBe(true);
  await page.click("#mdTabZen");
  expect(await page.evaluate(() => zenModeActive)).toBe(true);
  await page.click(".zen-close-btn");
  expect(await page.evaluate(() => zenModeActive || mdViewActive)).toBe(false);

  const wrapped = () =>
    page.locator("#editorArea").evaluate((e) => e.classList.contains("wrap"));
  const w0 = await wrapped();
  await page.click("#btnWrap");
  expect(await wrapped()).toBe(!w0);

  await page.click('.statusbar button:has-text("search")');
  expect(await visible(page, "#searchResults")).toBe(true);
  await page.click(".btn-search-close");
  expect(await visible(page, "#searchResults")).toBe(false);

  await page.click("#btnReplace");
  expect(await visible(page, "#findReplaceBar")).toBe(true);
  await page.click("[data-action=close-find-replace]");
  expect(await visible(page, "#findReplaceBar")).toBe(false);

  await page.click("#btnVim");
  expect(await page.evaluate(() => vimState.enabled)).toBe(true);
});

test("format shortcut shows a toast", async ({ page }) => {
  await openApp(page);
  await page.locator("#editor").focus();
  await page.keyboard.press("Control+Shift+F");
  await expect(page.locator("#mdToast")).toHaveText("formatted");
});

test("delete dialog still works after an import dialog", async ({ page }) => {
  await openApp(page);
  const choice = page.evaluate(() => showImportModal("foo.md"));
  await page.locator(".modal-actions button", { hasText: "skip" }).click();
  expect(await choice).toBe("skip");

  const before = await page.evaluate(() => state.notes.length);
  await page.evaluate(() => {
    confirmDelete(getActiveNote().id);
  });
  const labels = await page
    .locator(".modal-actions button:visible")
    .allTextContents();
  expect(labels.map((s) => s.trim())).toEqual(["cancel", "delete"]);
  await page.click("#modalConfirm");
  await expect
    .poll(() => page.evaluate(() => state.notes.length))
    .toBe(before - 1);
});

test("concurrent dialogs are shown one after another", async ({ page }) => {
  await openApp(page);
  const answers = page.evaluate(() =>
    Promise.all([showModal("first", "ok", "no"), showModal("second", "ok", "no")]),
  );
  await expect(page.locator("#modalText")).toHaveText("first");
  await page.click("#modalConfirm");
  await expect(page.locator("#modalText")).toHaveText("second");
  await page.click("#modalCancel");
  expect(await answers).toEqual([true, false]);
});
