import { defineConfig } from "@playwright/test";
import os from "node:os";
import path from "node:path";

export default defineConfig({
  workers: 1,
  testDir: "./tests/browser",
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR || path.join(os.tmpdir(), `sprinkler-playwright-${process.pid}`),
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
