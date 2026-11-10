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

const shown = (page, c) =>
  page.evaluate((c) => [...document.querySelectorAll(`#gridHost .grid-body .grid-row [data-c="${c}"]`)].map((e) => e.textContent), c);

test("sorting is a view: numbers by value, text naturally, empty last", async ({ page }) => {
  const csv = "name,n\nb10,10\na2,9\n,\nA1,100\nb2,x\n";
  await openTable(page, csv);
  const sortBtn = page.locator("#gridHost .grid-sort[data-sort='1']");
  await sortBtn.click();
  expect(await shown(page, 1)).toEqual(["9", "10", "100", "x", ""]);
  await sortBtn.click();
  expect(await shown(page, 1)).toEqual(["x", "100", "10", "9", ""]);
  await page.locator("#gridHost .grid-sort[data-sort='0']").click();
  expect(await shown(page, 0)).toEqual(["A1", "a2", "b2", "b10", ""]);
  // Row numbers stay the file's
  expect(await page.locator("#gridHost .grid-body .gn").allTextContents()).toEqual(["4", "2", "5", "1", "3"]);
  expect(await content(page)).toBe(csv);
  await page.locator("#gridHost .grid-sort[data-sort='0']").click();
  await page.locator("#gridHost .grid-sort[data-sort='0']").click();
  expect(await shown(page, 0)).toEqual(["b10", "a2", "", "A1", "b2"]);
});

test("edits in a sorted view go to the right rows and keep the order", async ({ page }) => {
  await openTable(page, "n\n3\n1\n2\n");
  await page.locator("#gridHost .grid-sort[data-sort='0']").click();
  expect(await shown(page, 0)).toEqual(["1", "2", "3"]);
  await cellEl(page, 1, 0).click();
  await page.keyboard.type("9");
  await page.keyboard.press("Enter");
  expect(await content(page)).toBe("n\n3\n9\n2\n");
  expect(await shown(page, 0)).toEqual(["9", "2", "3"]);
  // Delete the shown "2" (file row 3)
  await page.locator("#gridHost .grid-body .grid-row[data-r='2'] .gn").click();
  await page.keyboard.press("ControlOrMeta+Backspace");
  expect(await content(page)).toBe("n\n3\n9\n");
  await page.locator("#gridHost [data-g=insert]").click();
  await page.locator("#gridHost .grid-pop [data-g=row-below]").click();
  // The selection moved to "3" (file row 1): the new row goes after it, in view and file
  expect(await shown(page, 0)).toEqual(["9", "3", ""]);
  expect(await content(page)).toBe("n\n3\n\n9\n");
});

test("Save sort writes the order, for every row", async ({ page }) => {
  await openTable(page, "n,t\n3,c\n1,a\n2,b\n");
  await expect(page.locator("#gridHost [data-g=save-sort]")).toBeHidden();
  await page.locator("#gridHost .grid-filter input").fill("a");
  await page.locator("#gridHost .grid-sort[data-sort='0']").click();
  await page.locator("#gridHost [data-g=save-sort]").click();
  expect(await content(page)).toBe("n,t\n1,a\n2,b\n3,c\n");
  await expect(page.locator("#gridHost [data-g=save-sort]")).toBeHidden();
  await page.keyboard.press("ControlOrMeta+z");
  expect(await content(page)).toBe("n,t\n3,c\n1,a\n2,b\n");
});

test("filter shows matching rows, keeps the header, Esc clears", async ({ page }) => {
  const rows = ["city,country"];
  for (let i = 0; i < 3000; i++) rows.push(`c${i},${i % 3 ? "CH" : "DE"}`);
  await openTable(page, rows.join("\n") + "\n");
  const input = page.locator("#gridHost .grid-filter input");
  await input.fill("de");
  await expect(page.locator("#gridHost .grid-size")).toHaveText("1,000 of 3,000 rows × 2 columns");
  await expect(page.locator("#gridHost .grid-head .hdr").first()).toHaveText("city");
  await input.press("Escape");
  await expect(page.locator("#gridHost .grid-size")).toHaveText("3,000 rows × 2 columns");
  await input.fill("c2999");
  await page.locator("#gridHost .grid-scroll").focus();
  await page.keyboard.press("ControlOrMeta+f");
  await page.keyboard.type("CH");
  await expect(page.locator("#findReplaceCount")).toHaveText("1 of 1");
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

test("```csv and ```tsv blocks render as tables in the preview", async ({ page }) => {
  await openApp(page);
  const md = '# t\n\n```csv\nname,qty\n"a, <b>",3\n"two\nlines",\n```\n\n```tsv\nx\ty\n1\t2\n```\n';
  await page.evaluate((c) => createNote("t.md", c), md);
  await page.evaluate(() => switchMdTab("view"));
  const tables = page.locator("#mdPreview table.csv-table");
  await expect(tables).toHaveCount(2);
  await expect(tables.first().locator("th")).toHaveText(["name", "qty"]);
  await expect(tables.first().locator("tbody td").first()).toHaveText("a, <b>");
  await expect(tables.first().locator("tbody td.align-right")).toHaveText("3");
  expect(await tables.first().locator("tbody tr").nth(1).locator("td").first().innerHTML()).toBe("two<br>lines");
  await expect(tables.nth(1).locator("td")).toHaveText(["1", "2"]);
});

test("big csv blocks show the first 1000 rows", async ({ page }) => {
  await openApp(page);
  const rows = ["n"];
  for (let i = 0; i < 1500; i++) rows.push(String(i));
  await page.evaluate((c) => createNote("t.md", c), "```csv\n" + rows.join("\n") + "\n```\n");
  await page.evaluate(() => switchMdTab("view"));
  await expect(page.locator("#mdPreview tbody tr")).toHaveCount(1000);
  await expect(page.locator("#mdPreview .csv-more")).toHaveText("500 more rows");
});

test("```csv noheader renders every row as data", async ({ page }) => {
  await openApp(page);
  await page.evaluate((c) => createNote("t.md", c), "```csv noheader\na,1\nb,2\n```\n");
  await page.evaluate(() => switchMdTab("view"));
  await expect(page.locator("#mdPreview table.csv-table th")).toHaveCount(0);
  await expect(page.locator("#mdPreview table.csv-table td")).toHaveText(["a", "1", "b", "2"]);
});

test("![](data.csv) embeds the table, follows its header setting, links to it", async ({ page }) => {
  await openApp(page);
  await page.evaluate(async () => {
    await createNote("data.csv", "x,y\n1,2\n");
    getActiveNote().csvHeader = false;
    await createNote("t.md", "![Data](data.csv)\n\n![](gone.csv)\n");
    switchMdTab("view");
  });
  const fig = page.locator("#mdPreview figure.csv-embed");
  await expect(fig.locator("th")).toHaveCount(0);
  await expect(fig.locator("td")).toHaveText(["x", "y", "1", "2"]);
  await expect(page.locator("#mdPreview .missing")).toHaveText("table not found: gone.csv");
  await fig.locator("figcaption a").click();
  await expect(page.locator("#mdTabView")).toContainText("Table");
  expect(await page.evaluate(() => getActiveNote().name)).toBe("data.csv");
});

test("long preview tables keep their header in view", async ({ page }) => {
  await openApp(page);
  const rows = ["name,n"];
  for (let i = 0; i < 200; i++) rows.push(`r${i},${i}`);
  await page.evaluate((c) => createNote("t.md", c), "```csv\n" + rows.join("\n") + "\n```\n");
  await page.evaluate(() => switchMdTab("view"));
  const table = page.locator("#mdPreview table");
  await table.evaluate((t) => (t.scrollTop = 2000));
  const [tb, hb] = await Promise.all([table.boundingBox(), page.locator("#mdPreview th").first().boundingBox()]);
  expect(Math.abs(hb.y - tb.y)).toBeLessThan(2);
});
