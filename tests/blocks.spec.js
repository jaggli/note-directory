const { test, expect, openApp } = require("./fixtures");

const content = (page) => page.evaluate(() => getActiveNote().content);

async function preview(page, text) {
  await openApp(page);
  await page.evaluate((t) => createNote("doc.md", t), text);
  await page.evaluate(() => switchMdTab("view"));
}

test("an inline table opens in the grid; edits go back into its block, one undo step", async ({ page }) => {
  await preview(page, "intro\n\n```csv\na,b\n1,2\n```\n\nend");
  await page.locator(".block-edit").hover();
  await page.click(".block-edit-btn");
  await expect(page.locator("#blockOverlay")).toBeVisible();
  await expect(page.locator("#blockOverlay .grid-host")).toBeVisible();
  await page.evaluate(() => Grid._state.opts.onCommit("a,b\n1,2\n3,4\n"));
  expect(await content(page)).toBe("intro\n\n```csv\na,b\n1,2\n3,4\n```\n\nend");
  await page.evaluate(() => Grid._state.opts.onCommit("a,b\n9,2\n3,4\n"));
  // Undo inside is the block's own
  await page.keyboard.press("ControlOrMeta+z");
  expect(await content(page)).toBe("intro\n\n```csv\na,b\n1,2\n3,4\n```\n\nend");
  // Header off → noheader on the fence
  await page.evaluate(() => Grid._state.opts.onHeader(false));
  expect(await content(page)).toContain("```csv noheader\n");
  await page.keyboard.press("Escape");
  await expect(page.locator("#blockOverlay")).toBeHidden();
  await expect(page.locator("#gridHost")).toBeHidden();
  await expect(page.locator(".md-preview td").filter({ hasText: "3" })).toBeVisible();
  // The whole session: one step back
  await page.evaluate(() => undo());
  expect(await content(page)).toBe("intro\n\n```csv\na,b\n1,2\n```\n\nend");
});

test("an inline drawing opens on the canvas; Done writes it back", async ({ page }) => {
  await preview(page, "```draw\ndraw 1\nrect 0 0 100 50\n```\n\n```draw\ndraw 1\n```");
  await page.locator(".block-edit").nth(1).hover();
  await page.locator(".block-edit-btn").nth(1).click();
  await expect(page.locator("#blockOverlay .draw-host")).toBeVisible();
  await page.evaluate(() => Draw._state.opts.onCommit("draw 1\nellipse 0 0 40 40\n"));
  await page.click('[data-block="done"]');
  expect(await content(page)).toBe("```draw\ndraw 1\nrect 0 0 100 50\n```\n\n```draw\ndraw 1\nellipse 0 0 40 40\n```");
  // A .draw file still opens on its canvas afterwards
  await page.evaluate(() => createNote("x.draw", "draw 1\n"));
  await expect(page.locator("#drawHost")).toBeVisible();
  await expect(page.locator("#blockOverlay")).toBeHidden();
});

test("no Edit buttons outside the open note's preview", async ({ page }) => {
  await openApp(page);
  const html = await page.evaluate(() => renderMarkdown("```csv\na\n```"));
  expect(html).not.toContain("block-edit");
});
