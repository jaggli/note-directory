const { test, expect, openApp } = require("./fixtures");

test("no browser autocomplete in text fields", async ({ page }) => {
  await openApp(page);
  const off = await page.evaluate(() =>
    [...document.querySelectorAll('input:not([type=checkbox])')].map((i) => i.autocomplete),
  );
  expect(off.length).toBeGreaterThan(4);
  expect(new Set(off)).toEqual(new Set(["off"]));
});

test("llms.txt describes links and the drawing format", async ({ page }) => {
  const res = await page.request.get("/llms.txt");
  expect(res.ok()).toBe(true);
  const text = await res.text();
  expect(text).toMatch(/^# note\.directory/);
  expect(text).toContain("#name=<filename>&note=<content>");
  expect(text).toContain("| `a`  | arrow");
});

test("search: ctrl+f this note line by line, ctrl+p all notes", async ({ page }) => {
  await openApp(page);
  await page.evaluate(async () => {
    await createNote("other.md", "apple elsewhere\n");
    await createNote("here.md", "one apple\ntwo\nthree apple apple\n");
  });
  await page.locator("#editor").focus();
  await page.keyboard.press("Control+f");
  await expect(page.locator("#searchAll")).not.toBeChecked();
  await page.keyboard.type("apple");
  await expect(page.locator(".search-result-line")).toHaveCount(2);
  await expect(page.locator("#searchCount")).toHaveText("2 lines");
  expect(await page.locator(".search-result-line mark").count()).toBe(3);
  // Switch scope from inside the dialog, both ways
  await page.keyboard.press("Control+p");
  await expect(page.locator("#searchAll")).toBeChecked();
  await expect(page.locator(".search-result-item", { hasText: "other.md" })).toHaveCount(1);
  await page.click("#searchAll");
  await expect(page.locator(".search-result-line")).toHaveCount(2);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.locator("#searchResults")).toBeHidden();
  const line = await page.evaluate(() => editor.value.slice(0, editor.selectionStart).split("\n").length);
  expect(line).toBe(3);
});

test("search in a drawing selects the shape", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => createNote("s.draw", 'draw 1\nr a 0 0 10 10 "first"\nr b 900 900 10 10 "target"\n'));
  await page.waitForFunction(() => window.Draw?.isMounted());
  await page.keyboard.press("Control+f");
  await page.keyboard.type("target");
  await expect(page.locator(".search-result-line")).toHaveCount(1);
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => [...Draw._state.sel])).toEqual(["b"]);
});

test("tabs are centred on desktop, right on mobile", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => createNote("c.md", "# c"));
  const offset = () =>
    page.evaluate(() => {
      const bar = document.getElementById("mdTabBar").getBoundingClientRect();
      const tabs = document.getElementById("mdTabs").getBoundingClientRect();
      return [tabs.left + tabs.width / 2 - (bar.left + bar.width / 2), bar.right - tabs.right];
    });
  expect(Math.abs((await offset())[0])).toBeLessThan(2);
  await page.setViewportSize({ width: 400, height: 800 });
  expect((await offset())[1]).toBeLessThan(10);
});

test("html export looks like zen and runs nothing", async ({ page }) => {
  await openApp(page);
  const html = await page.evaluate(async () => {
    await createNote("pic.draw", "draw 1\nr a 0 0 40 20\n");
    await createNote(
      "doc.md",
      "# Title\n\n- [x] done\n\n[other](pic.draw) [web](https://example.com)\n\n![p](pic.draw)\n\n```js\nlet a = 1;\n```\n",
    );
    let out;
    const orig = triggerDownload;
    triggerDownload = (blob, name) => (out = [blob, name]);
    switchMdTab("zen");
    await zenDownload();
    triggerDownload = orig;
    return [await out[0].text(), out[1]];
  });
  const [text, name] = html;
  expect(name).toBe("doc.html");
  expect(text).toContain("Content-Security-Policy");
  expect(text).not.toContain("<script");
  expect(text).toContain('<h1 id="title"');
  expect(text).toContain("<svg");
  expect(text).toContain('href="https://example.com"');
  expect(text).not.toContain('href="pic.draw"');
  expect(text).not.toContain("code-copy-btn\">copy");
  expect(text).not.toMatch(/<input[^>]*disabled/);
  expect(text).toContain(":has(> input:checked)");
  expect(text).toMatch(/<input[^>]*id="task-0"[^>]*><label for="task-0">done<\/label>/);
  expect(text).toContain(".hl-kw");
});

test("file menu: download as html only for markdown", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => createNote("a.md", "# a"));
  await page.click("#fileMenuContainer > button");
  await expect(page.locator('[data-action="download-html"]')).toBeVisible();
  await expect(page.locator('[data-action="download"]')).toHaveText("download file");
  await page.keyboard.press("Escape");
  await page.evaluate(() => createNote("a.txt", "x"));
  await page.click("#fileMenuContainer > button");
  await expect(page.locator('[data-action="download-html"]')).toBeHidden();
});

test("text, txt and plain code blocks have no line numbers", async ({ page }) => {
  await openApp(page);
  await page.evaluate(async () => {
    await createNote("p.md", "```text\na\n```\n\n```txt\nb\n```\n\n```plain\nc\n```\n\n```js\nd\n```\n");
    switchMdTab("view");
  });
  const numbers = await page.evaluate(() =>
    [...mdPreview.querySelectorAll(".code-line")].map((l) => getComputedStyle(l, "::before").content),
  );
  expect(numbers).toEqual(["none", "none", "none", "counter(code-ln)"]);
});

test("enter continues markdown lists", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => createNote("l.md", ""));
  const type = async (start, keys) => {
    await page.evaluate((v) => {
      editor.value = v;
      editor.dispatchEvent(new Event("input"));
      editor.selectionStart = editor.selectionEnd = v.length;
    }, start);
    await page.locator("#editor").focus();
    for (const k of keys) k.length > 1 ? await page.keyboard.press(k) : await page.keyboard.type(k);
    return page.evaluate(() => editor.value);
  };
  expect(await type("- a", ["Enter", "b"])).toBe("- a\n- b");
  expect(await type("  * a", ["Enter"])).toBe("  * a\n  * ");
  expect(await type("+ a", ["Enter"])).toBe("+ a\n+ ");
  expect(await type("9. a", ["Enter"])).toBe("9. a\n10. ");
  expect(await type("1) a", ["Enter"])).toBe("1) a\n2) ");
  expect(await type("- [x] done", ["Enter"])).toBe("- [x] done\n- [ ] ");
  expect(await type("- [] todo", ["Enter"])).toBe("- [] todo\n- [ ] ");
  // Enter on an empty item ends the list
  expect(await type("- a\n- ", ["Enter", "x"])).toBe("- a\nx");
  // Shift+Enter and code fences stay plain
  expect(await type("- a", ["Shift+Enter"])).toBe("- a\n");
  expect(await type("```yaml\n- a", ["Enter"])).toBe("```yaml\n- a\n");
  // Only markdown
  await page.evaluate(() => createNote("l.txt", ""));
  expect(await type("- a", ["Enter"])).toBe("- a\n");
});

test("plain text= links open, even with & and # inside", async ({ page }) => {
  const text = 'draw 1\nr a 0 0 200 80 "Q&A #1 &name=evil.md"\n';
  // Lazy encoding as an LLM might write it: & and # left as they are
  const lazy = text.replace(/ /g, "%20").replace(/\n/g, "%0A").replace(/"/g, "%22");
  await page.goto("/?view=draw#name=plain.draw&text=" + lazy);
  await page.waitForFunction(() => window.Draw?.isMounted());
  expect(await page.evaluate(() => [getActiveNote().name, getActiveNote().content])).toEqual(["plain.draw", text]);
  await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/^#name=plain\.draw&note=/);
  expect(await page.evaluate(() => location.hash)).not.toContain("text=");
});

test("plain text= zen links stay ephemeral", async ({ page }) => {
  await page.goto("/?view=zen#name=z.md&text=" + encodeURIComponent("# Hello\n\nworld"));
  await page.waitForFunction(() => zenModeActive);
  await expect(page.locator("#mdPreview h1")).toHaveText("Hello");
  expect(await page.evaluate(() => state.notes.some((n) => n.name === "z.md"))).toBe(false);
  expect(await page.evaluate(() => location.search)).toBe("?view=zen");
});

test("theme: picked from the submenu, persists, repaints drawings", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => createNote("pic.draw", "draw 1\nr a 0 0 40 20 c=red\n"));
  await page.click("#fileMenuContainer > button");
  await page.hover("[data-action=toggle-theme-menu]");
  await expect(page.locator("[data-value=mocha]")).toHaveAttribute("aria-checked", "true");
  await page.click("[data-value=latte]");
  await expect(page.locator("#fileMenu")).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "latte");
  const svg = await page.evaluate(async () => (await loadDraw(), Draw.svgString("draw 1\nr a 0 0 40 20 c=red\n")));
  expect(svg).toContain("#d20f39");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "latte");
});
