const { defineConfig, devices } = require("@playwright/test");

// ALL_BROWSERS=1 also runs the storage tests in Firefox and WebKit (CI)
const engines = process.env.ALL_BROWSERS
  ? {
      projects: [
        { name: "chromium", use: { ...devices["Desktop Chrome"] } },
        ...["firefox", "webkit"].map((name) => ({
          name,
          testMatch: "storage.spec.js",
          use: { ...devices[name === "firefox" ? "Desktop Firefox" : "Desktop Safari"] },
        })),
      ],
    }
  : {};

module.exports = defineConfig({
  testDir: "tests",
  // page.route can't see SW-served requests; pwa.spec.js opts back in
  use: { baseURL: "http://localhost:4173/", serviceWorkers: "block" },
  ...engines,
  webServer: {
    command: "python3 -m http.server 4173",
    url: "http://localhost:4173/",
    reuseExistingServer: true,
    stderr: "ignore",
  },
});
