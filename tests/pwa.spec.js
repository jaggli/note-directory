const { test, expect, openApp } = require("./fixtures");

test.use({ serviceWorkers: "allow" });

test("app opens offline after the first visit", async ({ page, context }) => {
  await openApp(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await context.setOffline(true);
  await openApp(page, "/?id=whatever");
});

test("manifest is installable", async ({ request }) => {
  const m = await (await request.get("/manifest.json")).json();
  expect(m.id).toBe("/");
  for (const icon of m.icons)
    expect((await request.get(icon.src)).ok(), icon.src).toBe(true);
  expect(m.icons.some((i) => i.purpose === "maskable")).toBe(true);
});
