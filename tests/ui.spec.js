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

test("a share link wins over a saved note with the same name", async ({ page }) => {
  await openApp(page);
  const link = (content) =>
    page.evaluate(
      async (c) => location.origin + location.pathname + "?view=zen#name=shared.md&note=" + (await compress(c)),
      content,
    );
  const v1 = await link("# Version 1");
  const v2 = await link("# Version 2");
  await page.goto(v1);
  await expect(page.locator("#mdPreview h1")).toHaveText("Version 1");
  await page.evaluate(() => exitZenMode()); // saves it locally
  await page.goto(v1);
  await page.goto(v2); // same document, only the hash changes
  await expect(page.locator("#mdPreview h1")).toHaveText("Version 2");
});

test("zen share copies the open note, also right after creating it", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openApp(page);
  await page.evaluate(async () => {
    for (const n of state.notes.filter((n) => n.name === "markdown-features.md")) n.name += ".old";
    await openMdDemo(); // creates the note
    switchMdTab("zen", true);
    await zenShare();
  });
  const shared = await page.evaluate(async () => {
    const hash = new URL(await navigator.clipboard.readText()).hash;
    return decompress(parseHashParams(hash).get("note"));
  });
  expect(shared).toBe(await page.evaluate(() => MD_DEMO));
});

test("Alt+Up/Down moves lines in vim normal mode too", async ({ page }) => {
  await openApp(page);
  await page.evaluate(async () => {
    await createNote("move.txt", "one\ntwo\nthree");
    if (!vimState.enabled) toggleVim();
    vimSetCursor(1);
  });
  await page.keyboard.press("Alt+ArrowDown");
  expect(await page.evaluate(() => [editor.value, editor.selectionStart, vimState.mode])).toEqual([
    "two\none\nthree",
    5,
    "normal",
  ]);
  await page.keyboard.press("u");
  expect(await page.evaluate(() => editor.value)).toBe("one\ntwo\nthree");
  // selection ending at a line start does not drag that line along
  const r = await page.evaluate(() => {
    toggleVim();
    editor.setSelectionRange(0, 4); // "one\n"
    moveLines(1);
    return editor.value;
  });
  expect(r).toBe("two\none\nthree");
});
