const base = require("@playwright/test");

// Fails any test that throws in the page
exports.test = base.test.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await use(page);
    base.expect(errors).toEqual([]);
  },
});
exports.expect = base.expect;

exports.openApp = async (page, path = "/") => {
  await page.goto(path);
  await page.waitForFunction(() => document.querySelector(".note-item"));
};
