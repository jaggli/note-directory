const { test, expect, openApp } = require("./fixtures");

const visible = (page, sel) =>
  page.locator(sel).evaluate((e) => e.classList.contains("visible"));

test("toolbar and menu buttons work without inline handlers", async ({
  page,
}) => {
  await openApp(page);
  const count = () => page.evaluate(() => state.notes.length);
  const n0 = await count();
  await page.click('.side-head [data-action="new-note-rename"]');
  expect(await count()).toBe(n0 + 1);
  await expect(page.locator("#crumbInput")).toBeFocused();
  await page.keyboard.press("Escape");

  await page.click("#btnAppMenu");
  expect(await visible(page, "#appMenu")).toBe(true);
  await page.click('#appMenu button:has-text("Help")');
  expect(await page.evaluate(() => getActiveNote().name)).toBe("help.md");
  await expect(page.locator("#mdTabView")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#mdPreview")).toBeVisible();
  expect(await visible(page, "#appMenu")).toBe(false);

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
  await expect(page.locator("#btnWrap")).toHaveAttribute("aria-pressed", String(!w0));

  await page.click(".side-search .field");
  expect(await visible(page, "#searchResults")).toBe(true);
  await page.click("#searchBackdrop", { position: { x: 5, y: 5 } });
  expect(await visible(page, "#searchResults")).toBe(false);

  await page.click("#btnNoteMenu");
  expect(await visible(page, "#noteMenu")).toBe(true);
  await page.keyboard.press("Escape");
  expect(await visible(page, "#noteMenu")).toBe(false);

  await page.click("#btnShare");
  await expect.poll(() => visible(page, "#sharePop")).toBe(true);
  await page.click("#btnShare");
  await expect.poll(() => visible(page, "#sharePop")).toBe(false);

  await page.locator("#editor").focus();
  await page.keyboard.press("Control+h");
  expect(await visible(page, "#findReplaceBar")).toBe(true);
  await page.click("[data-action=close-find-replace]");
  expect(await visible(page, "#findReplaceBar")).toBe(false);

  await page.click("#btnVim");
  expect(await page.evaluate(() => vimState.enabled)).toBe(true);
  await expect(page.locator("#vimPill")).toHaveText("NORMAL");
});

test("format shortcut shows a toast", async ({ page }) => {
  await openApp(page);
  await page.locator("#editor").focus();
  await page.keyboard.press("Control+Shift+F");
  await expect(page.locator("#mdToast")).toHaveText("Formatted");
});

test("delete is immediate and undoable, also with ⌘Z", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => createNote("bye.md", "keep me"));
  await page.keyboard.press("Escape");
  const names = () => page.evaluate(() => state.notes.map((n) => n.name));
  await page.keyboard.press("Control+Shift+D");
  await expect(page.locator("#modalOverlay")).toBeHidden();
  expect(await names()).not.toContain("bye.md");
  await expect(page.locator("#mdToast")).toContainText("Deleted bye.md");
  await page.click("#mdToast .toast-act");
  expect(await names()).toContain("bye.md");
  expect(await page.evaluate(() => getActiveNote().content)).toBe("keep me");

  await page.click('.note-item:has-text("bye.md")', { button: "right" });
  await page.click('#noteMenu [data-note-act="delete"]');
  expect(await names()).not.toContain("bye.md");
  await page.keyboard.press("Control+z");
  expect(await names()).toContain("bye.md");
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
  });
  await page.click("[data-action=zen-share]");
  await page.click('#sharePop [data-share="copy"]');
  await expect(page.locator("#mdToast")).toHaveText("Link copied");
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

for (const tab of ["view", "zen"]) {
  test(`unsaved vim edits survive switching to ${tab} and back`, async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => {
      createNote();
      getActiveNote().name = "notes.md";
      getActiveNote().content = "";
      render();
      if (!vimState.enabled) toggleVim();
    });
    await page.click("#editor");
    await page.keyboard.type("ihello world");
    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => vimState.bufferDirty)).toBe(true);
    await page.click(tab === "zen" ? "#mdTabZen" : "#mdTabView");
    expect(await page.locator("#mdPreview").textContent()).toContain("hello world");
    await page.click(tab === "zen" ? ".zen-close-btn" : "#mdTabEdit");
    expect(await page.evaluate(() => editor.value)).toBe("hello world");
    expect(await page.evaluate(() => getActiveNote().content)).toBe("hello world");
  });
}

test("tab at the start of a list item changes its nesting level", async ({
  page,
}) => {
  await openApp(page);
  await page.evaluate(() => createNote("list.md", "- a\n- \n  - [ ] b\nplain"));
  const at = (pos) =>
    page.evaluate((p) => editor.setSelectionRange(p, p), pos);
  const state = () =>
    page.evaluate(() => [editor.value, editor.selectionStart]);
  await page.locator("#editor").focus();

  // Empty item, cursor after the marker
  await at(6);
  await page.keyboard.press("Tab");
  expect(await state()).toEqual(["- a\n  - \n  - [ ] b\nplain", 8]);
  await page.keyboard.press("Shift+Tab");
  expect(await state()).toEqual(["- a\n- \n  - [ ] b\nplain", 6]);

  // Item with content, cursor at line start
  await at(0);
  await page.keyboard.press("Tab");
  expect(await state()).toEqual(["  - a\n- \n  - [ ] b\nplain", 2]);
  await page.keyboard.press("Shift+Tab");
  expect(await state()).toEqual(["- a\n- \n  - [ ] b\nplain", 0]);

  // Task item, cursor after the checkbox
  await at(15);
  await page.keyboard.press("Shift+Tab");
  expect(await state()).toEqual(["- a\n- \n- [ ] b\nplain", 13]);

  // Inside the item text, Tab still inserts spaces
  await at(1 + 2);
  await page.keyboard.press("Tab");
  expect((await state())[0]).toBe("- a  \n- \n- [ ] b\nplain");
});
