const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "tests",
  use: { baseURL: "http://localhost:4173/" },
  webServer: {
    command: "python3 -m http.server 4173",
    url: "http://localhost:4173/",
    reuseExistingServer: true,
    stderr: "ignore",
  },
});
