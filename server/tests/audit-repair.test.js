import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import request from "supertest";

import { createApp } from "../app.js";

async function withBoundServer(app, work) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const address = server.address();
    return await work(request(`http://127.0.0.1:${address.port}`));
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function tempDataPath(data = { schedules: {}, history: [], operations: {} }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sprinkler-repair-test-"));
  const file = path.join(dir, "data.json");
  await fs.writeFile(file, JSON.stringify(data), { mode: 0o600 });
  return file;
}

function validSchedule(i = 1) {
  return {
    name: `Schedule ${i}`,
    days: [1, 3, 5],
    startTime: "06:30",
    tasks: [{ zones: [1, 8], runTime: 12 }],
  };
}

function committedThenLostController() {
  const state = { adds: 0, tasks: [] };
  const fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/tasks" && !init.method) return Response.json({ tasks: state.tasks });
    if (parsed.pathname === "/tasks/add") {
      state.adds += 1;
      const body = JSON.parse(init.body);
      state.tasks.push(...body.tasks.map((task, i) => ({ id: `committed-${state.adds}-${i}`, ...task, startTime: 0 })));
      return new Response("response-lost", { status: 200 });
    }
    if (parsed.pathname === "/tasks/delete") {
      const id = parsed.searchParams.get("id");
      state.tasks = state.tasks.filter((task) => task.id !== id);
      return Response.json({ success: true });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  };
  return { state, fetch };
}

function successfulController() {
  const state = { adds: 0, deletes: [], tasks: [] };
  const fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/tasks" && !init.method) return Response.json({ tasks: state.tasks });
    if (parsed.pathname === "/tasks/add") {
      state.adds += 1;
      const body = JSON.parse(init.body);
      state.tasks.push(...body.tasks.map((task, i) => ({ id: `task-${state.adds}-${i}`, ...task, startTime: 0 })));
      return Response.json({ success: true });
    }
    if (parsed.pathname === "/tasks/delete") {
      const id = parsed.searchParams.get("id");
      state.deletes.push(id);
      const existed = state.tasks.some((task) => task.id === id);
      state.tasks = state.tasks.filter((task) => task.id !== id);
      return Response.json(existed ? { success: true } : { error: "not found" }, { status: existed ? 200 : 404 });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  };
  return { state, fetch };
}

test("manual create persists intent and never resends the same request id after a lost response", async () => {
  const dataPath = await tempDataPath();
  const controller = committedThenLostController();
  const { app } = await createApp({ dataPath, controllerFetch: controller.fetch, controllerTimeoutMs: 100 });
  const payload = { requestId: "manual-20260808-0001", zones: [2, 7], runTime: 5 };

  await withBoundServer(app, async (client) => {
    const first = await client.post("/api/tasks/create").send(payload).expect(202);
    assert.equal(first.body.outcome, "unknown");
    assert.match(first.body.recovery, /check controller status/i);
    const second = await client.post("/api/tasks/create").send(payload).expect(202);
    assert.equal(second.body.operationId, first.body.operationId);
    assert.equal(controller.state.adds, 1, "same request id must never resend");

    const operation = await client.get(`/api/operations/${first.body.operationId}`).expect(200);
    assert.equal(operation.body.state, "outcome_unknown");
  });
  const stored = JSON.parse(await fs.readFile(dataPath, "utf8"));
  assert.equal(stored.history.length, 1);
  assert.equal(stored.history[0].event, "Outcome unknown");
});

test("manual request id rejects payload reuse and successful duplicate returns one durable result", async () => {
  const dataPath = await tempDataPath();
  const controller = successfulController();
  const { app } = await createApp({ dataPath, controllerFetch: controller.fetch });
  const requestId = "manual-20260808-0002";
  await withBoundServer(app, async (client) => {
    const first = await client.post("/api/tasks/create").send({ requestId, zones: [1], runTime: 10 }).expect(201);
    const second = await client.post("/api/tasks/create").send({ requestId, zones: [1], runTime: 10 }).expect(200);
    assert.equal(second.body.operationId, first.body.operationId);
    assert.equal(controller.state.adds, 1);
    await client.post("/api/tasks/create").send({ requestId, zones: [2], runTime: 10 }).expect(409);
  });
});

test("scheduled watering claims one durable operation before overlapping or lost-response execution", async () => {
  const now = new Date(2026, 7, 8, 6, 30, 5);
  const schedule = { ...validSchedule(1), days: [now.getDay()], enabled: true, lastRun: null };
  const dataPath = await tempDataPath({ schedules: { morning: schedule }, history: [], operations: {} });
  const controller = committedThenLostController();
  const instance = await createApp({ dataPath, controllerFetch: controller.fetch, controllerTimeoutMs: 100 });
  const secondProcessContract = await createApp({ dataPath, controllerFetch: controller.fetch, controllerTimeoutMs: 100 });

  await Promise.allSettled([instance.runScheduleTick(now), secondProcessContract.runScheduleTick(now)]);
  await instance.runScheduleTick(now);
  assert.equal(controller.state.adds, 1, "overlap or later ticks must not resend a claimed schedule occurrence");
  const stored = JSON.parse(await fs.readFile(dataPath, "utf8"));
  const operations = Object.values(stored.operations);
  assert.equal(operations.length, 1);
  assert.equal(operations[0].state, "outcome_unknown");
  assert.equal(stored.schedules.morning.lastRun, Math.floor(now.getTime() / 1000));
});

test("scheduler controller deadline releases the claim as outcome unknown without resend", async () => {
  const now = new Date(2026, 7, 8, 6, 30, 5);
  const schedule = { ...validSchedule(1), days: [now.getDay()], enabled: true, lastRun: null };
  const dataPath = await tempDataPath({ schedules: { deadline: schedule }, history: [], operations: {} });
  let calls = 0;
  const stalled = async () => { calls += 1; return new Promise(() => {}); };
  const instance = await createApp({ dataPath, controllerFetch: stalled, controllerTimeoutMs: 25 });
  const started = Date.now();
  await instance.runScheduleTick(now);
  assert.ok(Date.now() - started < 500, "controller deadline must bound the scheduler claim");
  await instance.runScheduleTick(now);
  assert.equal(calls, 1);
  const stored = JSON.parse(await fs.readFile(dataPath, "utf8"));
  assert.equal(Object.values(stored.operations)[0].state, "outcome_unknown");
});

test("mutation schemas reject invalid types, bounds, duplicates, inherited ids and unsafe history", async () => {
  const dataPath = await tempDataPath();
  const controller = successfulController();
  const { app } = await createApp({ dataPath, controllerFetch: controller.fetch });
  const invalidTasks = [
    {},
    { requestId: "x", zones: [], runTime: 5 },
    { requestId: "x", zones: [0], runTime: 5 },
    { requestId: "x", zones: [9], runTime: 5 },
    { requestId: "x", zones: [1, 1], runTime: 5 },
    { requestId: "x", zones: [1], runTime: 0 },
    { requestId: "x", zones: [1], runTime: 1441 },
    { requestId: "__proto__", zones: [1], runTime: 5 },
    { requestId: "request-extra-field", zones: [1], runTime: 5, retry: true },
  ];
  const invalidSchedules = [
    { ...validSchedule(), days: [1, 1] },
    { ...validSchedule(), days: [7] },
    { ...validSchedule(), startTime: "24:00" },
    { ...validSchedule(), tasks: [] },
    { ...validSchedule(), tasks: [{ zones: [1, 1], runTime: 5 }] },
    { ...validSchedule(), tasks: [{ zones: [1], runTime: 5, hidden: true }] },
    { ...validSchedule(), name: "" },
  ];
  await withBoundServer(app, async (client) => {
    for (const body of invalidTasks) await client.post("/api/tasks/create").send(body).expect(400);
    for (const body of invalidSchedules) await client.post("/api/schedules/create").send(body).expect(400);
    await client.put("/api/schedules/update").send({ id: "__proto__", ...validSchedule(), enabled: true }).expect(400);
    await client.post("/api/history/create").send({ zones: [1], event: "Controller exploded", reason: "Fake" }).expect(400);
  });
  assert.equal(controller.state.adds, 0);
});

test("serialized atomic repository preserves 48 concurrent acknowledged writes and restart state", async () => {
  const dataPath = await tempDataPath();
  const controller = successfulController();
  const one = await createApp({ dataPath, controllerFetch: controller.fetch });
  const creates = await withBoundServer(one.app, (client) => Promise.all(Array.from({ length: 48 }, (_, i) =>
    client.post("/api/schedules/create").send(validSchedule(i)).expect(201)
  )));
  assert.equal(new Set(creates.map((response) => response.body.id)).size, 48);

  const two = await createApp({ dataPath, controllerFetch: controller.fetch });
  await withBoundServer(two.app, async (client) => {
    const schedules = await client.get("/api/schedules").expect(200);
    assert.equal(Object.keys(schedules.body).length, 48);
    assert.deepEqual(Object.values(schedules.body).map((s) => s.name).sort(),
      Array.from({ length: 48 }, (_, i) => `Schedule ${i}`).sort());
  });
  const mode = (await fs.stat(dataPath)).mode & 0o777;
  assert.equal(mode & 0o077, 0, "datastore must remain private");
});

test("history ordering uses a monotonic sequence even when upgraded data is unsorted", async () => {
  const dataPath = await tempDataPath({
    schedules: {},
    operations: {},
    history: [
      { timestamp: 10, sequence: 1, zones: [1], event: "Started", reason: "Remote" },
      { timestamp: 20, sequence: 9, zones: [2], event: "Stopped", reason: "Remote" },
    ],
  });
  const { app } = await createApp({ dataPath, controllerFetch: successfulController().fetch });
  await withBoundServer(app, (client) => client.post("/api/history/create").send({ zones: [3], event: "Started", reason: "Remote" }).expect(201));
  const stored = JSON.parse(await fs.readFile(dataPath, "utf8"));
  assert.equal(stored.history[0].sequence, 10);
});

test("repository lock preserves writes from four overlapping processes", async () => {
  const dataPath = await tempDataPath();
  const childPath = path.resolve("tests/repository-child.mjs");
  const children = Array.from({ length: 4 }, (_, index) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [childPath, dataPath, `process-${index}`, "12"], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`child ${index} exited ${code}: ${stderr}`)));
  }));
  await Promise.all(children);
  const stored = JSON.parse(await fs.readFile(dataPath, "utf8"));
  assert.equal(Object.keys(stored.schedules).length, 48);
});

test("zone stop fails closed without deleting or rebuilding unrelated controller tasks", async () => {
  const dataPath = await tempDataPath();
  const controller = successfulController();
  controller.state.tasks = [
    { id: "running", zones: [1, 2], runTime: 20, startTime: 1 },
    { id: "queued", zones: [3], runTime: 10, startTime: 0 },
  ];
  const { app } = await createApp({ dataPath, controllerFetch: controller.fetch });
  await withBoundServer(app, async (client) => {
    const result = await client.post("/api/zones").send({ zone: 1, on: false }).expect(409);
    assert.match(result.body.error, /whole task/i);
  });
  assert.deepEqual(controller.state.deletes, []);
  assert.deepEqual(controller.state.tasks.map((task) => task.id), ["running", "queued"]);
});

test("overlapping whole-task stop with one request id forwards exactly once", async () => {
  const dataPath = await tempDataPath();
  const controller = successfulController();
  controller.state.tasks = [{ id: "running-once", zones: [4], runTime: 20, startTime: 1 }];
  const { app } = await createApp({ dataPath, controllerFetch: controller.fetch });
  const body = { id: "running-once", requestId: "delete-overlap-0001" };
  await withBoundServer(app, async (client) => {
    const [first, second] = await Promise.all([
      client.delete("/api/tasks/delete").send(body),
      client.delete("/api/tasks/delete").send(body),
    ]);
    assert.ok([200, 201, 202].includes(first.status));
    assert.ok([200, 201, 202].includes(second.status));
  });
  assert.equal(controller.state.deletes.length, 1);
});

test("demo instances own unique private stores, recover missing files and clean only their own store", async () => {
  const a = await createApp({ demo: true });
  const b = await createApp({ demo: true });
  assert.notEqual(a.dataPath, b.dataPath);
  assert.equal((await fs.stat(path.dirname(a.dataPath))).mode & 0o077, 0);
  await withBoundServer(a.app, async (aClient) => {
    await withBoundServer(b.app, async (bClient) => {
      await aClient.post("/api/schedules/create").send(validSchedule(1)).expect(201);
      assert.equal(Object.keys((await bClient.get("/api/schedules")).body).length, 0);
      await fs.rm(a.dataPath);
      await aClient.get("/api/schedules").expect(200);
    });
  });
  await a.cleanup();
  await assert.rejects(fs.access(path.dirname(a.dataPath)));
  await fs.access(path.dirname(b.dataPath));
  await b.cleanup();
});

test("same-origin policy rejects cross-site mutations and security/cache headers are explicit", async () => {
  const dataPath = await tempDataPath();
  const { app } = await createApp({ dataPath, controllerFetch: successfulController().fetch });
  await withBoundServer(app, async (client) => {
    await client.post("/api/schedules/create").set("Origin", "https://evil.invalid").set("Host", "yard.local").send(validSchedule()).expect(403);
    await client.post("/api/schedules/create").set("Sec-Fetch-Site", "cross-site").send(validSchedule()).expect(403);
    await client.post("/api/schedules/create").set("Origin", "http://yard.local").set("Host", "yard.local").send(validSchedule()).expect(201);

    const page = await client.get("/").expect(200);
    assert.equal(page.headers["x-powered-by"], undefined);
    assert.equal(page.headers["x-content-type-options"], "nosniff");
    assert.equal(page.headers["x-frame-options"], "DENY");
    assert.equal(page.headers["referrer-policy"], "no-referrer");
    assert.match(page.headers["content-security-policy"], /frame-ancestors 'none'/);
    const api = await client.get("/api/schedules").expect(200);
    assert.match(api.headers["cache-control"], /no-store/);
    const asset = await client.get("/styles/app.css").expect(200);
    assert.match(asset.headers["cache-control"], /max-age=/);
  });
});

test("malformed JSON, oversized bodies, unknown schedules and bounded history retain truthful 4xx status", async () => {
  const dataPath = await tempDataPath();
  const { app } = await createApp({ dataPath, controllerFetch: successfulController().fetch });
  await withBoundServer(app, async (client) => {
    await client.post("/api/schedules/create").set("Content-Type", "application/json").send("{").expect(400);
    await client.post("/api/schedules/create").send({ ...validSchedule(), padding: "x".repeat(70 * 1024) }).expect(413);
    await client.delete("/api/schedules/delete").send({ id: "unknown-safe-id", requestId: "delete-unknown-0001" }).expect(404);
    await client.get("/api/history?limit=0").expect(400);
    await client.get("/api/history?limit=1001").expect(400);
  });
});

test("all approved page routes including status render", async () => {
  const dataPath = await tempDataPath();
  const { app } = await createApp({ dataPath, controllerFetch: successfulController().fetch });
  await withBoundServer(app, async (client) => {
    for (const route of ["/", "/status", "/quick-task", "/schedules", "/create-schedule", "/edit-schedule", "/activity", "/controller"]) {
      const response = await client.get(route).expect(200);
      assert.match(response.headers["content-type"], /html/);
    }
  });
});
