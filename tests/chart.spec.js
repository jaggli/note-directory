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

test("Add chart in a table makes one next to it on the selected columns", async ({ page }) => {
  await openApp(page);
  await page.evaluate((csv) => createNote("q/sales.csv", csv), SALES);
  await expect(page.locator("#gridHost .grid-scroll")).toBeVisible();
  await page.evaluate(() => {
    Grid._state.act = { r: 1, c: 2 };
    Grid._state.anc = { r: 1, c: 1 };
  });
  await page.click('#gridHost [data-g="chart"]');
  await expect.poll(() => content(page, "q/sales.chart")).toBe("chart 1\ndata sales.csv\ny north south\n");
  await expect(page.locator("#chartHost svg")).toBeVisible();
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
