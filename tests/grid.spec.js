const { test, expect, openApp } = require("./fixtures");

async function openTable(page, content = "", name = "t.csv") {
  await openApp(page);
  await page.evaluate(([n, c]) => createNote(n, c), [name, content]);
  await page.waitForFunction(() => window.Grid?.isMounted());
}

const content = (page) => page.evaluate(() => getActiveNote().content);
const cellEl = (page, r, c) => page.locator(`#gridHost .grid-row[data-r="${r}"] [data-c="${c}"]`);

test("format: parse and serialize round-trip", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => loadGrid());
  const r = await page.evaluate(() => {
    const text = 'a,"b,c","say ""hi"""\n"multi\nline",,x\n';
    const rows = Grid.parse(text, ",");
    return { rows, back: Grid.serialize(rows, ","), ragged: Grid.serialize([["a"], ["b", "c"]], ",") };
  });
  expect(r.rows).toEqual([
    ["a", "b,c", 'say "hi"'],
    ["multi\nline", "", "x"],
  ]);
  expect(r.back).toBe('a,"b,c","say ""hi"""\n"multi\nline",,x\n');
  expect(r.ragged).toBe("a,\nb,c\n");
});

test("import cleanup: separators, line endings, sep= hint", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => loadGrid());
  const r = await page.evaluate(() => ({
    semi: Grid.normalize("name;price\r\nTea;1,5\r\nCake;2,25\r\n", ","),
    tab: Grid.normalize("a\tb\nc, d\te\n", ","),
    pipe: Grid.normalize("a|b\n1|2\n", "\t"),
    hint: Grid.normalize("sep=;\na;b\n", ","),
    single: Grid.normalize("one\ntwo\n", ","),
    ours: Grid.normalize("a,b\n1,2\n", ","),
  }));
  expect(r.semi.text).toBe('name,price\nTea,"1,5"\nCake,"2,25"\n');
  expect(r.semi.notes).toEqual(["semicolon-separated", "CRLF line endings"]);
  expect(r.tab.text).toBe('a,b\n"c, d",e\n');
  expect(r.pipe.text).toBe("a\tb\n1\t2\n");
  expect(r.hint.text).toBe("a,b\n");
  expect(r.single).toEqual({ text: "one\ntwo\n", notes: [] });
  expect(r.ours).toEqual({ text: "a,b\n1,2\n", notes: [] });
});

test("decode: BOMs, UTF-8, Windows-1252", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => loadGrid());
  const r = await page.evaluate(() => {
    const u16 = new Uint8Array([0xff, 0xfe, 0x61, 0, 0x09, 0, 0xe4, 0]);
    return [
      Grid.decode(u16),
      Grid.decode(new Uint8Array([0xef, 0xbb, 0xbf, 0xc3, 0xa4])),
      Grid.decode(new Uint8Array([0x80, 0xe4])),
    ];
  });
  expect(r[0]).toEqual({ text: "a\tä", encoding: "utf-16le" });
  expect(r[1]).toEqual({ text: "ä", encoding: "utf-8" });
  expect(r[2]).toEqual({ text: "€ä", encoding: "windows-1252" });
});

test("csv opens on the table; tabs read Table | Source", async ({ page }) => {
  await openTable(page, "name,qty\napple,3\n");
  await expect(page.locator("#mdTabView")).toContainText("Table");
  await expect(page.locator("#mdTabEdit")).toContainText("Source");
  await expect(page.locator("#gridHost .grid-head .hdr").first()).toHaveText("name");
  await expect(cellEl(page, 1, 1)).toHaveText("3");
  await expect(page.locator("#gridHost .grid-size")).toHaveText("1 row × 2 columns");
});

test("typing edits a cell; Enter commits; undo restores", async ({ page }) => {
  await openTable(page, "a,b\n1,2\n");
  await cellEl(page, 1, 0).click();
  await page.keyboard.type("x,y");
  await page.keyboard.press("Enter");
  expect(await content(page)).toBe('a,b\n"x,y",2\n');
  await page.keyboard.press("ControlOrMeta+z");
  expect(await content(page)).toBe("a,b\n1,2\n");
  await expect(cellEl(page, 1, 0)).toHaveText("1");
});

test("double click edits; Enter and Tab commit and move", async ({ page }) => {
  await openTable(page, "a,b\n1,2\n");
  await page.locator("#gridHost .grid-head .hdr[data-c='0']").dblclick();
  await page.keyboard.type("!");
  await page.keyboard.press("Tab");
  await page.keyboard.type("?");
  await page.keyboard.press("Enter");
  // Typing on a selected cell replaces it, like a spreadsheet
  expect(await content(page)).toBe("a!,?\n1,2\n");
  expect(await page.evaluate(() => Grid.active())).toEqual({ r: 1, c: 1 });
});

test("insert and delete rows and columns", async ({ page }) => {
  await openTable(page, "a,b\n1,2\n3,4\n");
  await cellEl(page, 1, 0).click();
  await page.locator("#gridHost [data-g=insert]").click();
  await page.locator("#gridHost .grid-pop [data-g=row-below]").click();
  expect(await content(page)).toBe("a,b\n1,2\n,\n3,4\n");
  await page.locator("#gridHost [data-g=insert]").click();
  await page.locator("#gridHost .grid-pop [data-g=col-left]").click();
  expect(await content(page)).toBe(",a,b\n,1,2\n,,\n,3,4\n");
  await page.locator("#gridHost [data-g=delete]").click();
  await page.locator("#gridHost .grid-pop [data-g=del-cols]").click();
  await page.locator("#gridHost [data-g=delete]").click();
  await page.locator("#gridHost .grid-pop [data-g=del-rows]").click();
  expect(await content(page)).toBe("a,b\n1,2\n3,4\n");
});

test("insert 10 rows or columns at once, selected", async ({ page }) => {
  await openTable(page, "a,b\n1,2\n");
  await cellEl(page, 1, 0).click();
  await page.locator("#gridHost [data-g=insert]").click();
  await page.locator("#gridHost .grid-pop [data-g=row-above-10]").click();
  expect((await content(page)).split("\n")).toEqual(["a,b", ...Array(10).fill(","), "1,2", ""]);
  await page.locator("#gridHost [data-g=insert]").click();
  await page.locator("#gridHost .grid-pop [data-g=col-right-10]").click();
  const rows = (await content(page)).split("\n");
  expect(rows[0]).toBe("a" + ",".repeat(10) + ",b");
  await expect(page.locator("#gridHost .grid-size")).toHaveText("11 rows × 12 columns");
  // Delete takes the selected 10 columns away again
  await page.locator("#gridHost [data-g=delete]").click();
  await expect(page.locator("#gridHost .grid-pop [data-g=del-cols]")).toHaveText("Delete 10 columns");
});

test("copy and paste ranges as TSV", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openTable(page, "a,b\n1,2\n");
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "x\ty\nz\tw\n");
    Grid.revealOffset(4);
    document.querySelector("#gridHost .grid-scroll").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
  });
  expect(await content(page)).toBe("a,b\nx,y\nz,w\n");
});

test("header row can be turned off and stays off", async ({ page }) => {
  await openTable(page, "a,b\n1,2\n");
  await page.locator("#gridHost [data-g=header]").click();
  await expect(page.locator("#gridHost .grid-size")).toHaveText("2 rows × 2 columns");
  expect(await page.evaluate(() => getActiveNote().csvHeader)).toBe(false);
  expect(await content(page)).toBe("a,b\n1,2\n");
});

test("tsv keeps tabs", async ({ page }) => {
  await openTable(page, "a\tb\n", "t.tsv");
  await page.locator("#gridHost .grid-head .hdr[data-c='0']").dblclick();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("x,y");
  await page.keyboard.press("Escape");
  expect(await content(page)).toBe("a\tb\n");
  await page.locator("#gridHost .grid-head .hdr[data-c='0']").dblclick();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("x,y");
  await page.keyboard.press("Tab");
  expect(await content(page)).toBe("x,y\tb\n");
});

test("big tables render only what's on screen", async ({ page }) => {
  const rows = ["id,name"];
  for (let i = 0; i < 20000; i++) rows.push(`${i},row ${i}`);
  await openTable(page, rows.join("\n") + "\n");
  expect(await page.locator("#gridHost .grid-body .grid-row").count()).toBeLessThan(80);
  await page.evaluate(() => (document.querySelector("#gridHost .grid-scroll").scrollTop = 26 * 15000));
  await expect(page.locator("#gridHost .grid-body .grid-row[data-r='15001']")).toHaveCount(1);
});

test("selecting a column or row doesn't scroll", async ({ page }) => {
  const rows = ["id,name"];
  for (let i = 0; i < 500; i++) rows.push(`${i},row ${i}`);
  await openTable(page, rows.join("\n") + "\n");
  const scroller = page.locator("#gridHost .grid-scroll");
  await scroller.evaluate((el) => (el.scrollTop = 2600));
  await page.locator("#gridHost .grid-head .gl[data-c='1']").click();
  expect(await scroller.evaluate((el) => el.scrollTop)).toBe(2600);
  await expect(page.locator("#gridHost [data-g=delete]")).toBeVisible();
  await page.locator("#gridHost .grid-body .grid-row[data-r='110'] .gn").click();
  expect(await scroller.evaluate((el) => el.scrollTop)).toBe(2600);
  expect(await page.evaluate(() => Grid.active())).toEqual({ r: 110, c: 0 });
});

test("⌘⌫ deletes selected rows or columns, ⌫ clears", async ({ page }) => {
  await openTable(page, "a,b,c\n1,2,3\n4,5,6\n");
  await page.locator("#gridHost .grid-body .grid-row[data-r='1'] .gn").click();
  await page.keyboard.press("ControlOrMeta+Backspace");
  expect(await content(page)).toBe("a,b,c\n4,5,6\n");
  await page.locator("#gridHost .grid-head .gl[data-c='1']").click();
  await page.keyboard.press("ControlOrMeta+Backspace");
  expect(await content(page)).toBe("a,c\n4,6\n");
  await cellEl(page, 1, 0).click();
  await page.keyboard.press("ControlOrMeta+Backspace");
  expect(await content(page)).toBe("a,c\n,6\n");
});

test("drag a column edge to resize it, double-click to fit it", async ({ page }) => {
  await openTable(page, "a,b\n" + "x".repeat(120) + ",2\n");
  const handle = page.locator("#gridHost .grid-rz[data-rz='0']");
  const w0 = await page.evaluate(() => Grid._state.w[0]);
  expect(w0).toBe(280);
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + 3, box.y + 5);
  await page.mouse.down();
  await page.mouse.move(box.x - 97, box.y + 5, { steps: 4 });
  await page.mouse.up();
  expect(await page.evaluate(() => Grid._state.w[0])).toBe(180);
  // Nothing selected or written by resizing
  expect(await page.evaluate(() => Grid.active())).toEqual({ r: 0, c: 0 });
  const box2 = await handle.boundingBox();
  await page.mouse.dblclick(box2.x + 3, box2.y + 5);
  expect(await page.evaluate(() => Grid._state.w[0])).toBeGreaterThan(280);
  expect(await content(page)).toBe("a,b\n" + "x".repeat(120) + ",2\n");
});

test("a selection shows sum, average and count", async ({ page }) => {
  await openTable(page, "item,price\nTea,\"1,5\"\nCake,2.5\nNote,n/a\n");
  await page.locator("#gridHost .grid-head .gl[data-c='1']").click();
  await expect(page.locator("#gridHost .grid-size")).toHaveText(/^Sum 4 · Average 2 · Count 3$/);
  await cellEl(page, 1, 0).click();
  await expect(page.locator("#gridHost .grid-size")).toHaveText("3 rows × 2 columns");
});

test("⌘D fills down, ⌘R fills right", async ({ page }) => {
  await openTable(page, "a,b,c\n1,2,3\n,,\n,,\n");
  await cellEl(page, 1, 0).click();
  await cellEl(page, 3, 1).click({ modifiers: ["Shift"] });
  await page.keyboard.press("ControlOrMeta+d");
  expect(await content(page)).toBe("a,b,c\n1,2,3\n1,2,\n1,2,\n");
  await cellEl(page, 2, 2).click();
  await page.keyboard.press("ControlOrMeta+r");
  expect(await content(page)).toBe("a,b,c\n1,2,3\n1,2,2\n1,2,\n");
});

test("undo and redo select the cells they change", async ({ page }) => {
  await openTable(page, "a,b\n1,2\n3,4\n");
  await cellEl(page, 2, 1).click();
  await page.keyboard.type("9");
  await page.keyboard.press("Enter");
  await cellEl(page, 1, 0).click();
  await page.keyboard.press("ControlOrMeta+z");
  expect(await content(page)).toBe("a,b\n1,2\n3,4\n");
  expect(await page.evaluate(() => Grid.active())).toEqual({ r: 2, c: 1 });
  await cellEl(page, 0, 0).click();
  await page.keyboard.press("ControlOrMeta+Shift+z");
  expect(await content(page)).toBe("a,b\n1,2\n3,9\n");
  expect(await page.evaluate(() => Grid.active())).toEqual({ r: 2, c: 1 });
});

test("⌘F finds in cells, also off screen", async ({ page }) => {
  const rows = ["id,name"];
  for (let i = 0; i < 2000; i++) rows.push(`${i},row ${i}`);
  await openTable(page, rows.join("\n") + "\n");
  await page.locator("#gridHost .grid-scroll").focus();
  await page.keyboard.press("ControlOrMeta+f");
  await page.keyboard.type("row 1999");
  await expect(page.locator("#findReplaceCount")).toHaveText("1 of 1");
  await expect(page.locator("#gridHost mark.cur")).toHaveText("row 1999");
  expect(await page.evaluate(() => mdViewActive)).toBe(true);
});

test("import converts other CSV dialects and says so", async ({ page }) => {
  await openApp(page);
  await page.evaluate(async () => {
    const bytes = new Uint8Array([...new TextEncoder().encode("Name;Preis\r\nK"), 0xe4, ...new TextEncoder().encode("se;1,5\r\n")]);
    await importFiles([new File([bytes], "shop.csv", { type: "text/csv" })]);
  });
  expect(await content(page)).toBe('Name,Preis\nKäse,"1,5"\n');
  await expect(page.locator(".toast").last()).toContainText("Windows-1252, semicolon-separated");
});

test("download for Excel: BOM, CRLF", async ({ page }) => {
  await openTable(page, "a,b\nä,2\n");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.evaluate(() => downloadExcel())]);
  const text = require("fs").readFileSync(await dl.path(), "utf8");
  expect(text.startsWith("﻿")).toBe(true);
  expect(text).toMatch(/^﻿a[,;]b\r\nä[,;]2\r\n$/);
});
