import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import request from "supertest";

import { createApp, createSyntheticController } from "../app.js";

async function tempDataPath(data = { schedules: {}, history: [], operations: {} }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sprinkler-final-systems-"));
  const file = path.join(dir, "data.json");
  await fs.writeFile(file, JSON.stringify(data), { mode: 0o600 });
  return file;
}

async function listen(app) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function close(server) {
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

const manual = (requestId) => ({ requestId, zones: [1], runTime: 5 });

function cooperativeStall(state) {
  return async (url, init = {}) => {
    state.calls += 1;
    state.active += 1;
    if (init.signal) state.signals += 1;
    return new Promise((resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        state.aborts += 1;
        state.active -= 1;
        reject(init.signal.reason ?? new DOMException("Aborted", "AbortError"));
      }, { once: true });
    });
  };
}

test("controller deadline causally aborts 50 cooperative mutations and drains every active call", async () => {
  const state = { calls: 0, active: 0, signals: 0, aborts: 0 };
  const instance = await createApp({
    dataPath: await tempDataPath(),
    controllerFetch: cooperativeStall(state),
    controllerTimeoutMs: 15,
    controllerMaxConcurrent: 64,
  });
  const { server, origin } = await listen(instance.app);
  try {
    const responses = await Promise.all(Array.from({ length: 50 }, (_, index) => fetch(`${origin}/api/tasks/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(manual(`abort-probe-${String(index).padStart(4, "0")}`)),
    })));
    assert.deepEqual([...new Set(responses.map(({ status }) => status))], [202]);
    assert.equal(state.calls, 50);
    assert.equal(state.signals, 50);
    assert.equal(state.aborts, 50);
    assert.equal(state.active, 0);
    assert.deepEqual(instance.controllerWorkState(), { activeCalls: 0, admitted: 0, shuttingDown: false });
  } finally {
    await close(server);
    await instance.cleanup();
  }
});

test("late resolve and reject after abort cannot complete durable mutations or create unhandled work", async () => {
  let calls = 0;
  const late = async (url, init = {}) => new Promise((resolve, reject) => {
    const call = calls++;
    init.signal.addEventListener("abort", () => setTimeout(() => {
      if (call === 0) resolve(Response.json({ success: true }));
      else reject(new Error("late rejection"));
    }, 10), { once: true });
  });
  const dataPath = await tempDataPath();
  const instance = await createApp({ dataPath, controllerFetch: late, controllerTimeoutMs: 10, controllerMaxConcurrent: 2 });
  const { server, origin } = await listen(instance.app);
  try {
    for (const id of ["late-resolve-0001", "late-reject-0002"]) {
      const response = await fetch(`${origin}/api/tasks/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(manual(id)),
      });
      assert.equal(response.status, 202);
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
    const stored = JSON.parse(await fs.readFile(dataPath, "utf8"));
    assert.deepEqual(Object.values(stored.operations).map(({ state }) => state), ["outcome_unknown", "outcome_unknown"]);
    assert.ok(stored.history.every(({ event }) => event === "Outcome unknown"));
    assert.deepEqual(instance.controllerWorkState(), { activeCalls: 0, admitted: 0, shuttingDown: false });
  } finally {
    await close(server);
    await instance.cleanup();
  }
});

test("ignored abort retains bounded admission and reports definitive pre-contact overload without fan-out", async () => {
  let calls = 0;
  let signals = 0;
  const ignoredAbort = async (url, init = {}) => {
    calls += 1;
    if (init.signal) signals += 1;
    return new Promise(() => {});
  };
  const dataPath = await tempDataPath();
  const instance = await createApp({
    dataPath,
    controllerFetch: ignoredAbort,
    controllerTimeoutMs: 10,
    controllerMaxConcurrent: 2,
    controllerShutdownDrainMs: 10,
  });
  const { server, origin } = await listen(instance.app);
  try {
    const first = await Promise.all([0, 1].map((index) => fetch(`${origin}/api/tasks/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(manual(`ignored-abort-${index}-0001`)),
    })));
    assert.deepEqual(first.map(({ status }) => status), [202, 202]);
    const overloaded = await Promise.all(Array.from({ length: 12 }, (_, index) => fetch(`${origin}/api/tasks/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(manual(`saturated-${String(index).padStart(4, "0")}`)),
    })));
    assert.ok(overloaded.every(({ status }) => status === 503));
    for (const response of overloaded) {
      assert.equal(response.headers.get("retry-after"), "1");
      assert.equal((await response.json()).outcome, "not_applied");
    }
    assert.equal(calls, 2);
    assert.equal(signals, 2);
    assert.deepEqual(instance.controllerWorkState(), { activeCalls: 2, admitted: 2, shuttingDown: false });
    const stored = JSON.parse(await fs.readFile(dataPath, "utf8"));
    assert.equal(Object.keys(stored.operations).length, 2, "overload must not durably claim work that never contacted the controller");
  } finally {
    await close(server);
    await instance.cleanup();
  }
});

test("cleanup aborts and drains owned cooperative calls while preserving exactly-once reconciliation", async () => {
  const state = { calls: 0, active: 0, signals: 0, aborts: 0 };
  const dataPath = await tempDataPath();
  const instance = await createApp({ dataPath, controllerFetch: cooperativeStall(state), controllerTimeoutMs: 1000 });
  const live = await listen(instance.app);
  const pending = fetch(`${live.origin}/api/tasks/create`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(manual("shutdown-abort-0001")),
  });
  while (state.active === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  await instance.cleanup();
  const response = await pending;
  assert.equal(response.status, 202);
  assert.equal(state.aborts, 1);
  assert.equal(state.active, 0);
  assert.deepEqual(instance.controllerWorkState(), { activeCalls: 0, admitted: 0, shuttingDown: true });
  await close(live.server);
  const replayInstance = await createApp({ dataPath, controllerFetch: async () => { state.calls += 1; return Response.json({ success: true }); } });
  const replayLive = await listen(replayInstance.app);
  assert.equal((await fetch(`${replayLive.origin}/api/tasks/create`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(manual("shutdown-abort-0001")),
  })).status, 202);
  assert.equal(state.calls, 1, "reconciliation must not resend after shutdown ambiguity");
  await close(replayLive.server);
  await replayInstance.cleanup();
});

test("native HTTP controller fetch receives deadline cancellation and closes its localhost request", async () => {
  let started;
  const contacted = new Promise((resolve) => { started = resolve; });
  let closed;
  const disconnected = new Promise((resolve) => { closed = resolve; });
  const controller = http.createServer((req) => {
    started();
    req.once("close", closed);
  });
  controller.listen(0, "127.0.0.1");
  await new Promise((resolve) => controller.once("listening", resolve));
  const instance = await createApp({
    dataPath: await tempDataPath(),
    controllerHost: `http://127.0.0.1:${controller.address().port}`,
    controllerTimeoutMs: 20,
  });
  const live = await listen(instance.app);
  try {
    const pending = fetch(`${live.origin}/api/tasks/create`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(manual("native-fetch-abort-0001")),
    });
    await contacted;
    assert.equal((await pending).status, 202);
    await Promise.race([disconnected, new Promise((_, reject) => setTimeout(() => reject(new Error("controller socket did not close")), 500))]);
    assert.deepEqual(instance.controllerWorkState(), { activeCalls: 0, admitted: 0, shuttingDown: false });
  } finally {
    await close(live.server);
    await instance.cleanup();
    await close(controller);
  }
});

test("synthetic controller honors an already-aborted controller contract without mutating state", async () => {
  const controller = createSyntheticController(() => 100);
  const abort = new AbortController();
  abort.abort(new Error("stop"));
  await assert.rejects(controller("/tasks/add", {
    method: "POST",
    body: JSON.stringify({ tasks: [{ zones: [1], runTime: 5 }] }),
    signal: abort.signal,
  }), /stop|abort/i);
  assert.equal((await (await controller("/tasks")).json()).tasks.length, 2);
});

test("Stop and scheduler controller mutations both receive abort and preserve unknown exactly-once state", async () => {
  const aborts = [];
  let adds = 0;
  let deletes = 0;
  const controllerFetch = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/tasks" && !init.method) {
      return Response.json({ tasks: [{ id: "abort-stop-task", zones: [4], runTime: 5, startTime: 1 }] });
    }
    if (parsed.pathname === "/tasks/add") adds += 1;
    if (parsed.pathname === "/tasks/delete") deletes += 1;
    return new Promise((resolve, reject) => init.signal.addEventListener("abort", () => {
      aborts.push(parsed.pathname);
      reject(init.signal.reason);
    }, { once: true }));
  };

  const stopPath = await tempDataPath();
  const stop = await createApp({ dataPath: stopPath, controllerFetch, controllerTimeoutMs: 10 });
  const stopLive = await listen(stop.app);
  const stopBody = { id: "abort-stop-task", requestId: "abort-stop-operation-0001" };
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.equal((await fetch(`${stopLive.origin}/api/tasks/delete`, {
        method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(stopBody),
      })).status, 202);
    }
    assert.equal(deletes, 1);
    assert.equal(JSON.parse(await fs.readFile(stopPath, "utf8")).operations[stopBody.requestId].state, "outcome_unknown");
  } finally {
    await close(stopLive.server);
    await stop.cleanup();
  }

  const now = new Date(2026, 7, 8, 6, 30, 5);
  const schedulePath = await tempDataPath({
    schedules: {
      deadline: {
        name: "Abort schedule",
        days: [now.getDay()],
        startTime: "06:30",
        tasks: [{ zones: [2], runTime: 5 }],
        enabled: true,
        lastRun: null,
      },
    },
    history: [],
    operations: {},
  });
  const scheduler = await createApp({ dataPath: schedulePath, controllerFetch, controllerTimeoutMs: 10 });
  await scheduler.runScheduleTick(now);
  await scheduler.runScheduleTick(now);
  assert.equal(adds, 1);
  assert.equal(Object.values(JSON.parse(await fs.readFile(schedulePath, "utf8")).operations)[0].state, "outcome_unknown");
  assert.deepEqual(aborts, ["/tasks/delete", "/tasks/add"]);
  await scheduler.cleanup();
});

const mutationRoutes = [
  ["post", "/api/schedules/create"],
  ["put", "/api/schedules/update"],
  ["delete", "/api/schedules/delete"],
  ["post", "/api/history/create"],
  ["post", "/api/tasks/create"],
  ["delete", "/api/tasks/delete"],
  ["post", "/api/zones"],
];

test("every mutation route rejects malformed, null, scheme, port and cross-host origins", async () => {
  const instance = await createApp({ dataPath: await tempDataPath(), demo: true, allowSyntheticTestOrigin: true });
  const { server, origin } = await listen(instance.app);
  const port = new URL(origin).port;
  try {
    for (const [method, route] of mutationRoutes) {
      for (const badOrigin of [
        `https://127.0.0.1:${port}`,
        "http://127.0.0.1:1",
        `http://localhost:${port}`,
        "null",
        "not a URL",
      ]) {
        const response = await request(origin)[method](route).set("Origin", badOrigin).send({});
        assert.equal(response.status, 403, `${method.toUpperCase()} ${route} accepted ${badOrigin}`);
      }
    }
  } finally {
    await close(server);
    await instance.cleanup();
  }
});

test("direct same-origin and absent Origin remain allowed without trusting forwarded scheme", async () => {
  const instance = await createApp({ dataPath: await tempDataPath(), demo: true, allowSyntheticTestOrigin: true });
  const { server, origin } = await listen(instance.app);
  try {
    await request(origin).post("/api/tasks/create").set("Origin", origin).send(manual("same-origin-allowed-0001")).expect(201);
    await request(origin).post("/api/tasks/create").send(manual("absent-origin-allowed-0002")).expect(201);
    await request(origin).post("/api/tasks/create")
      .set("Origin", origin.replace("http:", "https:"))
      .set("X-Forwarded-Proto", "https")
      .send(manual("forwarded-origin-denied-0003"))
      .expect(403);
  } finally {
    await close(server);
    await instance.cleanup();
  }
});

test("configured public origins normalize case, default ports and IPv6 while remaining independent of Host", async () => {
  const configured = await createApp({ dataPath: await tempDataPath(), demo: true, publicOrigin: "HTTPS://Example.COM:443" });
  const configuredLive = await listen(configured.app);
  await request(configuredLive.origin).post("/api/zones").set("Host", "attacker.invalid").set("Origin", "https://example.com").send({ zone: 1, on: true }).expect(409);
  await request(configuredLive.origin).post("/api/zones").set("Origin", "https://example.com:444").send({}).expect(403);
  await request(configuredLive.origin).post("/api/zones").set("Origin", "http://example.com").send({}).expect(403);
  await close(configuredLive.server);
  await configured.cleanup();

  const ipv6 = await createApp({ dataPath: await tempDataPath(), demo: true, publicOrigin: "https://[::1]:443" });
  const ipv6Live = await listen(ipv6.app);
  await request(ipv6Live.origin).post("/api/zones").set("Origin", "https://[::1]").send({ zone: 1, on: true }).expect(409);
  await request(ipv6Live.origin).post("/api/zones").set("Origin", "https://[::1]:444").send({}).expect(403);
  await close(ipv6Live.server);
  await ipv6.cleanup();
});
