// The redesigned chrome end to end: title bar, list, palette, feedback,
// shared links, import, settings (design/pages/brief.html)
const { test, expect, openApp } = require("./fixtures");

const names = (page) => page.evaluate(() => state.notes.map((n) => n.name));
const shareLinkTo = (page, name, content, view = "") =>
  page.evaluate(
    async ([name, content, view]) =>
      location.origin +
      location.pathname +
      (view ? "?view=" + view : "") +
      "#name=" +
      encodeURIComponent(name) +
      "&note=" +
      (await compress(content)),
    [name, content, view],
  );

test("title bar: name and state, F2 renames, Esc cancels, taken names are refused", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => createNote("taken.md", "x"));
  await page.keyboard.press("Escape");
  await page.evaluate(() => createNote("mine.md", "y"));
  await page.keyboard.press("Escape");
  await expect(page.locator("#crumbName")).toHaveText("mine.md");
  await expect(page.locator("#crumbState")).toHaveText("Saved");

  await page.keyboard.press("F2");
  await expect(page.locator("#crumbInput")).toBeFocused();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("other.md");
  await page.keyboard.press("Escape");
  await expect(page.locator("#crumbName")).toHaveText("mine.md");

  await page.click("#crumbBtn");
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("taken.md");
  await page.keyboard.press("Enter");
  await expect(page.locator("#crumbInput")).toHaveClass(/error/);
  await expect(page.locator("#tip")).toHaveText("A note called taken.md exists");
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("renamed.md");
  await page.keyboard.press("Enter");
  await expect(page.locator("#crumbName")).toHaveText("renamed.md");
  await expect(page.locator("#editor")).toBeFocused();
  expect(await names(page)).toContain("renamed.md");
});

test("a new note starts in its name; Enter drops into the text", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Control+n");
  await expect(page.locator("#crumbInput")).toBeFocused();
  await page.keyboard.type("plan");
  await page.keyboard.press("Enter");
  await page.keyboard.type("first line");
  expect(await page.evaluate(() => [getActiveNote().name, getActiveNote().content])).toEqual([
    "plan.md",
    "first line",
  ]);
});

test("list: kinds, pinned section, double-click renames in place", async ({ page }) => {
  await openApp(page);
  await page.evaluate(async () => {
    await createNote("a.draw", "draw 1\n");
    await createNote("b.sh", "echo");
    await createNote("c.md", "# c");
  });
  await page.keyboard.press("Escape");
  await expect(page.locator('.note-item:has-text("a.draw") .kind')).toHaveClass(/draw/);
  await expect(page.locator('.note-item:has-text("b.sh") .kind')).toHaveClass(/code/);
  await expect(page.locator(".list-label")).toHaveCount(0);
  await page.hover('.note-item:has-text("b.sh")');
  await page.click('.note-item:has-text("b.sh") .btn-pin');
  await expect(page.locator(".list-label")).toHaveText(["Pinned", "Notes"]);
  await expect(page.locator(".note-item").first()).toContainText("b.sh");

  await page.dblclick('.note-item:has-text("c.md") .note-item-name');
  await expect(page.locator(".note-item-input")).toBeFocused();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("d.md");
  await page.keyboard.press("Enter");
  expect(await names(page)).toContain("d.md");
});

test("⌘\\ folds the sidebar away and the title bar brings it back", async ({ page }) => {
  await openApp(page);
  // "Saved" repeats the sidebar footer, so it only shows with the sidebar away
  await expect(page.locator("#crumbState")).toBeHidden();
  await page.keyboard.press("ControlOrMeta+\\");
  await expect(page.locator(".sidebar")).toBeHidden();
  await expect(page.locator("#crumbState")).toHaveText("Saved");
  await expect(page.locator("#crumbState")).toBeVisible();
  await page.click("#btnSidebar");
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(page.locator("#crumbState")).toBeHidden();
});

test("⌘E switches Edit and Preview; the status bar follows", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => createNote("w.md", "one two three"));
  await page.keyboard.press("Escape");
  await expect(page.locator("#cursorPos")).toHaveText(/^Ln \d+, Col \d+$/);
  await page.keyboard.press("ControlOrMeta+e");
  await expect(page.locator("#mdPreview")).toBeVisible();
  await expect(page.locator("#cursorPos")).toHaveText("3 words · 1 min read");
  await expect(page.locator("#btnWrap")).toBeHidden();
  await page.keyboard.press("ControlOrMeta+e");
  await expect(page.locator("#btnWrap")).toBeVisible();
});

test("palette: > runs commands, empty shows recent notes", async ({ page }) => {
  await openApp(page);
  await page.evaluate(async () => {
    await createNote("first.md", "a");
    await createNote("second.md", "b");
  });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+p");
  await expect(page.locator(".search-group")).toHaveText("Recent");
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => getActiveNote().name)).toBe("first.md");

  await page.keyboard.press("Control+Shift+P");
  await expect(page.locator("#searchInput")).toHaveValue("> ");
  await page.keyboard.type("markdown guide");
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => getActiveNote().name)).toBe("markdown-features.md");

  await page.keyboard.press("Control+p");
  await page.keyboard.type("nothing-like-this");
  await page.click(".search-no-results button");
  expect(await page.evaluate(() => getActiveNote().name)).toBe("nothing-like-this.md");
});

test("replace all says how many and undoes in one step", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => createNote("r.txt", "a a a"));
  await page.keyboard.press("Escape");
  await page.locator("#editor").focus();
  await page.keyboard.press("Control+h");
  await page.locator("#findInput").fill("a");
  await page.locator("#replaceInput").fill("b");
  await page.click("[data-action=replace-all]");
  expect(await page.evaluate(() => editor.value)).toBe("b b b");
  await expect(page.locator("#mdToast")).toContainText("Replaced 3");
  await page.click("#mdToast .toast-act");
  expect(await page.evaluate(() => editor.value)).toBe("a a a");
});

test("a shared link opens unsaved under a banner; Save keeps it", async ({ page }) => {
  await openApp(page);
  const url = await shareLinkTo(page, "gift.md", "# Gift\n\n- [ ] open it");
  await page.goto(url);
  await expect(page.locator("#banner")).toContainText("Shared with you");
  await expect(page.locator("#mdPreview h1")).toHaveText("Gift");
  await expect(page.locator("#crumbState")).toHaveText("Shared · not saved");
  expect(await names(page)).not.toContain("gift.md");
  await expect(page.locator(".note-item", { hasText: "gift.md" })).toHaveCount(0);
  await page.click('#banner button:has-text("Save to my notes")');
  await expect(page.locator("#banner")).toBeHidden();
  expect(await names(page)).toContain("gift.md");
});

test("a shared link can be dismissed, and saves itself on the first edit", async ({ page }) => {
  await openApp(page);
  await page.goto(await shareLinkTo(page, "skip.md", "# Skip"));
  await page.click('#banner button:has-text("Dismiss")');
  await expect(page.locator("#banner")).toBeHidden();
  expect(await names(page)).not.toContain("skip.md");

  await page.goto(await shareLinkTo(page, "keep.md", "# Keep\n\n- [ ] task"));
  await page.locator("#mdPreview input[type=checkbox]").click();
  await expect(page.locator("#banner")).toBeHidden();
  expect(await page.evaluate(() => state.notes.find((n) => n.name === "keep.md")?.content)).toContain("- [x] task");
});

test("a shared link that clashes offers Keep both or Replace mine", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => createNote("same.md", "mine"));
  await page.keyboard.press("Escape");
  await page.goto(await shareLinkTo(page, "same.md", "theirs"));
  await expect(page.locator("#banner")).toContainText("You have a different same.md");
  await page.click('#banner button:has-text("Keep both")');
  expect(await names(page)).toEqual(expect.arrayContaining(["same.md", "same1.md"]));

  await page.goto(await shareLinkTo(page, "same.md", "theirs again"));
  await page.click('#banner button:has-text("Replace mine")');
  expect(await page.evaluate(() => state.notes.find((n) => n.name === "same.md").content)).toBe("theirs again");
  await page.click("#mdToast .toast-act");
  expect(await page.evaluate(() => state.notes.find((n) => n.name === "same.md").content)).toBe("mine");
});

test("leaving a zen link shows it under the banner instead of saving it", async ({ page }) => {
  await openApp(page);
  await page.goto(await shareLinkTo(page, "zen.md", "# Zen", "zen"));
  await page.waitForFunction(() => zenModeActive);
  await expect(page.locator("#zenSave")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#banner")).toContainText("Shared with you");
  expect(await names(page)).not.toContain("zen.md");
});

test("import: the file picker and one dialog for every clash", async ({ page }) => {
  await openApp(page);
  await page.evaluate(async () => {
    await createNote("a.md", "old a");
    await createNote("b.md", "old b");
  });
  await page.keyboard.press("Escape");
  const chooser = page.waitForEvent("filechooser");
  await page.click("#btnAppMenu");
  await page.click('#appMenu [data-action="import"]');
  await (await chooser).setFiles([
    { name: "a.md", mimeType: "text/markdown", buffer: Buffer.from("new a") },
    { name: "b.md", mimeType: "text/markdown", buffer: Buffer.from("new b") },
    { name: "c.md", mimeType: "text/markdown", buffer: Buffer.from("new c") },
    { name: "pic.png", mimeType: "image/png", buffer: Buffer.from([0x89, 0x50]) },
  ]);
  const dialog = page.locator("#dialogOverlay .dialog");
  await expect(dialog.locator("h2")).toHaveText("Import 3 notes");
  await expect(dialog).toContainText("Skipped: not a text file");
  await dialog.locator('[data-row="0"][data-choice="replace"]').click();
  await expect(dialog.locator("[data-dlg=ok]")).toHaveText("Import 3");
  await dialog.locator('[data-row="1"][data-choice="skip"]').click();
  await expect(dialog.locator("[data-dlg=ok]")).toHaveText("Import 2");
  await dialog.locator("[data-dlg=ok]").click();
  const notes = await page.evaluate(() => Object.fromEntries(state.notes.map((n) => [n.name, n.content])));
  expect(notes["a.md"]).toBe("new a");
  expect(notes["b.md"]).toBe("old b");
  expect(notes["c.md"]).toBe("new c");
  expect(notes["b1.md"]).toBeUndefined();
  await expect(page.locator("#mdToast")).toHaveText("Imported 2 notes");
});

test("import: same for all, and cancel changes nothing", async ({ page }) => {
  await openApp(page);
  await page.evaluate(async () => {
    await createNote("x.md", "1");
    await createNote("y.md", "2");
  });
  await page.keyboard.press("Escape");
  const files = () =>
    page.evaluate(() =>
      importFiles([new File(["X"], "x.md", { type: "text/markdown" }), new File(["Y"], "y.md", { type: "text/markdown" })]),
    );
  files();
  const dialog = page.locator("#dialogOverlay .dialog");
  await expect(dialog.locator("[data-dlg=ok]")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(await names(page)).not.toContain("x1.md");

  files();
  await expect(dialog.locator("[data-dlg=ok]")).toBeFocused();
  await dialog.locator("label.same").click();
  await dialog.locator('[data-row="0"][data-choice="keep"]').click();
  await expect(dialog.locator('[data-row="1"][data-choice="keep"]')).toHaveAttribute("aria-pressed", "true");
  await dialog.locator("[data-dlg=ok]").click();
  expect(await names(page)).toEqual(expect.arrayContaining(["x1.md", "y1.md"]));
});

test("settings: theme cards, match system, format on save", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await openApp(page);
  await page.click("#btnAppMenu");
  await page.click('#appMenu [data-action="settings"]');
  const dlg = page.locator("#dialogOverlay .settings");
  await dlg.locator('.theme-card[data-value="frappe"]').click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "frappe");
  await dlg.locator('[data-set="system"]').click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "latte");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "frappe");
  await expect(dlg.locator("#set-editor")).toBeHidden();
  await dlg.locator('.set-nav-item[data-section="editor"]').click();
  await expect(dlg.locator("#set-appearance")).toBeHidden();
  await dlg.locator('[data-set="format"]').click();
  await expect(dlg.locator('[data-set="format"] .switch')).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);

  await page.evaluate(() => createNote("f.md", "#   Title"));
  await page.keyboard.press("Escape");
  await page.locator("#editor").focus();
  await page.keyboard.press("Control+s");
  expect(await page.evaluate(() => editor.value)).toBe("#   Title");
});

test("a Drive conflict copy carries a badge and a banner that resolves it", async ({ page }) => {
  await openApp(page);
  await page.evaluate(async () => {
    await createNote("plan.md", "mine");
    await createNote("plan (conflict).md", "theirs");
  });
  await page.keyboard.press("Escape");
  await expect(page.locator('.note-item:has-text("plan (conflict)") .badge')).toHaveText("Conflict");
  await expect(page.locator("#banner")).toContainText("Edited on two devices");
  await page.click('#banner button:has-text("Use this one")');
  expect(await names(page)).not.toContain("plan (conflict).md");
  expect(await page.evaluate(() => [getActiveNote().name, getActiveNote().content])).toEqual(["plan.md", "theirs"]);
});

test("settings on a phone: one sheet with every section", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 760 });
  await openApp(page);
  await page.evaluate(() => openSettings("sync"));
  const dlg = page.locator("#dialogOverlay .settings");
  await expect(dlg.locator(".set-nav")).toBeHidden();
  for (const id of ["appearance", "editor", "sync", "storage"])
    await expect(dlg.locator("#set-" + id)).toBeVisible();
  const box = await dlg.boundingBox();
  expect([box.x, box.width]).toEqual([0, 390]);
  await dlg.locator(".set-close").click();
  await expect(dlg).toHaveCount(0);
});

test("tooltips: icon buttons name themselves and their key", async ({ page }) => {
  await openApp(page);
  await page.hover("#btnNoteMenu");
  await expect(page.locator("#tip")).toHaveText("Note actions", { timeout: 2000 });
  await page.hover("#mdTabZen");
  await expect(page.locator("#tip")).toContainText("Read without the app around it");
  await page.mouse.move(600, 500);
  await expect(page.locator("#tip")).toBeHidden();
});

test("shortcuts show the platform's keys", async ({ page }) => {
  await openApp(page);
  const mac = await page.evaluate(() => IS_MAC);
  await expect(page.locator(".side-search .kbd")).toHaveText(mac ? "⌘P" : "Ctrl+P");
});

test("share explains a note too large for a link instead of hiding", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => {
    let s = "";
    for (let i = 0; s.length < 300000; i++) s += Math.random().toString(36);
    return createNote("big.txt", s);
  });
  await page.keyboard.press("Escape");
  await page.click("#btnShare");
  await expect(page.locator("#sharePop")).toContainText("too large for a link");
  await expect(page.locator('#sharePop [data-share="download"]')).toBeVisible();
});

test("selecting a task's text in the preview doesn't tick it; clicking does", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => {
    createNote("t.md", "- [ ] select this text");
    switchMdTab("view");
  });
  const li = page.locator("#mdPreview li.task-item");
  const b = await li.boundingBox();
  await page.mouse.move(b.x + 30, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 120, b.y + b.height / 2, { steps: 5 });
  await page.mouse.up();
  const content = () => page.evaluate(() => getActiveNote().content);
  expect(await content()).toBe("- [ ] select this text");
  await page.mouse.click(b.x + 60, b.y + b.height / 2);
  expect(await content()).toBe("- [x] select this text");
});
