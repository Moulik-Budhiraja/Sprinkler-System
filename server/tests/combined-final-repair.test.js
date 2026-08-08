import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createApp, resolveStartupConfig } from "../app.js";

async function tempDataPath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sprinkler-combined-repair-"));
  const file = path.join(dir, "data.json");
  await fs.writeFile(file, JSON.stringify({ schedules: {}, history: [], operations: {} }), { mode: 0o600 });
  return file;
}

async function bound(instance) {
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await instance.cleanup();
    },
  };
}

const manual = (requestId) => ({ requestId, zones: [1], runTime: 5 });

test("controller startup requires one canonical explicit public origin before app creation", async () => {
  for (const value of [undefined, "", "not a URL", "ftp://yard.test", "http://user@yard.test", "http://yard.test/path", "http://yard.test/?query=1", "http://yard.test/#hash"]) {
    assert.throws(() => resolveStartupConfig({ SPRINKLER_DEMO: "0", SPRINKLER_PUBLIC_ORIGIN: value }), /SPRINKLER_PUBLIC_ORIGIN/);
  }
  assert.deepEqual(resolveStartupConfig({ SPRINKLER_DEMO: "0", SPRINKLER_PUBLIC_ORIGIN: "HTTPS://YARD.TEST:443" }), {
    demo: false,
    publicOrigin: "https://yard.test",
  });
  const startupSource = await fs.readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(startupSource, /const startup = resolveStartupConfig\(\);\s*const instance = await createApp\(startup\);[\s\S]*instance\.app\.listen/);
});

test("browser mutation origins use only canonical public origin while absent Origin remains an API-client contract", async () => {
  const instance = await createApp({
    dataPath: await tempDataPath(),
    demo: true,
    publicOrigin: "https://yard.test:443",
  });
  const client = await bound(instance);
  try {
    const attempts = [
      { origin: "http://attacker.invalid", host: "attacker.invalid" },
      { origin: "https://yard.test:444", host: "yard.test" },
      { origin: "http://yard.test", host: "yard.test" },
      { origin: "null", host: "yard.test" },
      { origin: "not a URL", host: "yard.test", forwarded: "https" },
      { origin: "https://yard.test/path", host: "yard.test" },
    ];
    for (const [index, attempt] of attempts.entries()) {
      const response = await fetch(`${client.origin}/api/tasks/create`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: attempt.host,
          Origin: attempt.origin,
          "X-Forwarded-Proto": attempt.forwarded ?? "https",
          "X-Forwarded-Host": "yard.test",
        },
        body: JSON.stringify(manual(`origin-denied-${String(index).padStart(4, "0")}`)),
      });
      assert.equal(response.status, 403);
    }
    const accepted = await fetch(`${client.origin}/api/tasks/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: "attacker.invalid", Origin: "https://YARD.TEST:443" },
      body: JSON.stringify(manual("origin-accepted-0001")),
    });
    assert.equal(accepted.status, 201);
    const apiClient = await fetch(`${client.origin}/api/tasks/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: "attacker.invalid" },
      body: JSON.stringify(manual("absent-origin-0002")),
    });
    assert.equal(apiClient.status, 201);
  } finally {
    await client.close();
  }
});

test("Compose explicitly forwards fail-closed demo mode and public origin", async () => {
  const compose = await fs.readFile(new URL("../docker-compose.yml", import.meta.url), "utf8");
  assert.match(compose, /SPRINKLER_DEMO:\s*\$\{SPRINKLER_DEMO:\?/);
  assert.match(compose, /SPRINKLER_PUBLIC_ORIGIN:\s*\$\{SPRINKLER_PUBLIC_ORIGIN:-\}/);
  assert.doesNotMatch(compose, /SPRINKLER_TEST_ORIGIN/);
  for (const invalid of [undefined, "", "true", "false", "2", "01"]) {
    assert.throws(() => resolveStartupConfig({ SPRINKLER_DEMO: invalid }), /SPRINKLER_DEMO/);
  }
});

test("synthetic demo always owns an in-memory controller regardless of controller environment", async () => {
  let contacted = 0;
  const instance = await createApp({
    demo: true,
    controllerHost: "http://hardware.invalid",
    controllerFetch: async () => { contacted += 1; throw new Error("must not contact injected controller"); },
  });
  const client = await bound(instance);
  try {
    const response = await fetch(`${client.origin}/api/tasks`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).tasks.length, 2);
    assert.equal(contacted, 0);
    assert.match(instance.dataPath, /sprinkler-demo-/);
  } finally {
    await client.close();
  }
});
test("Playwright runtime screenshots use disposable test output and never tracked screenshot paths", async () => {
  const layout = await fs.readFile(new URL("browser/layout.spec.js", import.meta.url), "utf8");
  const config = await fs.readFile(new URL("../playwright.config.js", import.meta.url), "utf8");
  assert.doesNotMatch(layout, /screenshots\/v4-local|const shots|fs\.mkdir\(shots/);
  assert.match(layout, /testInfo\.outputPath\(/);
  assert.match(config, /outputDir:[^\n]*os\.tmpdir\(\)/);
});

test("saturated task reads return a read-overload contract without mutation guidance", async () => {
  const instance = await createApp({
    dataPath: await tempDataPath(),
    controllerFetch: async () => new Promise(() => {}),
    controllerTimeoutMs: 5,
    controllerMaxConcurrent: 1,
    controllerShutdownDrainMs: 5,
  });
  const client = await bound(instance);
  try {
    const mutation = await fetch(`${client.origin}/api/tasks/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(manual("read-overload-holder-0001")),
    });
    assert.equal(mutation.status, 202);
    const response = await fetch(`${client.origin}/api/tasks`);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "1");
    const body = await response.json();
    assert.deepEqual(body, {
      error: "controller busy",
      kind: "read_overload",
      recovery: "Try again shortly.",
    });
    assert.equal("outcome" in body, false);
    assert.equal("requestId" in body, false);
  } finally {
    await client.close();
  }
});

test("controller-abort regressions use only explicitly bound per-instance clients", async () => {
  const source = await fs.readFile(new URL("final-systems-repair.test.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /request\([^)]*\.app\)/);
});

test("test-origin mode is explicit, synthetic-only, and cannot enable controller mode", () => {
  assert.deepEqual(resolveStartupConfig({ SPRINKLER_DEMO: "1", SPRINKLER_TEST_ORIGIN: "1" }), {
    demo: true,
    publicOrigin: null,
    allowSyntheticTestOrigin: true,
  });
  assert.throws(() => resolveStartupConfig({
    SPRINKLER_DEMO: "0",
    SPRINKLER_TEST_ORIGIN: "1",
    SPRINKLER_PUBLIC_ORIGIN: "http://yard.test",
  }), /synthetic demo/);
});
