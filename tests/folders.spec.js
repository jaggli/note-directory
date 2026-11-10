const { test, expect, openApp } = require("./fixtures");

const names = (page) => page.evaluate(() => state.notes.map((n) => n.name).sort());
const content = (page, name) => page.evaluate((n) => state.notes.find((x) => x.name === n).content, name);
const row = (page, dir) => page.locator(`#noteList .folder-item[data-folder="${dir}"]`);

async function setup(page, notes) {
  await openApp(page);
  await page.evaluate(async (notes) => {
    for (const [name, content] of notes) await createNote(name, content);
  }, notes);
}

test("path helpers: resolve, relative links, clean paths", async ({ page }) => {
  await openApp(page);
  const r = await page.evaluate(() => [
    resolveRef("a/b/x.md", "../c.md"),
    resolveRef("a/b/x.md", "/top.md"),
    resolveRef("x.md", "../../up.md"),
    resolveRef("a/x.md", "my%20file.md"),
    relRef("a/b/", "a/c/d.md"),
    relRef("", "a/d.md"),
    relRef("a/", "my file.md"),
    cleanPath("a\\b/./c//d"),
    getExtension("v1.2/notes"),
    uniqueName("v1.2/notes"),
  ]);
  expect(r).toEqual(["a/c.md", "top.md", "up.md", "a/my file.md", "../c/d.md", "a/d.md", "../my%20file.md", "a/b/c/d", "", "v1.2/notes1"]);
});

test("the sidebar shows folders as a tree; folders close and stay closed", async ({ page }) => {
  await setup(page, [["projects/q3/plan.md", "p"], ["projects/notes.md", "n"], ["top.md", "t"]]);
  await expect(row(page, "projects/")).toBeVisible();
  await expect(row(page, "projects/q3/")).toBeVisible();
  await expect(page.locator("#noteList .note-item:not(.folder-item) .note-item-name").filter({ hasText: "plan" })).toHaveText("plan.md");
  await row(page, "projects/").click();
  await expect(row(page, "projects/q3/")).toHaveCount(0);
  await page.reload();
  await page.waitForFunction(() => document.querySelector(".note-item"));
  await expect(row(page, "projects/q3/")).toHaveCount(0);
});

test("renaming a note keeps its folder; a slash moves it", async ({ page }) => {
  await setup(page, [["a/x.md", "x"]]);
  await page.evaluate(() => renameNote(getActiveNote(), "y.md"));
  expect(await names(page)).toContain("a/y.md");
  await page.evaluate(() => renameNote(getActiveNote(), "b/z.md"));
  expect(await names(page)).toContain("a/b/z.md");
  await page.evaluate(() => renameNote(getActiveNote(), "/top.md"));
  expect(await names(page)).toContain("top.md");
});

test("moving and renaming rewrite links to and from the moved notes", async ({ page }) => {
  await setup(page, [
    ["data.csv", "a,b\n"],
    ["pics/arch.draw", ""],
    ["report.md", "![](data.csv) ![](pics/arch.draw) [plan](docs/plan.md#goals)\n```\n[code](data.csv)\n```\n[web](https://x.y/data.csv)"],
    ["docs/plan.md", "[back](../report.md) ![](../data.csv)"],
  ]);
  await page.evaluate(() => renameFolder("pics/", "images/"));
  expect(await content(page, "report.md")).toContain("![](images/arch.draw)");
  await page.evaluate(() => moveNotesTo([state.notes.find((n) => n.name === "report.md")], "docs/"));
  expect(await content(page, "docs/report.md")).toBe(
    "![](../data.csv) ![](../images/arch.draw) [plan](plan.md#goals)\n```\n[code](data.csv)\n```\n[web](https://x.y/data.csv)",
  );
  expect(await content(page, "docs/plan.md")).toBe("[back](report.md) ![](../data.csv)");
  await page.evaluate(() => moveNotesTo([state.notes.find((n) => n.name === "data.csv")], "docs/"));
  expect(await content(page, "docs/plan.md")).toBe("[back](report.md) ![](data.csv)");
});

test("links and embeds resolve relative to their note", async ({ page }) => {
  await setup(page, [["docs/data.csv", "x,y\n1,2\n"], ["docs/plan.md", "![](data.csv)\n\n[up](../top.md)"], ["top.md", "t"]]);
  await page.evaluate(() => {
    switchNote(state.notes.find((n) => n.name === "docs/plan.md").id);
    switchMdTab("view");
  });
  await expect(page.locator("#mdPreview figure.csv-embed td")).toHaveText(["1", "2"]);
  await page.locator("#mdPreview a", { hasText: "up" }).click();
  expect(await page.evaluate(() => getActiveNote().name)).toBe("top.md");
});

test("a folder moves into another by drag; not into itself", async ({ page }) => {
  await setup(page, [["a/x.md", "x"], ["b/y.md", "y"]]);
  await row(page, "a/").dragTo(row(page, "b/"));
  expect(await names(page)).toEqual(expect.arrayContaining(["b/a/x.md", "b/y.md"]));
  expect(await names(page)).not.toContain("a/x.md");
  await row(page, "b/").dragTo(row(page, "b/a/"));
  await expect(page.locator(".toast").last()).toContainText("can't go into itself");
});

test("a note dragged onto a folder moves into it", async ({ page }) => {
  await setup(page, [["f/x.md", "x"], ["loose.md", "l"]]);
  const loose = page.locator('#noteList .note-item:not(.folder-item)', { hasText: "loose" });
  await loose.dragTo(row(page, "f/"));
  expect(await names(page)).toContain("f/loose.md");
});

test("new folder, rename it, it stays while empty", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => newFolder());
  const input = page.locator("#noteList .folder-item .note-item-input");
  await input.fill("Ideas");
  await input.press("Enter");
  await expect(row(page, "Ideas/")).toBeVisible();
  await page.reload();
  await page.waitForFunction(() => document.querySelector(".note-item"));
  await expect(row(page, "Ideas/")).toBeVisible();
});

test("deleting a folder deletes what's in it, and undo brings it all back", async ({ page }) => {
  await setup(page, [["f/a.md", "a"], ["f/g/b.md", "b"], ["keep.md", "k"]]);
  await page.evaluate(() => deleteFolder("f/"));
  await expect(page.locator(".toast").last()).toContainText("Deleted f and 2 notes in it");
  expect((await names(page)).filter((n) => n.startsWith("f/"))).toEqual([]);
  await expect(row(page, "f/")).toHaveCount(0);
  await page.locator(".toast .toast-act").last().click();
  expect((await names(page)).filter((n) => n.startsWith("f/"))).toEqual(["f/a.md", "f/g/b.md"]);
});

test("backlinks: the menu lists where a note is used, delete says so", async ({ page }) => {
  await setup(page, [["data.csv", "a\n"], ["r.md", "![](data.csv)"]]);
  const data = await page.evaluate(() => state.notes.find((n) => n.name === "data.csv").id);
  await page.evaluate((id) => openNoteMenu(state.notes.find((n) => n.id === id), null, { x: 100, y: 100 }), data);
  await expect(page.locator("#noteMenu .menu-label")).toHaveText("Used in");
  await expect(page.locator('#noteMenu [data-note-act^="open:"]')).toHaveText("r.md");
  await page.keyboard.press("Escape");
  await page.evaluate((id) => deleteNote(id), data);
  await expect(page.locator(".toast").last()).toContainText("Deleted data.csv — used in r.md");
});

test("search in a folder finds only notes in it", async ({ page }) => {
  await setup(page, [["f/a.md", "needle"], ["b.md", "needle"]]);
  await page.evaluate(() => openSearch("folder:f/", "needle"));
  await expect(page.locator("#searchScope")).toContainText("f/");
  await expect(page.locator(".search-result-name")).toHaveText(["f/a.md"]);
});

test("zip export of a folder holds that folder; importing it keeps it", async ({ page }) => {
  await setup(page, [["p/q/a.md", "a"], ["p/b.md", "b"], ["other.md", "o"]]);
  const zipped = await page.evaluate(async () => {
    let blob;
    const orig = window.triggerDownload;
    window.triggerDownload = (b) => (blob = b);
    await downloadAll(notesIn("p/q/"), "q.zip", parentOf("p/q/"));
    window.triggerDownload = orig;
    const entries = await readZip(await blob.arrayBuffer());
    return entries.map((e) => e.name).filter((n) => n !== ".note.directory");
  });
  expect(zipped).toEqual(["q/a.md"]);
  await page.evaluate(async () => {
    const zip = await buildZip([{ name: "trip/day1.md", content: "1" }, { name: "trip/maps/m.draw", content: "" }]);
    await importFiles([new File([zip], "trip.zip", { type: "application/zip" })]);
  });
  expect(await names(page)).toEqual(expect.arrayContaining(["trip/day1.md", "trip/maps/m.draw"]));
});

test("share links and downloads use the file name, not its folder", async ({ page }) => {
  await setup(page, [["deep/dir/n.md", "hi"]]);
  const url = await page.evaluate(() => shareLink(getActiveNote()));
  expect(decodeURIComponent(url)).toContain("name=n.md");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.evaluate(() => downloadNote())]);
  expect(dl.suggestedFilename()).toBe("n.md");
});
