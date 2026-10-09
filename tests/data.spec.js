const { test, expect, openApp } = require("./fixtures");

const stored = (page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("notepad_data")));

test("edits in a tab that lost Drive leadership are still saved", async ({
  page,
  context,
}) => {
  await openApp(page);
  await page.evaluate(() => createNote("tabs.md", "start"));
  const other = await context.newPage();
  await openApp(other); // newer tab claims leadership
  await page.bringToFront();
  await page.locator("#editor").focus();
  await page.evaluate(() => {
    editor.selectionStart = editor.selectionEnd = editor.value.length;
  });
  await page.keyboard.type(" typed");
  await expect
    .poll(async () => (await stored(other)).notes.find((n) => n.name === "tabs.md")?.content)
    .toBe("start typed");
});

test("creates and deletes from other tabs are merged, not overwritten", async ({
  page,
  context,
}) => {
  await openApp(page);
  await page.evaluate(() => createNote("doomed.md", ""));
  const other = await context.newPage();
  await openApp(other);
  await other.evaluate(async () => {
    await createNote("fromB.md", "b");
    await confirmDelete(state.notes.find((n) => n.name === "doomed.md").id);
  });
  await page.evaluate(() => createNote("fromA.md", "a"));
  const names = (await stored(page)).notes.map((n) => n.name);
  expect(names).toContain("fromA.md");
  expect(names).toContain("fromB.md");
  expect(names).not.toContain("doomed.md");
  await expect(page.locator(".note-item", { hasText: "fromB.md" })).toHaveCount(1);
});

test("undo/redo survive fast typing and ignore other inputs", async ({
  page,
}) => {
  await openApp(page);
  await page.evaluate(() => createNote("undo.md", "A"));
  await page.locator("#editor").focus();
  await page.evaluate(() => {
    editor.selectionStart = editor.selectionEnd = 1;
  });
  const value = () => page.evaluate(() => editor.value);
  await page.keyboard.type("x");
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(600); // a stale snapshot timer would fire here
  expect(await value()).toBe("A");
  await page.keyboard.press("Control+Shift+Z");
  expect(await value()).toBe("Ax");
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+y");
  expect(await value()).toBe("Ax");

  await page.click("#btnReplace");
  await page.locator("#findInput").fill("q");
  await page.keyboard.press("Control+z");
  expect(await page.evaluate(() => getActiveNote().content)).toBe("Ax");
});

test("swap file older than the note is discarded", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => createNote("swap.md", "current"));
  const [value, swap] = await page.evaluate(() => {
    const n = getActiveNote();
    const key = "notepad_swap_" + n.id;
    localStorage.setItem(key, JSON.stringify({ content: "old", timestamp: n.updatedAt - 1000 }));
    renderEditor();
    return [editor.value, localStorage.getItem(key)];
  });
  expect(value).toBe("current");
  expect(swap).toBeNull();
});

test("help never overwrites a user's note and reuses its own copy", async ({
  page,
}) => {
  await openApp(page); // first visit created an untouched help.md
  await page.evaluate(() => createNote("help.md", "MY OWN NOTES"));
  await page.evaluate(() => openHelp());
  await page.evaluate(() => openHelp());
  const notes = await page.evaluate(() =>
    state.notes.map((n) => [n.name, n.content === HELP_DESKTOP]),
  );
  expect(notes.filter(([name]) => name.startsWith("help"))).toHaveLength(2);
  expect(await page.evaluate(() => getActiveNote().content === HELP_DESKTOP)).toBe(true);
  expect(
    await page.evaluate(() => state.notes.some((n) => n.content === "MY OWN NOTES")),
  ).toBe(true);

  // An edited copy is left alone too
  await page.evaluate(() => {
    getActiveNote().content += "\nmy edit";
  });
  await page.evaluate(() => openHelp());
  expect(
    await page.evaluate(() => state.notes.some((n) => n.content.endsWith("my edit"))),
  ).toBe(true);
});

test("zip import never reuses an id that is taken", async ({ page }) => {
  await openApp(page);
  const unique = await page.evaluate(async () => {
    const victim = await createNote("renamed-after-export.md", "x");
    const zip = await buildZip([
      { name: "original.md", content: "zip" },
      {
        name: ".note.directory",
        content: JSON.stringify({ notes: [{ id: victim.id, name: "original.md", updatedAt: 1 }] }),
      },
    ]);
    await importZip(new File([zip], "x.zip"));
    const ids = state.notes.map((n) => n.id);
    return ids.length === new Set(ids).size;
  });
  expect(unique).toBe(true);
});

test("findTasks matches the rendered checkboxes", async ({ page }) => {
  await openApp(page);
  const mismatches = await page.evaluate(() => {
    const frags = ["- [ ] a", "- [x] b", "  - [ ] c", "1. [ ] e", "* [ ] g", "-  [ ] two",
      "- [ ]", "- [X] up", "> - [ ] q", "```", "```js", "````", "text", "", "# - [ ] h",
      "| - [ ] | x |", "- plain", "  more", "- \\[ ] esc", "<details>", "- [x]trail"];
    const bad = [];
    for (let r = 0; r < 20000; r++) {
      const doc = Array.from({ length: 1 + Math.floor(Math.random() * 12) },
        () => frags[Math.floor(Math.random() * frags.length)]).join("\n");
      const boxes = [...renderMarkdown(doc).matchAll(/<input type="checkbox"( checked)?/g)].map((m) => !!m[1]);
      const tasks = findTasks(doc).map((t) => t.checked);
      if (JSON.stringify(boxes) !== JSON.stringify(tasks)) bad.push(doc);
    }
    return bad.slice(0, 3);
  });
  expect(mismatches).toEqual([]);
});

test("each checkbox toggles its own source line", async ({ page }) => {
  await openApp(page);
  const doc = ["- [ ] one", "1. [ ] two", "```", "- [ ] in code", "```",
    "> - [ ] q1", "> - [ ] q2", "- [ ] three"].join("\n");
  await page.evaluate(async (doc) => {
    await createNote("tasks.md", doc);
    switchMdTab("view");
  }, doc);
  const content = () => page.evaluate(() => getActiveNote().content.split("\n"));
  const flipped = [];
  for (let i = 0; i < 4; i++) {
    const before = await content();
    await page.locator("#mdPreview input[type=checkbox]").nth(i).click();
    const after = await content();
    flipped.push(before.findIndex((l, j) => l !== after[j]));
  }
  expect(flipped).toEqual([0, 1, 6, 7]);
});

test("replace all keeps offsets with length-changing case folding", async ({
  page,
}) => {
  await openApp(page);
  await page.evaluate(() => createNote("find.txt", "İ foo"));
  await page.click("#btnReplace");
  await page.locator("#findInput").fill("foo");
  await page.locator("#replaceInput").fill("bar");
  await page.click("[data-action=replace-all]");
  expect(await page.evaluate(() => editor.value)).toBe("İ bar");
});

test("replace after editing hits the selected match", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => createNote("find.txt", "foo foo"));
  await page.click("#btnReplace");
  await page.locator("#findInput").fill("foo");
  await page.locator("#editor").focus();
  await page.evaluate(() => {
    editor.selectionStart = editor.selectionEnd = 0;
  });
  await page.keyboard.type("XX");
  await page.locator("#replaceInput").fill("bar");
  await page.click("[data-action=replace-current]"); // selects
  await page.click("[data-action=replace-current]"); // replaces
  expect(await page.evaluate(() => editor.value)).toBe("XXbar foo");
});

test("rename without a change keeps updatedAt", async ({ page }) => {
  await openApp(page);
  const unchanged = await page.evaluate(async () => {
    const n = getActiveNote();
    const t = n.updatedAt;
    await new Promise((r) => setTimeout(r, 20));
    startRename(n.id);
    document.activeElement.blur();
    return n.updatedAt === t;
  });
  expect(unchanged).toBe(true);
});
