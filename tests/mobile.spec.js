// Phone-sized touch device. A focused editor stands for an open keyboard:
// headless browsers have no keyboard, but losing focus is what closes it.
const { test, expect, openApp } = require("./fixtures");
const { fakeGoogle, connectedSession } = require("./fake-google");

test.use({ viewport: { width: 390, height: 760 }, hasTouch: true, isMobile: true });

const editorFocused = (page) => page.evaluate(() => document.activeElement === editor);
const wrapped = (page) => page.evaluate(() => editorArea.classList.contains("wrap"));

// .txt: markdown notes open in view mode on phones, without wrap or editor
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
  await page.tap("#btnWrap");
  expect(await wrapped(page)).toBe(!before);
  expect(await editorFocused(page)).toBe(true);
});

test("tapping wrap leaves a closed keyboard closed", async ({ page }) => {
  await editingNote(page);
  await page.evaluate(() => editor.blur());
  const before = await wrapped(page);
  await page.tap("#btnWrap");
  expect(await wrapped(page)).toBe(!before);
  expect(await editorFocused(page)).toBe(false);
});

test("tapping sync opens its menu without touching the keyboard", async ({ page, context }) => {
  await fakeGoogle(context);
  await connectedSession(context);
  await editingNote(page);
  await page.evaluate(() => editor.focus());
  await page.tap(".statusbar #syncMenuContainer > button");
  await expect(page.locator("#syncMenu")).toHaveClass(/visible/);
  expect(await editorFocused(page)).toBe(true);
});

test("opening the notes list closes the keyboard", async ({ page }) => {
  await editingNote(page);
  await page.evaluate(() => editor.focus());
  await page.tap("#btnFiles");
  await expect(page.locator(".sidebar")).toHaveClass(/open/);
  expect(await editorFocused(page)).toBe(false);
});
