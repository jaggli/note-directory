const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "tests",
  // page.route can't see SW-served requests; pwa.spec.js opts back in
  use: { baseURL: "http://localhost:4173/", serviceWorkers: "block" },
  webServer: {
    command: "python3 -m http.server 4173",
    url: "http://localhost:4173/",
    reuseExistingServer: true,
    stderr: "ignore",
  },
});
