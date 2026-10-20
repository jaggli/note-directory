const { test, expect, openApp } = require("./fixtures");

// Opens `content` as a drawing on the canvas
async function openDrawing(page, content = "", name = "t.draw") {
  await openApp(page);
  await page.evaluate(([n, c]) => createNote(n, c), [name, content]);
  await page.waitForFunction(() => window.Draw?.isMounted());
}

const content = (page) => page.evaluate(() => getActiveNote().content);
const shapes = (page) =>
  page.evaluate(() => Draw.parse(getActiveNote().content).shapes.filter((s) => s.k !== "raw"));

// World coordinates → page coordinates
async function at(page, x, y) {
  return page.evaluate(
    ([x, y]) => {
      const r = document.getElementById("drawHost").getBoundingClientRect();
      const c = Draw._state.cam;
      return [r.left + (x - c.x) * c.z, r.top + (y - c.y) * c.z];
    },
    [x, y],
  );
}

async function drag(page, from, to) {
  const a = await at(page, ...from);
  const b = await at(page, ...to);
  await page.mouse.move(...a);
  await page.mouse.down();
  await page.mouse.move(...b, { steps: 6 });
  await page.mouse.up();
}

async function click(page, x, y) {
  await page.mouse.click(...(await at(page, x, y)));
}

test("format: parse and serialize round-trip", async ({ page }) => {
  await openApp(page);
  const src = [
    "draw 1",
    "grid on",
    "# a comment",
    'r a1 0 0 100 50 c=blue f=semi d=dash ta=left va=top st=bu rot=15 gr=g1 "say \\"hi\\"\\nthere"',
    "e a2 200 0 80 80 s=xl",
    "m a3 0 200 80 60 f=solid",
    't a4 10 300 c=yellow st=i "note"',
    "l a5 0,0 50,20 80,0 d=dot",
    'a a6 a1 a2 hs=dot he=triangle st=b bend=-30 "calls"',
    "a a7 10,10 a3",
    "p a8 c=mauve rot=30 10,20 3,4 -2,5",
    "p a9 0,0,5 2,2,6 2,2,9",
    "h a10 s=l 0,0 10,0",
    "",
  ].join("\n");
  const out = await page.evaluate(async (src) => {
    await loadDraw();
    const m = Draw.parse(src);
    return { errors: m.errors, text: Draw.serialize(m), label: m.byId.get("a1").label };
  }, src);
  expect(out.errors).toEqual([]);
  expect(out.text).toBe(src);
  expect(out.label).toBe('say "hi"\nthere');
});

test("format: bad lines are kept and reported, not dropped", async ({ page }) => {
  await openApp(page);
  const out = await page.evaluate(async () => {
    await loadDraw();
    const src = "draw 1\nr a 0 0 10 10\nzz what\nr b 0 0 -5 10\na c a nope\nr a 1 1 1 1\n";
    const m = Draw.parse(src);
    return { lines: m.errors.map((e) => e.line), text: Draw.serialize(m) };
  });
  expect(out.lines).toEqual([3, 4, 5, 6]);
  expect(out.text).toBe("draw 1\nr a 0 0 10 10\nzz what\nr b 0 0 -5 10\na c a nope\nr a 1 1 1 1\n");
});

test("format: oversized or newer drawings open read-only", async ({ page }) => {
  await openApp(page);
  const out = await page.evaluate(async () => {
    await loadDraw();
    const huge = "draw 1\np x 0,0 " + "1,1 ".repeat(200001) + "\n";
    return [Draw.parse(huge).locked, Draw.parse("draw 2\nr a 0 0 1 1\n").locked];
  });
  expect(out).toEqual([true, true]);
});

test("the ▾ menu creates a drawing, + still creates text", async ({ page }) => {
  await openApp(page);
  await page.click("#btnNewMenu");
  await page.click('#newMenu [data-action="new-drawing-rename"]');
  await page.waitForFunction(() => window.Draw?.isMounted());
  expect(await page.evaluate(() => getActiveNote().name)).toBe("drawing1.draw");
  await expect(page.locator("#mdTabView")).toHaveText("Canvas");
  await expect(page.locator("#mdTabEdit")).toHaveText("Source");
  await expect(page).toHaveURL(/view=draw/);
  await page.keyboard.press("Escape");
  await page.click('.side-head [data-action="new-note-rename"]');
  expect(await page.evaluate(() => getActiveNote().name)).toMatch(/^note\d+\.md$/);
  expect(await page.evaluate(() => mdViewActive)).toBe(false);
});

test("drawing a shape, undo and redo", async ({ page }) => {
  await openDrawing(page);
  await page.keyboard.press("r");
  await drag(page, [0, 0], [100, 60]);
  let s = await shapes(page);
  expect(s).toHaveLength(1);
  expect(s[0]).toMatchObject({ k: "r", x: 0, y: 0, w: 100, h: 60 });
  await page.keyboard.press("Control+z");
  expect(await content(page)).toBe("");
  await page.keyboard.press("Control+Shift+Z");
  expect(await shapes(page)).toHaveLength(1);
});

test("arrows stay attached when their shapes move", async ({ page }) => {
  await openDrawing(page, "draw 1\nr a 0 0 100 60\nr b 300 0 100 60\na c a b\n");
  await drag(page, [50, 30], [50, 230]);
  const s = await shapes(page);
  expect(s.find((x) => x.id === "a")).toMatchObject({ x: 0, y: 200 });
  expect(s.find((x) => x.id === "c")).toMatchObject({ from: "a", to: "b" });
  // Deleting a bound shape frees the arrow at its current end
  await page.keyboard.press("Delete");
  const arrow = (await shapes(page)).find((x) => x.id === "c");
  expect(Array.isArray(arrow.from)).toBe(true);
  expect(arrow.to).toBe("b");
});

test("drawing an arrow between shapes binds it", async ({ page }) => {
  await openDrawing(page, "draw 1\nr a 0 0 100 60\nr b 300 0 100 60\n");
  await page.keyboard.press("a");
  await drag(page, [50, 30], [350, 30]);
  const arrow = (await shapes(page)).find((x) => x.k === "a");
  expect(arrow).toMatchObject({ from: "a", to: "b" });
});

test("resize and rotate through the handles", async ({ page }) => {
  await openDrawing(page, "draw 1\nr a 0 0 100 100\n");
  await click(page, 50, 50);
  await drag(page, [100, 100], [200, 150]);
  expect((await shapes(page))[0]).toMatchObject({ x: 0, y: 0, w: 200, h: 150 });
  // Rotate handle sits above the top edge; shift snaps to 15°
  const handle = await page.evaluate(() => Draw._state.handles.find((h) => h.kind === "rotate"));
  const r = await page.locator("#drawHost").boundingBox();
  await page.mouse.move(r.x + handle.x, r.y + handle.y);
  await page.mouse.down();
  const c = await at(page, 100, 75);
  await page.keyboard.down("Shift");
  await page.mouse.move(c[0] + 200, c[1] - 1, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  const s = (await shapes(page))[0];
  expect(s.rot).toBe(90);
  expect(s).toMatchObject({ w: 200, h: 150 });
});

test("marquee, group, duplicate and eraser", async ({ page }) => {
  await openDrawing(page, "draw 1\nr a 0 0 50 50\nr b 100 0 50 50\nr c 400 400 50 50\n");
  await drag(page, [-20, -20], [200, 80]);
  expect(await page.evaluate(() => [...Draw._state.sel].sort())).toEqual(["a", "b"]);
  await page.keyboard.press("Control+g");
  const gr = (await shapes(page)).find((s) => s.id === "a").gr;
  expect(gr).toBeTruthy();
  expect((await shapes(page)).find((s) => s.id === "b").gr).toBe(gr);
  // Clicking one member selects the group
  await page.keyboard.press("Escape");
  await click(page, 25, 0);
  expect(await page.evaluate(() => Draw._state.sel.size)).toBe(2);
  await page.keyboard.press("Control+d");
  const all = await shapes(page);
  expect(all).toHaveLength(5);
  const copies = all.slice(3);
  expect(copies[0].gr).toBeTruthy();
  expect(copies[0].gr).not.toBe(gr);
  await page.keyboard.press("e");
  await drag(page, [380, 425], [470, 425]);
  expect((await shapes(page)).map((s) => s.id)).not.toContain("c");
});

test("text: double-click writes, labels go into the file", async ({ page }) => {
  await openDrawing(page, "draw 1\nr a 0 0 160 80\n");
  await page.mouse.dblclick(...(await at(page, 80, 40)));
  await page.keyboard.type("hello");
  await page.keyboard.press("Escape");
  await page.mouse.dblclick(...(await at(page, 0, 300)));
  await page.keyboard.type("free");
  await page.keyboard.press("Escape");
  const s = await shapes(page);
  expect(s[0].label).toBe("hello");
  expect(s[1]).toMatchObject({ k: "t", label: "free" });
});

test("text: outline and box follow the label while typing", async ({ page }) => {
  await openDrawing(page, "draw 1\nr a 0 0 40 40\nt b 0 200 rot=60 \"ab\"\n");
  await page.mouse.dblclick(...(await at(page, 20, 20)));
  await page.keyboard.type("a long label");
  // The box grows before the edit is finished
  expect(await page.evaluate(() => Draw._state.model.byId.get("a").w)).toBeGreaterThan(40);
  await page.keyboard.press("Escape");
  await page.mouse.dblclick(...(await at(page, 10, 210)));
  const outline = () => page.locator(".draw-svg polygon").first().boundingBox();
  const before = await outline();
  // First outline point: the drawn top-left corner, which must stay put
  const corner = () =>
    page.locator(".draw-svg polygon").first().evaluate((p) => p.getAttribute("points").split(" ").slice(0, 2).map(Number));
  const c0 = await corner();
  await page.keyboard.press("End");
  await page.keyboard.type(" and more");
  expect((await outline()).height).toBeGreaterThan(before.height * 2);
  const c1 = await corner();
  expect(Math.hypot(c1[0] - c0[0], c1[1] - c0[1])).toBeLessThan(2);
  await expect(page.locator(".draw-text")).toHaveCSS("transform-origin", /px/);
});

test("grid setting lives in the file", async ({ page }) => {
  await openDrawing(page, "draw 1\nr a 0 0 10 10\n");
  await page.click('[data-draw="nav:grid"]');
  expect(await content(page)).toBe("draw 1\ngrid on\nr a 0 0 10 10\n");
});

test("source edits show on the canvas", async ({ page }) => {
  await openDrawing(page, "draw 1\nr a 0 0 10 10\n");
  await expect(page.locator("#mdTabView")).toHaveAttribute("aria-selected", "true");
  await page.click("#mdTabEdit");
  await page.locator("#editor").focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("bogus line\n");
  await page.click("#mdTabView");
  await page.waitForFunction(() => Draw.isMounted());
  await expect(page.locator(".draw-badge")).toHaveText("1 line can't be drawn · Open source");
  expect(await page.locator("#drawHost [data-id=a]").count()).toBe(1);
});

test("shared drawing link opens read-only in zen", async ({ page }) => {
  await openApp(page);
  const url = await page.evaluate(async () => {
    const note = { name: "shared.draw", content: "draw 1\nr a 0 0 100 50 \"hi\"\n", updatedAt: 1 };
    shareMode = "zen";
    const u = await shareUrlFor(note);
    shareMode = "edit";
    return u;
  });
  expect(url).toContain("?view=zen");
  await page.goto(url);
  await page.waitForFunction(() => window.Draw?.isMounted());
  expect(await page.evaluate(() => Draw._state.readonly)).toBe(true);
  await expect(page.locator(".draw-tools")).toBeHidden();
  await expect(page.locator("#drawHost text")).toHaveText("hi");
  // Nothing was saved: zen links are ephemeral
  expect(await page.evaluate(() => state.notes.some((n) => n.name === "shared.draw"))).toBe(false);
});

test("drawings embed in markdown, inline and by name", async ({ page }) => {
  await openApp(page);
  await page.evaluate(async () => {
    await createNote("my_arch.draw", "draw 1\nr a 0 0 100 50\n");
    await createNote(
      "doc.md",
      "# Doc\n\n![arch](my_arch.draw)\n\n```draw\ndraw 1\ne b 0 0 40 40\n```\n\n![x](missing.draw)\n",
    );
    switchMdTab("view");
  });
  await expect(page.locator("#mdPreview .draw-embed svg")).toHaveCount(2);
  await expect(page.locator("#mdPreview .draw-embed.missing")).toHaveText("drawing not found: missing.draw");
  await page.locator('#mdPreview .draw-embed[data-ref="my_arch.draw"]').click();
  await page.waitForFunction(() => Draw.isMounted());
  expect(await page.evaluate(() => getActiveNote().name)).toBe("my_arch.draw");
});

test("search matches drawing text, not coordinates", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => createNote("s.draw", 'draw 1\nr a 123 456 10 10 "findme"\n'));
  const hits = await page.evaluate(() => {
    searchNotes("findme");
    const a = searchResultsList.textContent.includes("s.draw");
    searchNotes("456");
    return [a, searchResultsList.textContent.includes("s.draw")];
  });
  expect(hits).toEqual([true, false]);
});

test("export all adds svg renders that import skips", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => createNote("pic.draw", "draw 1\nr a 0 0 10 10\n"));
  const names = await page.evaluate(async () => {
    let blob;
    const orig = triggerDownload;
    triggerDownload = (b) => (blob = b);
    await downloadAll();
    triggerDownload = orig;
    const entries = await readZip(await blob.arrayBuffer());
    const before = state.notes.length;
    await importFiles([new File([blob], "notes.zip")]);
    return { names: entries.map((e) => e.name), added: state.notes.length - before };
  });
  expect(names.names).toContain("pic.draw.svg");
  expect(names.names).toContain("pic.draw");
  expect(names.added).toBe(0);
});

test("png and svg export", async ({ page }) => {
  await openApp(page);
  const out = await page.evaluate(async () => {
    await loadDraw();
    const c = 'draw 1\nr a 0 0 100 50 c=red "x"\n';
    const blob = await Draw.pngBlob(c);
    return { type: blob.type, size: blob.size, svg: Draw.svgString(c) };
  });
  expect(out.type).toBe("image/png");
  expect(out.size).toBeGreaterThan(100);
  expect(out.svg).toContain("<rect");
  expect(out.svg).toContain("#f38ba8");
});

test("labels and embeds can't inject markup", async ({ page }) => {
  await openApp(page);
  let dialogs = 0;
  page.on("dialog", (d) => (dialogs++, d.dismiss()));
  await page.evaluate(async () => {
    window.pwned = 0;
    await createNote(
      "x.md",
      '```draw\ndraw 1\nr a 0 0 100 50 "<img src=x onerror=window.pwned=1>"\n```\n\n' +
        '![a" onmouseover="window.pwned=2](x" onerror="window.pwned=3.draw)\n',
    );
    switchMdTab("view");
  });
  await expect(page.locator("#mdPreview .draw-embed svg")).toHaveCount(1);
  expect(await page.locator("#mdPreview img").count()).toBe(0);
  expect(await page.locator("#mdPreview [onmouseover], #mdPreview [onerror]").count()).toBe(0);
  const label = await page.evaluate(() =>
    [...document.querySelectorAll("#mdPreview .draw-embed tspan")].map((t) => t.textContent).join(" "),
  );
  expect(label).toBe("<img src=x onerror=window.pwned=1>");
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.pwned)).toBe(0);
  expect(dialogs).toBe(0);
});

test("only palette colors reach the SVG", async ({ page }) => {
  await openApp(page);
  const out = await page.evaluate(async () => {
    await loadDraw();
    const m = Draw.parse('draw 1\nr a 0 0 1 1 c=url(javascript:x)\nr b 0 0 1 1 c=red\n');
    return { errors: m.errors.length, svg: Draw.svgString("draw 1\nr b 0 0 1 1 c=red\n") };
  });
  expect(out.errors).toBe(1);
  expect(out.svg).not.toContain("javascript");
});

test("undo on the canvas works with vim mode on", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => toggleVim());
  await page.evaluate(() => createNote("v.draw", ""));
  await page.waitForFunction(() => window.Draw?.isMounted());
  await page.keyboard.press("r");
  await drag(page, [0, 0], [80, 40]);
  expect(await shapes(page)).toHaveLength(1);
  await page.keyboard.press("Control+z");
  expect(await content(page)).toBe("");
  expect(await page.locator("#drawHost [data-id]").count()).toBe(0);
});

test("another tab's edit shows on an open canvas", async ({ page, context }) => {
  await openDrawing(page, "draw 1\nr a 0 0 10 10\n");
  const other = await context.newPage();
  await openApp(other);
  await other.evaluate(() => {
    const n = state.notes.find((n) => n.name === "t.draw");
    n.content = "draw 1\nr a 0 0 10 10\nr b 50 0 10 10\n";
    n.updatedAt = Date.now() + 1000;
    saveState();
  });
  await expect(page.locator("#drawHost [data-id=b]")).toHaveCount(1);
});

test("back/forward and rename keep the right tab", async ({ page }) => {
  await openApp(page);
  await page.evaluate(async () => {
    await createNote("a.md", "# A\n\n[go](b.draw)\n");
    await createNote("b.draw", "draw 1\nr x 0 0 10 10\n");
    switchNote(state.notes.find((n) => n.name === "a.md").id);
    switchMdTab("view");
  });
  await page.locator("#mdPreview a", { hasText: "go" }).click();
  await page.waitForFunction(() => Draw.isMounted() && getActiveNote().name === "b.draw");
  await page.goBack();
  await page.waitForFunction(() => getActiveNote().name === "a.md");
  expect(await page.evaluate(() => mdViewActive && !Draw.isMounted())).toBe(true);
  await page.goForward();
  await page.waitForFunction(() => getActiveNote().name === "b.draw" && Draw.isMounted());
  // Renaming to markdown leaves the canvas
  await page.keyboard.press("F2");
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("b.md");
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => Draw.isMounted())).toBe(false);
  await expect(page.locator("#mdTabEdit")).toBeVisible();
});

test("touch: pinch zooms, two-finger tap undoes, pen rejects palms", async ({ page }) => {
  await openDrawing(page, "draw 1\nr a 0 0 10 10\n");
  // Synthetic pointers on the canvas: [type, id, x, y, pointerType]
  const fire = (events) =>
    page.evaluate((events) => {
      const svg = document.querySelector(".draw-svg");
      const r = svg.getBoundingClientRect();
      for (const [type, id, x, y, kind] of events)
        svg.dispatchEvent(
          new PointerEvent(type, {
            pointerId: id,
            pointerType: kind || "touch",
            clientX: r.left + x,
            clientY: r.top + y,
            bubbles: true,
            isPrimary: id === 1,
            pressure: 0.5,
          }),
        );
    }, events);
  const z0 = await page.evaluate(() => Draw._state.cam.z);
  await fire([
    ["pointerdown", 1, 200, 200],
    ["pointerdown", 2, 300, 200],
    ["pointermove", 1, 150, 200],
    ["pointermove", 2, 350, 200],
    ["pointerup", 1, 150, 200],
    ["pointerup", 2, 350, 200],
  ]);
  const z1 = await page.evaluate(() => Draw._state.cam.z);
  expect(z1 / z0).toBeCloseTo(2, 1);
  // A one-finger stroke draws, a quick two-finger tap takes it back
  await page.keyboard.press("d");
  await fire([
    ["pointerdown", 3, 100, 300],
    ["pointermove", 3, 140, 320],
    ["pointermove", 3, 180, 300],
    ["pointerup", 3, 180, 300],
  ]);
  expect(await shapes(page)).toHaveLength(2);
  await fire([
    ["pointerdown", 4, 200, 200],
    ["pointerdown", 5, 260, 200],
    ["pointerup", 4, 200, 200],
    ["pointerup", 5, 260, 200],
  ]);
  expect(await shapes(page)).toHaveLength(1);
  // After a stylus was used, a finger pans instead of drawing
  await fire([
    ["pointerdown", 6, 100, 400, "pen"],
    ["pointermove", 6, 160, 420, "pen"],
    ["pointerup", 6, 160, 420, "pen"],
  ]);
  const withPen = await shapes(page);
  expect(withPen).toHaveLength(2);
  expect(withPen[1].pts[0]).toHaveLength(3);
  const cx = await page.evaluate(() => Draw._state.cam.x);
  await fire([
    ["pointerdown", 7, 300, 300],
    ["pointermove", 7, 200, 300],
    ["pointerup", 7, 200, 300],
  ]);
  expect(await shapes(page)).toHaveLength(2);
  expect(await page.evaluate(() => Draw._state.cam.x)).not.toBe(cx);
});

test("an outside change during a no-op gesture is not lost", async ({ page }) => {
  await openDrawing(page, "draw 1\nr a 0 0 50 50\n");
  const a = await at(page, 25, 25);
  await page.mouse.move(...a);
  await page.mouse.down();
  await page.evaluate(() => {
    const n = getActiveNote();
    n.content = "draw 1\nr a 0 0 50 50\nr b 100 0 50 50\n";
    render();
  });
  await page.mouse.up();
  await expect(page.locator("#drawHost [data-id=b]")).toHaveCount(1);
});

test("rotating a stroke turns its box with it", async ({ page }) => {
  await openDrawing(page, "draw 1\np s 0,0 100,0 0,20\nr a 300 0 40 40\n");
  await click(page, 50, 0);
  const handle = await page.evaluate(() => Draw._state.handles.find((h) => h.kind === "rotate"));
  const r = await page.locator("#drawHost").boundingBox();
  await page.mouse.move(r.x + handle.x, r.y + handle.y);
  await page.mouse.down();
  const c = await at(page, 50, 10);
  await page.keyboard.down("Shift");
  await page.mouse.move(c[0] + 200, c[1] - 1, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  const s = (await shapes(page))[0];
  expect(s.rot).toBe(90);
  // Points stay as drawn; the box (selection frame) is turned
  expect(s.pts.map((p) => p.slice(0, 2))).toEqual([[0, 0], [100, 0], [100, 20]]);
  const corners = await page.evaluate(() => Draw._state.overlay.querySelector("polygon").getAttribute("points"));
  const xs = corners.split(" ").filter((_, i) => i % 2 === 0).map(Number);
  expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(40);
  // A turned multi-selection keeps its turned box after moving
  await page.keyboard.press("Control+a");
  await page.evaluate(() => {
    const E = Draw._state;
    const f = E.handles.find((h) => h.kind === "rotate");
    window.__rot = f;
  });
  const h2 = await page.evaluate(() => window.__rot);
  await page.mouse.move(r.x + h2.x, r.y + h2.y);
  await page.mouse.down();
  await page.mouse.move(r.x + h2.x + 150, r.y + h2.y + 150, { steps: 6 });
  await page.mouse.up();
  const turned = await page.evaluate(() => Draw._state.selRot?.f.rot);
  expect(turned).toBeGreaterThan(0);
  await drag(page, [320, 20], [320, 120]);
  expect(await page.evaluate(() => Draw._state.selRot?.f.rot)).toBe(turned);
});

test("free arrows turn alone and box along a turned selection", async ({ page }) => {
  await openDrawing(page, "draw 1\nr r 300 0 40 40\na a 0,0 100,0\nr b 0 100 40 40\na c r b\n");
  const r = await page.locator("#drawHost").boundingBox();
  const turn = async (dx, dy) => {
    const h = await page.evaluate(() => Draw._state.handles.find((h) => h.kind === "rotate"));
    await page.mouse.move(r.x + h.x, r.y + h.y);
    await page.mouse.down();
    await page.mouse.move(r.x + h.x + dx, r.y + h.y + dy, { steps: 6 });
    await page.mouse.up();
  };
  // A bound arrow has no rotate handle
  await click(page, 170, 70);
  expect(await page.evaluate(() => Draw._state.handles.some((h) => h.kind === "rotate"))).toBe(false);
  await click(page, 50, 0);
  // Drag the handle from straight above the centre to its right: a quarter turn
  const h = await page.evaluate(() => Draw._state.handles.find((h) => h.kind === "rotate"));
  const c = await at(page, 50, 0);
  await page.keyboard.down("Shift");
  await turn(c[0] - r.x - h.x + 200, c[1] - r.y - h.y - 1);
  await page.keyboard.up("Shift");
  const a = (await shapes(page)).find((s) => s.id === "a");
  expect(Math.round(a.from[0])).toBe(Math.round(a.to[0]));
  // In a turned multi-selection the arrow's outline is turned too
  await page.keyboard.press("Control+a");
  await turn(150, 150);
  const rot = await page.evaluate(() => Draw._state.selRot.f.rot);
  expect(rot % 90).not.toBe(0);
  const outlines = await page.evaluate(() =>
    [...Draw._state.overlay.querySelectorAll("polygon[stroke-opacity='0.5']")].map((p) => p.getAttribute("points")),
  );
  const ax = outlines.map((o) => o.split(/[ ,]/).map(Number)).filter((n) => n[0] !== n[6] && n[1] !== n[3]);
  expect(ax.length).toBe(outlines.length);
});

test("arrowheads and label alignment render", async ({ page }) => {
  await openDrawing(
    page,
    'draw 1\nr a 0 0 200 120 ta=left va=top "hi"\na b 0,200 200,200 hs=dot he=triangle\na c 0,260 200,260 hs=bar he=diamond\n',
  );
  const tx = await page.locator("#drawHost [data-id=a] tspan").evaluate((t) => [t.getAttribute("x"), t.parentNode.getAttribute("text-anchor")]);
  expect(Number(tx[0])).toBeLessThan(30);
  expect(tx[1]).toBe("start");
  expect(await page.locator("#drawHost [data-id=b] circle").count()).toBe(1);
  expect(await page.locator("#drawHost [data-id=b] path[fill]:not([fill=none])").count()).toBe(1);
  await click(page, 100, 60);
  await page.click('[data-draw="style:va:bottom"]');
  expect((await shapes(page))[0].va).toBe("bottom");
});

test("grid snapping puts outlines on grid points", async ({ page }) => {
  await openDrawing(page, "draw 1\ngrid on\nr a 3 7 100 60 s=xl\n");
  await drag(page, [50, 37], [93, 81]);
  const s = (await shapes(page))[0];
  expect([s.x % 20, s.y % 20]).toEqual([0, 0]);
});

test("stacking: keys, right-click menu, comments stay put", async ({ page }) => {
  await openDrawing(page, "draw 1\nr a 0 0 50 50\n# note\nr b 20 20 50 50\nr c 40 40 50 50\n");
  const order = async () => (await shapes(page)).map((s) => s.id).join("");
  await click(page, 5, 5);
  await page.keyboard.press("Alt+ArrowUp");
  expect(await order()).toBe("bac");
  expect((await content(page)).split("\n")[2]).toBe("# note");
  await page.keyboard.press("Alt+Shift+ArrowUp");
  expect(await order()).toBe("bca");
  await page.keyboard.press("Alt+ArrowDown");
  expect(await order()).toBe("bac");
  await page.keyboard.press("Shift+BracketLeft");
  expect(await order()).toBe("abc");
  // Right-click selects the shape under the pointer and offers the actions
  await page.mouse.click(...(await at(page, 85, 85)), { button: "right" });
  await expect(page.locator(".draw-menu")).toBeVisible();
  expect(await page.evaluate(() => [...Draw._state.sel])).toEqual(["c"]);
  await expect(page.locator('.draw-menu [data-draw="act:ungroup"]')).toBeDisabled();
  await page.click('.draw-menu [data-draw="act:back"]');
  await expect(page.locator(".draw-menu")).toBeHidden();
  expect(await order()).toBe("cab");
  await page.mouse.click(...(await at(page, 300, 300)), { button: "right" });
  await expect(page.locator('.draw-menu [data-draw="act:front"]')).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.locator(".draw-menu")).toBeHidden();
});

test("bold, italic and underline for all texts", async ({ page }) => {
  await openDrawing(page, 'draw 1\nr a 0 0 160 80 "box"\nt b 0 200 "free"\na c 0,300 200,300 "arrow"\n');
  await page.keyboard.press("Control+a");
  await page.click('[data-draw="style:st:b"]');
  await page.keyboard.press("Control+u");
  expect((await shapes(page)).map((s) => s.st)).toEqual(["bu", "bu", "bu"]);
  await expect(page.locator('[data-draw="style:st:b"]')).toHaveClass(/active/);
  expect(await page.locator("#drawHost text[font-weight=bold]").count()).toBe(3);
  expect(await page.locator("#drawHost [data-id=b] path").count()).toBe(1); // underline
  // Toggling off when all have it; typing keeps the style
  await page.keyboard.press("Control+b");
  expect((await shapes(page))[0].st).toBe("u");
  await page.mouse.dblclick(...(await at(page, 80, 40)));
  await page.keyboard.press("Control+i");
  await page.keyboard.type("x");
  await page.keyboard.press("Escape");
  expect((await shapes(page))[0]).toMatchObject({ st: "iu", label: "x" });
  expect(await content(page)).toContain('r a 0 0 160 80 st=iu "x"');
});

test("style panel closes and reopens", async ({ page }) => {
  await openDrawing(page, "draw 1\nr a 0 0 50 50\n");
  await click(page, 25, 0);
  await expect(page.locator(".draw-style")).toBeVisible();
  await page.click('[data-draw="nav:closestyle"]');
  await expect(page.locator(".draw-style")).toBeHidden();
  await page.click('[data-draw="nav:openstyle"]');
  await expect(page.locator(".draw-style")).toBeVisible();
  await expect(page.locator('[data-draw="nav:openstyle"]')).toBeHidden();
});

test("closing zen returns to the canvas", async ({ page }) => {
  await openDrawing(page, "draw 1\nr a 0 0 50 50\n");
  await page.click("#mdTabZen");
  await page.waitForFunction(() => Draw._state.readonly);
  await page.click(".zen-close-btn");
  await page.waitForFunction(() => Draw.isMounted() && !Draw._state.readonly);
  expect(await page.evaluate(() => [mdViewActive, zenModeActive])).toEqual([true, false]);
});

test("phones: + opens the other tools as a grid", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await openDrawing(page);
  await expect(page.locator('.draw-tools [data-draw="tool:rect"]')).toBeHidden();
  await page.click('[data-draw="nav:tools"]');
  await page.click('.draw-toolgrid [data-draw="tool:rect"]');
  await expect(page.locator(".draw-toolgrid")).toBeHidden();
  expect(await page.evaluate(() => Draw._state.tool)).toBe("rect");
  // The active tool joins select and hand in the dock
  await expect(page.locator('.draw-tools [data-draw="tool:rect"]')).toHaveClass(/active/);
  await expect(page.locator('.draw-tools [data-draw="tool:rect"]')).toBeVisible();
  await expect(page.locator('.draw-tools [data-draw="tool:ellipse"]')).toBeHidden();
  await expect(page.locator('.draw-tools [data-draw="nav:undo"]')).toBeVisible();
});

test("undo and redo buttons: hidden with a fine pointer", async ({ page }) => {
  await openDrawing(page, "draw 1\nr a 0 0 50 50\n");
  await expect(page.locator('[data-draw="nav:undo"]')).toBeHidden();
  await expect(page.locator('[data-draw="nav:redo"]')).toBeHidden();
});

test.describe("touch", () => {
  test.use({ hasTouch: true });
  test("undo and redo buttons show on touch and work", async ({ page }) => {
    await openDrawing(page, "draw 1\n");
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    await page.keyboard.press("r");
    await drag(page, [0, 0], [100, 60]);
    expect(await shapes(page)).toHaveLength(1);
    await page.click('[data-draw="nav:undo"]');
    expect(await shapes(page)).toHaveLength(0);
    await page.click('[data-draw="nav:redo"]');
    expect(await shapes(page)).toHaveLength(1);
  });
});

test("inspector: header names the selection, Arrange menu restacks", async ({ page }) => {
  await openDrawing(page, "draw 1\nr a 0 0 50 50\nr b 20 20 50 50\nr c 40 40 50 50\n");
  const order = async () => (await shapes(page)).map((s) => s.id).join("");
  await expect(page.locator(".draw-style")).toBeHidden();
  await page.keyboard.press("o");
  await expect(page.locator(".draw-style-head")).toHaveText("Ellipse");
  await page.keyboard.press("v");
  await click(page, 5, 5);
  await expect(page.locator(".draw-style-head")).toHaveText("Rectangle");
  for (const [act, want] of [["front", "bca"], ["back", "abc"], ["forward", "bac"], ["backward", "abc"]]) {
    await page.click('.draw-style [data-draw="nav:arrange"]');
    await expect(page.locator(".draw-arrange")).toBeVisible();
    await page.click(`.draw-arrange [data-draw="act:${act}"]`);
    await expect(page.locator(".draw-arrange")).toBeHidden();
    expect(await order()).toBe(want);
  }
  await page.keyboard.press("Control+a");
  await expect(page.locator(".draw-style-head")).toHaveText("3 shapes");
  // Escape closes the menu first, keeping the selection
  await page.click('.draw-style [data-draw="nav:arrange"]');
  await page.keyboard.press("Escape");
  await expect(page.locator(".draw-arrange")).toBeHidden();
  expect(await page.evaluate(() => Draw._state.sel.size)).toBe(3);
});

test("chrome tooltips use data-tip, not title", async ({ page }) => {
  await openDrawing(page, "draw 1\nr a 0 0 50 50\n");
  await click(page, 25, 0);
  expect(await page.locator("#drawHost [title]").count()).toBe(0);
  const rect = page.locator('.draw-tools [data-draw="tool:rect"]');
  await expect(rect).toHaveAttribute("data-tip", "Rectangle");
  await expect(rect).toHaveAttribute("data-key", "R");
  await expect(rect).toHaveAttribute("aria-label", "Rectangle");
  await expect(rect).toHaveText("");
  await expect(page.locator('[data-draw="nav:reset"]')).toHaveAttribute("data-tip", "Zoom to 100%");
  await expect(page.locator('.draw-style [data-draw="act:dup"]')).toHaveAttribute("data-tip", "Duplicate");
});

test("a shared link replacing a drawing shows the new shapes", async ({ page }) => {
  await openApp(page);
  const url = await page.evaluate(async () => {
    await createNote("pic.draw", "draw 1\nr old 3000 3000 40 40\n");
    return shareUrlFor({ name: "pic.draw", content: "draw 1\nr new 0 0 100 50 c=red\n", updatedAt: 1 });
  });
  await page.goto(url.replace(/&ts=\d+/, ""));
  // The link's version shows under the banner; mine is one click away
  await page.waitForFunction(() => window.Draw?._state.text?.includes("new"));
  await page.click('#banner button:has-text("Replace mine")');
  expect(await page.evaluate(() => state.notes.find((n) => n.name === "pic.draw").content)).toContain("r new");
  const box = await page.locator(".draw-svg rect[stroke]").last().boundingBox();
  const host = await page.locator("#drawHost").boundingBox();
  expect(box.x).toBeGreaterThan(host.x);
  expect(box.x + box.width).toBeLessThan(host.x + host.width);
});

test("zen hides the grid and leaving zen brings it back", async ({ page }) => {
  await openApp(page);
  await page.evaluate(async () => {
    await createNote("grid.draw", "draw 1\ngrid on\nr 0 0 40 40\n");
    switchMdTab("view");
  });
  const gridShown = () =>
    page.$eval(".draw-host .draw-grid", (el) => getComputedStyle(el).display !== "none");
  await expect.poll(gridShown).toBe(true);
  await page.evaluate(() => switchMdTab("zen"));
  await expect.poll(gridShown).toBe(false);
  await page.evaluate(() => switchMdTab("view"));
  await expect.poll(gridShown).toBe(true);
});
