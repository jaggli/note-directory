const { test, expect, openApp } = require("./fixtures");

const content = (page, name) => page.evaluate((n) => state.notes.find((x) => x.name === n)?.content, name);
const SALES = "quarter,north,south\nQ1,10,8\nQ2,12,9\nQ3,7,11\n";

async function withChart(page, chart, files = [["sales.csv", SALES]]) {
  await openApp(page);
  await page.evaluate(async ([files, chart]) => {
    for (const [n, c] of files) await createNote(n, c);
    await createNote("sales.chart", chart);
  }, [files, chart]);
  await expect(page.locator("#chartHost svg")).toBeVisible();
}

test("format: settings lines, defaults left out, inline data stays last", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => loadChart());
  const r = await page.evaluate(() => {
    let t = "chart 1\n# mine\ntype line\ndata\nm,v\nJan,1\n";
    t = Chart.set(t, "title", "Visits by month");
    t = Chart.set(t, "type", "column");
    const inline = t;
    const ref = Chart.setData(t, "../data/v.csv");
    const spec = Chart.parse('chart 1\ny "North region" south\nbogus 1\n');
    return { inline, ref, y: spec.y, errors: spec.errors };
  });
  expect(r.inline).toBe('chart 1\n# mine\ntitle "Visits by month"\ndata\nm,v\nJan,1\n');
  expect(r.ref).toBe('chart 1\n# mine\ntitle "Visits by month"\ndata ../data/v.csv');
  expect(r.y).toEqual(["North region", "south"]);
  expect(r.errors[0]).toContain("bogus");
});

test("every type lays out as a drawing with no errors", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => loadChart());
  const out = await page.evaluate((csv) => {
    return Chart.TYPES.map(([type]) => {
      const c = Chart.compile(`chart 1\ntype ${type}\nlabels on\ndata\n${csv}`, () => ({}));
      return { type, error: c.error, drawErrors: Draw.parse(c.draw).errors.length, shapes: c.draw.split("\n").length };
    });
  }, SALES);
  for (const o of out) {
    expect(o.error, o.type).toBe("");
    expect(o.drawErrors, o.type).toBe(0);
    expect(o.shapes, o.type).toBeGreaterThan(8);
  }
});

test("a .chart opens on Chart | Source; settings rewrite its lines", async ({ page }) => {
  await withChart(page, "chart 1\ndata sales.csv\n");
  await expect(page.locator("#mdTabView")).toContainText("Chart");
  await page.click('.chart-types [data-type="line"]');
  expect(await content(page, "sales.chart")).toBe("chart 1\ndata sales.csv\ntype line\n");
  await page.fill('.chart-panel [data-k="title"]', "Revenue");
  await page.locator('.chart-panel [data-k="title"]').press("Enter");
  await page.locator('.chart-panel [data-k="title"]').blur();
  await expect.poll(() => content(page, "sales.chart")).toContain('title Revenue');
  // Series off, colour changed
  await page.locator('.chart-series input[data-y="2"]').uncheck();
  expect(await content(page, "sales.chart")).toContain("y north");
  await page.selectOption('.chart-series select[data-color="0"]', "green");
  expect(await content(page, "sales.chart")).toContain("colors green");
  await page.selectOption('.chart-panel [data-k="background"]', "grey");
  expect(await content(page, "sales.chart")).toContain("background grey");
  // Undo goes through the note's history
  await page.locator("#chartHost .chart-view").click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => content(page, "sales.chart")).not.toContain("background");
  await expect(page.locator('.chart-panel [data-k="background"]')).toHaveValue("none");
});

test("data from a table follows it when it moves; the table lists the chart as used", async ({ page }) => {
  await withChart(page, "chart 1\ndata sales.csv\n");
  await page.evaluate(() => moveNotesTo([state.notes.find((n) => n.name === "sales.csv")], "data/"));
  expect(await content(page, "sales.chart")).toBe("chart 1\ndata data/sales.csv\n");
  const used = await page.evaluate(() => backlinks(state.notes.find((n) => n.name === "data/sales.csv")).map((n) => n.name));
  expect(used).toEqual(["sales.chart"]);
  // Missing table: said so, still a chart frame
  await page.evaluate(() => renameNote(state.notes.find((n) => n.name === "data/sales.csv"), "/gone.txt"));
  await page.evaluate(() => switchNote(state.notes.find((n) => n.name === "sales.chart").id));
  await expect(page.locator(".chart-msg")).toContainText("not a table");
});

test("Add chart in a table uses the selected range; one cell takes the whole table", async ({ page }) => {
  await openApp(page);
  await page.evaluate((csv) => createNote("q/sales.csv", csv), SALES);
  await expect(page.locator("#gridHost .grid-scroll")).toBeVisible();
  // Rows 1–2 as numbered (Q1, Q2), columns B–C
  await page.evaluate(() => {
    Grid._state.act = { r: 2, c: 2 };
    Grid._state.anc = { r: 1, c: 1 };
  });
  await page.click('#gridHost [data-g="chart"]');
  await expect.poll(() => content(page, "q/sales.chart")).toBe("chart 1\ndata sales.csv\nrange B1:C2\n");
  await expect(page.locator("#chartHost svg")).toBeVisible();
  const c = await page.evaluate(() => {
    const t = Chart.compile(getActiveNote().content, chartData(getActiveNote().name));
    return { rows: t.table.rows.length, draw: t.draw };
  });
  expect(c.rows).toBe(2);
  expect(c.draw).toContain('"Q1"');
  expect(c.draw).not.toContain('"Q3"');

  // Right-click a cell: no inserts, a chart from the range
  await page.evaluate(() => switchNote(state.notes.find((n) => n.name === "q/sales.csv").id));
  await expect(page.locator("#gridHost .grid-scroll")).toBeVisible();
  await page.evaluate(() => {
    Grid._state.act = { r: 3, c: 1 };
    Grid._state.anc = { r: 0, c: 1 };
  });
  const cell = page.locator("#gridHost .grid-row[data-r='2'] .grid-cell[data-c='1']");
  await cell.click({ button: "right" });
  await expect(page.locator("#gridHost .grid-pop")).not.toContainText("Insert");
  await page.click('#gridHost .grid-pop [data-g="chart"]');
  await expect.poll(() => content(page, "q/sales1.chart")).toBe("chart 1\ndata sales.csv\nrange B:B\n");
});

test("ranges and sizes", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => loadChart());
  const r = await page.evaluate((csv) => {
    const t = (range) => Chart.table(csv, ",", true, range);
    const c = Chart.compile("chart 1\nsize 900 300\ndata\n" + csv, () => ({}));
    return {
      rows: t("A2:C3").rows.map((r) => r[0]),
      cols: Chart.compile("chart 1\nrange C:C\ndata\n" + csv, () => ({})).draw.includes('"north"'),
      frame: c.draw.split("\n")[1],
      bad: Chart.compile("chart 1\nrange nope\ndata\n" + csv, () => ({})).error,
    };
  }, SALES);
  expect(r.rows).toEqual(["Q2", "Q3"]);
  expect(r.cols).toBe(false);
  expect(r.frame).toContain(" 900 300 ");
  expect(r.bad).toContain("nope");
});

test("dragging the corner resizes the chart", async ({ page }) => {
  await withChart(page, "chart 1\ndata sales.csv\n");
  const rz = page.locator("#chartHost .chart-rz");
  await page.locator("#chartHost .chart-frame").hover();
  const b = await rz.boundingBox();
  await page.mouse.move(b.x + 5, b.y + 5);
  await page.mouse.down();
  await page.mouse.move(b.x - 95, b.y - 95, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => content(page, "sales.chart")).toMatch(/size \d+ \d+/);
  const size = (await content(page, "sales.chart")).match(/size (\d+) (\d+)/);
  expect(+size[1]).toBeLessThan(640);
  expect(+size[2]).toBeLessThan(400);
});

test("markdown: ![](x.chart) embeds, ```chart blocks render and edit in the overlay", async ({ page }) => {
  await openApp(page);
  await page.evaluate(async (csv) => {
    await createNote("sales.csv", csv);
    await createNote("s.chart", "chart 1\ndata sales.csv\n");
    await createNote("doc.md", "![](s.chart)\n\n```chart\ntype pie\ndata\na,v\nx,1\ny,3\n```\n");
    switchMdTab("view");
  }, SALES);
  await expect(page.locator(".md-preview .draw-embed svg")).toHaveCount(2);
  await page.locator(".block-edit").hover();
  await page.click(".block-edit-btn");
  await expect(page.locator("#blockOverlay .chart-host")).toBeVisible();
  await page.click('#blockOverlay .chart-types [data-type="donut"]');
  await page.click('[data-block="done"]');
  expect(await content(page, "doc.md")).toBe("![](s.chart)\n\n```chart\ntype donut\ndata\na,v\nx,1\ny,3\n```\n");
  await expect(page.locator("#chartHost")).toBeHidden();
});

test("a chart downloads as SVG", async ({ page }) => {
  await withChart(page, "chart 1\ndata sales.csv\n");
  const dl = page.waitForEvent("download");
  await page.evaluate(() => drawDownloadSvg());
  expect((await dl).suggestedFilename()).toBe("sales.svg");
});
