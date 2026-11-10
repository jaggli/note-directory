const { test, expect, openApp } = require("./fixtures");

const names = (page) => page.evaluate(() => state.notes.map((n) => n.name).sort());

test("a note shared with its parts: one link, the recipient chooses to add them", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openApp(page);
  await page.evaluate(async () => {
    await createNote("r/data/sales.csv", "q,v\nQ1,1\n", false, undefined, { csvHeader: false });
    await createNote("r/sales.chart", "chart 1\ndata data/sales.csv\n");
    await createNote("r/report.md", "# R\n\n![](sales.chart)\n\n[unrelated](other.md)\n");
    await createNote("r/other.md", "o");
  });
  await page.evaluate(() => switchNote(state.notes.find((n) => n.name === "r/report.md").id));
  await page.click("#btnShare");
  await expect(page.locator("#sharePop .share-parts input")).toBeChecked();
  await expect(page.locator("#sharePop")).toContainText("3 files");
  await expect(page.locator("#sharePop input[readonly]")).toHaveValue(/#files=/);
  await page.click('#sharePop [data-share="copy-bundle"]');
  const url = await page.evaluate(() => navigator.clipboard.readText());
  expect(url).toContain("#files=");

  // Only this note: the usual link
  await page.click("#btnShare");
  await page.locator("#sharePop .share-parts input").uncheck();
  await expect(page.locator('#sharePop [data-share="copy"]')).toBeVisible();

  // Another browser opens it
  const other = await context.newPage();
  await other.goto(url.replace(/^https?:\/\/[^/]+/, ""));
  await expect(other.locator("#modalText")).toContainText("3 files");
  await other.click("#modalConfirm");
  await expect.poll(() => names(other)).toEqual(expect.arrayContaining(["data/sales.csv", "report.md", "sales.chart"]));
  expect(await other.evaluate(() => getActiveNote().name)).toBe("report.md");
  expect(await other.evaluate(() => state.notes.find((n) => n.name === "data/sales.csv").csvHeader)).toBe(false);
  expect(other.url()).not.toContain("files=");
});

test("a folder shares as one link; too big, it offers a ZIP", async ({ page }) => {
  await openApp(page);
  await page.evaluate(async () => {
    await createNote("trip/plan.md", "go");
    await createNote("trip/map.draw", "draw 1\n");
  });
  await page.locator('#noteList .folder-item[data-folder="trip/"]').click({ button: "right" });
  await page.click('#noteMenu [data-folder-act="share"]');
  await expect(page.locator("#sharePop")).toContainText("2 files");
  const url = await page.locator("#sharePop input[readonly]").inputValue();
  const data = await page.evaluate(async (u) => JSON.parse(await decompress(new URL(u).hash.match(/files=([^&]+)/)[1])), url);
  expect(data.files.map((f) => f.name).sort()).toEqual(["trip/map.draw", "trip/plan.md"]);
  await page.keyboard.press("Escape");

  // Random text doesn't compress: well over the limit
  await page.evaluate(async () => {
    const big = Array.from({ length: 90000 }, () => Math.random().toString(36)[2]).join("");
    await createNote("trip/big.md", big);
  });
  await page.locator('#noteList .folder-item[data-folder="trip/"]').click({ button: "right" });
  await page.click('#noteMenu [data-folder-act="share"]');
  const dl = page.waitForEvent("download");
  await page.click('#sharePop [data-share="zip"]');
  expect((await dl).suggestedFilename()).toBe("trip.zip");
});

test("cancel adds nothing", async ({ page }) => {
  await openApp(page);
  const url = await page.evaluate(async () => {
    await createNote("x/a.md", "a");
    return bundleLink([state.notes.find((n) => n.name === "x/a.md")], null, "");
  });
  await page.evaluate(() => deleteNotes(state.notes.filter((n) => n.name === "x/a.md"), {}));
  await page.goto(url.replace(/^https?:\/\/[^/]+/, ""));
  await page.click("#modalCancel");
  expect(await names(page)).not.toContain("x/a.md");
});
