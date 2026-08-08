import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: "http://127.0.0.1:4178",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    reducedMotion: "reduce",
  },
  webServer: {
    command: "node tests/fixture-server.js",
    url: "http://127.0.0.1:4178/healthz",
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
