const { test, expect, openApp } = require("./fixtures");

test("markdown links only allow safe schemes", async ({ page }) => {
  await openApp(page);
  const cases = {
    "[a](javascript\\:alert\\(1\\))": null,
    "[a](javascript\\:alert%281%29)": null,
    "[a](`javascript\\:x`)": null,
    "[a](JaVa\tScRiPt\\:x)": null,
    "[a](data\\:text/html,x)": null,
    "[a](vbscript\\:x)": null,
    "[a](https://example.com/x?a=1&b=2)": "https://example.com/x?a=1&b=2",
    "[a](mailto:me@x.ch)": "mailto:me@x.ch",
    "[a](#heading)": "#heading",
    "[a](other-note.md)": "other-note.md",
  };
  const hrefs = await page.evaluate((srcs) => {
    const div = document.createElement("div");
    return srcs.map((src) => {
      div.innerHTML = renderMarkdown(src);
      return div.querySelector("a").getAttribute("href");
    });
  }, Object.keys(cases));
  expect(hrefs).toEqual(Object.values(cases));
});

test("clicking a malicious link in a shared zen note runs nothing", async ({
  page,
}) => {
  await openApp(page);
  let dialogs = 0;
  page.on("dialog", (d) => (dialogs++, d.dismiss()));
  await page.evaluate(async () => {
    await createNote("xss.md", "[click me](javascript\\:alert\\(1\\))\n");
    switchMdTab("zen");
  });
  await page.locator("#mdPreview a", { hasText: "click me" }).click();
  await page.waitForTimeout(200);
  expect(dialogs).toBe(0);
});

test("CSP blocks javascript: URLs and inline handlers", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => {
    window.pwned = 0;
    const a = document.createElement("a");
    a.href = "javascript:window.pwned=1";
    a.textContent = "x";
    const b = document.createElement("button");
    b.setAttribute("onclick", "window.pwned=2");
    b.textContent = "y";
    document.body.append(a, b);
  });
  await page.click('a[href^="javascript"]');
  await page.click("button[onclick]");
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.pwned)).toBe(0);
});

test("Google sign-in script is allowed by CSP", async ({ page }) => {
  await openApp(page);
  expect(await page.evaluate(() => loadGIS().then(() => "loaded"))).toBe(
    "loaded",
  );
});

test("malformed URL hash does not break startup", async ({ page }) => {
  await openApp(page, "/#%");
});
