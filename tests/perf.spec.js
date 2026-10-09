const { test, expect, openApp } = require("./fixtures");

test("typed text is visible immediately (no debounce)", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => createNote("t.js", "const a = 1;\nlet b;"));
  await page.locator("#editor").focus();
  await page.keyboard.press("End");
  // Same task as the keystroke: no timer may stand between input and paint
  const shown = await page.evaluate(() => {
    editor.setRangeText("Z", editor.selectionStart, editor.selectionEnd, "end");
    editor.dispatchEvent(new Event("input"));
    return highlightLayer.textContent;
  });
  expect(shown).toContain("Z");
});

test("highlight layer stays in sync line by line", async ({ page }) => {
  await openApp(page);
  const ok = await page.evaluate(async () => {
    await createNote("sync.js", "a\n/* x */\nb");
    const edits = [
      [0, 0, "/* open\n"], // turns following lines into a comment
      [2, 2, "\n\n"],
      [0, 8, ""],
      [3, 3, "line\nline"],
    ];
    for (const [s, e, t] of edits) {
      editor.setRangeText(t, s, e, "end");
      editor.dispatchEvent(new Event("input"));
      const fresh = highlightLines(editor.value, "sync.js")
        .map((l) => '<div class="hl-line">' + l + "\n</div>")
        .join("");
      if (highlightLayer.innerHTML !== fresh) return false;
    }
    return true;
  });
  expect(ok).toBe(true);
});

test("no highlighter rule is slow on pathological input", async ({ page }) => {
  await openApp(page);
  const slow = await page.evaluate(() => {
    const exts = [...Object.keys(langRules), "html"];
    const units = ["a", "a-", "a:", "[", "[a", "*", "**a", "/", "/a", '"', "'", "`", "<",
      "<a", "#", "$", "${", " ", "0", "0.", "a(", " (", "_", "-", "=", "a=", "\\", "/*",
      "<!--", "```", "@", ".", ".a", "|", "1e"];
    const out = [];
    for (const ext of exts)
      for (const u of units) {
        const code = u.repeat(Math.ceil(40000 / u.length));
        const s = performance.now();
        highlightLines(code, "x." + ext);
        const ms = performance.now() - s;
        if (ms > 100) out.push(`${ext} ${JSON.stringify(u)} ${Math.round(ms)}ms`);
      }
    return out;
  });
  expect(slow).toEqual([]);
});

test("wrap mode: gutter rows match rendered line heights", async ({ page }) => {
  await openApp(page);
  const heights = await page.evaluate(async () => {
    await createNote("wrap.txt", "short\n" + "long ".repeat(200) + "\n\nend");
    if (!editorArea.classList.contains("wrap")) toggleWrap();
    updateLineNumbers();
    return [
      Array.from(gutter.children, (g) => g.offsetHeight),
      Array.from(highlightLayer.children, (r) => r.offsetHeight),
    ];
  });
  expect(heights[0]).toEqual(heights[1]);
  expect(heights[1][1]).toBeGreaterThan(heights[1][0]); // long line wraps
});

test("wrap mode: vim block cursor follows wrapped rows", async ({ page }) => {
  await openApp(page);
  const tops = await page.evaluate(async () => {
    await createNote("wrapvim.txt", "word ".repeat(200));
    if (!editorArea.classList.contains("wrap")) toggleWrap();
    vimState.enabled = true;
    vimSetMode("normal");
    const top = (pos) => {
      vimSetCursor(pos);
      vimUpdateBlockCursor();
      return parseFloat(vimCursorEl.style.top) + editor.scrollTop;
    };
    return [top(0), top(500), top(999)];
  });
  expect(tops[1]).toBeGreaterThan(tops[0]);
  expect(tops[2]).toBeGreaterThan(tops[1]);
});

test("occurrence highlights are limited to visible rows", async ({ page }) => {
  await openApp(page);
  const counts = await page.evaluate(async () => {
    await createNote("occ.txt", Array.from({ length: 3000 }, (_, i) => "foo " + i).join("\n"));
    editor.setSelectionRange(0, 3);
    updateOccurrenceMarkers(true);
    return [occurrenceOverlay.children.length, occurrenceTrack.children.length];
  });
  expect(counts[0]).toBeGreaterThan(0);
  expect(counts[0]).toBeLessThan(200); // not all 3000
  expect(counts[1]).toBeLessThanOrEqual(await page.evaluate(() => occurrenceTrack.clientHeight + 1));
});

test("undo history is capped by size", async ({ page }) => {
  await openApp(page);
  const r = await page.evaluate(async () => {
    const note = await createNote("big.txt", "");
    const big = "x".repeat(1e6);
    for (let i = 0; i < 50; i++) pushHistory(note.id, big + i);
    const h = getHistory(note.id);
    return [h.past.length, h.past.reduce((n, e) => n + e.content.length, 0)];
  });
  expect(r[0]).toBeGreaterThanOrEqual(10);
  expect(r[1]).toBeLessThanOrEqual(11e6);
});
