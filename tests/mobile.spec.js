// Phone-sized touch device. A focused editor stands for an open keyboard:
// headless browsers have no keyboard, but losing focus is what closes it.
const { test, expect, openApp } = require("./fixtures");
const { fakeGoogle, connectedSession } = require("./fake-google");

test.use({ viewport: { width: 390, height: 760 }, hasTouch: true, isMobile: true });

const editorFocused = (page) => page.evaluate(() => document.activeElement === editor);
const wrapped = (page) => page.evaluate(() => editorArea.classList.contains("wrap"));

// .txt: markdown notes open in view mode on phones, without wrap or editor.
// Phones reach wrap from the note's actions sheet (no status bar)
async function editingNote(page) {
  await openApp(page);
  await page.evaluate(() => {
    const note = { id: "m", name: "a.txt", content: "text", updatedAt: Date.now() };
    state.notes.push(note);
    switchNote(note.id);
  });
}

test("tapping wrap keeps an open keyboard open and toggles wrap", async ({ page }) => {
  await editingNote(page);
  await page.evaluate(() => editor.focus());
  const before = await wrapped(page);
  await page.tap("#btnNoteMenu");
  await page.tap('#noteMenu [data-note-act="wrap"]');
  expect(await wrapped(page)).toBe(!before);
});

test("tapping wrap leaves a closed keyboard closed", async ({ page }) => {
  await editingNote(page);
  await page.evaluate(() => editor.blur());
  const before = await wrapped(page);
  await page.tap("#btnNoteMenu");
  await page.tap('#noteMenu [data-note-act="wrap"]');
  expect(await wrapped(page)).toBe(!before);
  expect(await editorFocused(page)).toBe(false);
});

test("sync lives in the notes list, its menu opens as a sheet", async ({ page, context }) => {
  await fakeGoogle(context);
  await connectedSession(context);
  await editingNote(page);
  await page.tap("#btnSidebar");
  await page.tap("#syncMenuContainer > button");
  await expect(page.locator("#syncMenu")).toHaveClass(/visible/);
  const box = await page.locator("#syncMenu").boundingBox();
  expect(Math.round(box.y + box.height)).toBe(760);
});

test("the key bar shows over the keyboard and indents", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => {
    const note = { id: "k", name: "k.md", content: "- a", updatedAt: Date.now() };
    state.notes.push(note);
    switchNote(note.id);
    switchMdTab("edit");
    editor.focus();
    editor.setSelectionRange(0, 0);
  });
  await expect(page.locator("#keybar")).toBeVisible();
  await page.tap('#keybar [data-key-action="indent"]');
  expect(await page.evaluate(() => editor.value)).toBe("  - a");
  expect(await editorFocused(page)).toBe(true);
  await page.evaluate(() => editor.blur());
  await expect(page.locator("#keybar")).toBeHidden();
});

test("holding a note opens its actions", async ({ page }) => {
  await openApp(page);
  await page.tap("#btnSidebar");
  const row = page.locator(".note-item").first();
  const box = await row.boundingBox();
  await page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x, y);
    const t = new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
    el.dispatchEvent(new TouchEvent("touchstart", { touches: [t], bubbles: true }));
  }, [box.x + 40, box.y + box.height / 2]);
  await expect(page.locator("#noteMenu")).toHaveClass(/visible/);
});

test("opening the notes list closes the keyboard", async ({ page }) => {
  await editingNote(page);
  await page.evaluate(() => editor.focus());
  await page.tap("#btnSidebar");
  await expect(page.locator(".sidebar")).toHaveClass(/open/);
  expect(await editorFocused(page)).toBe(false);
});

test("one view button instead of tabs; its icon shows the view", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => {
    const note = { id: "v", name: "v.md", content: "# hi", updatedAt: Date.now() };
    state.notes.push(note);
    switchNote(note.id);
  });
  const toggle = page.locator("#mdTabToggle");
  const icon = () => toggle.locator("use").getAttribute("href");
  await expect(page.locator("#mdTabs")).toBeHidden();
  await expect(toggle).toBeVisible();
  await expect.poll(icon).toBe("#i-eye");
  await page.tap("#mdTabToggle");
  await expect.poll(icon).toBe("#i-code");
  await expect(page.locator("#editor")).toBeVisible();
  await page.tap("#mdTabToggle");
  await expect.poll(icon).toBe("#i-eye");

  // Same height as the buttons beside it
  await page.evaluate(() => renameInTitle());
  const h = (sel) => page.locator(sel).evaluate((el) => el.getBoundingClientRect().height);
  expect(await h("#crumbInput")).toBe(await h("#btnNoteMenu"));
});

test("a plain text note has no view button", async ({ page }) => {
  await editingNote(page);
  await expect(page.locator("#mdTabToggle")).toBeHidden();
});
