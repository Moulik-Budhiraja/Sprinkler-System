import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import request from "supertest";

import { createApp } from "../app.js";

async function tempDataPath(data = { schedules: {}, history: [] }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sprinkler-test-"));
  const file = path.join(dir, "data.json");
  await fs.writeFile(file, JSON.stringify(data), "utf8");
  return file;
}

function controllerStub(state = { tasks: [] }) {
  const calls = [];
  const controllerFetch = async (url, init = {}) => {
    calls.push({ url, init });
    const body = init.body ? JSON.parse(init.body) : null;
    if (url.endsWith("/tasks") && !init.method) {
      return new Response(JSON.stringify(state), { status: 200 });
    }
    if (url.endsWith("/tasks/add")) {
      for (const t of body.tasks) {
        state.tasks.push({ id: `t${state.tasks.length + 1}`, ...t, startTime: 0 });
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    if (url.includes("/tasks/delete")) {
      const id = new URL(url).searchParams.get("id");
      state.tasks = state.tasks.filter((t) => t.id !== id);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
  return { controllerFetch, calls, state };
}

test("createApp serves schedules from an injected isolated data file", async () => {
  const dataPath = await tempDataPath({
    schedules: { abc: { name: "Morning", days: [1], startTime: "06:30", lastRun: null, enabled: true, tasks: [{ zones: [1, 7], runTime: 5 }] } },
    history: [],
  });
  const { app } = await createApp({ dataPath, controllerFetch: async () => new Response("{}") });
  const res = await request(app).get("/api/schedules").expect(200);
  assert.equal(res.body.abc.name, "Morning");
  assert.deepEqual(res.body.abc.tasks[0].zones, [1, 7], "zones 7/8 must survive untouched");
});

test("task create forwards zones 1-8 unchanged and logs history", async () => {
  const dataPath = await tempDataPath();
  const stub = controllerStub();
  const { app } = await createApp({ dataPath, controllerFetch: stub.controllerFetch });
  await request(app)
    .post("/api/tasks/create")
    .send({ zones: [2, 7, 8], runTime: 10 })
    .expect(200);
  const add = stub.calls.find((c) => c.url.endsWith("/tasks/add"));
  assert.deepEqual(JSON.parse(add.init.body).tasks[0].zones, [2, 7, 8], "backend must not filter zones 7-8");
  const saved = JSON.parse(await fs.readFile(dataPath, "utf8"));
  assert.equal(saved.history[0].event, "Started");
  assert.deepEqual(saved.history[0].zones, [2, 7, 8]);
  assert.equal(Number.isInteger(saved.history[0].timestamp), true);
  assert.ok(Math.abs(saved.history[0].timestamp - Date.now() / 1000) < 60, "timestamp must be now, not bitwise-mangled");
});

test("controller failures surface as non-2xx JSON errors instead of crashes", async () => {
  const dataPath = await tempDataPath();
  const failing = async () => new Response("boom", { status: 500 });
  const { app } = await createApp({ dataPath, controllerFetch: failing });
  const res = await request(app).get("/api/tasks").expect(502);
  assert.match(res.body.error, /controller/i);

  const unreachable = async () => { throw new Error("ECONNREFUSED"); };
  const { app: app2 } = await createApp({ dataPath, controllerFetch: unreachable });
  await request(app2).get("/api/tasks").expect(502);
  await request(app2).post("/api/tasks/create").send({ zones: [1], runTime: 5 }).expect(502);
  const saved = JSON.parse(await fs.readFile(dataPath, "utf8"));
  assert.equal(saved.history.length, 0, "failed starts must not log Started history");
});

test("deleting an unknown task id returns 404 and logs nothing", async () => {
  const dataPath = await tempDataPath();
  const stub = controllerStub({ tasks: [{ id: "real", zones: [3], runTime: 5, startTime: 0 }] });
  const { app } = await createApp({ dataPath, controllerFetch: stub.controllerFetch });
  await request(app).delete("/api/tasks/delete").send({ id: "ghost" }).expect(404);
  await request(app).delete("/api/tasks/delete").send({ id: "real" }).expect(200);
  const saved = JSON.parse(await fs.readFile(dataPath, "utf8"));
  assert.equal(saved.history.length, 1);
  assert.equal(saved.history[0].event, "Stopped");
});

test("schedule create/update/delete roundtrip preserves any zone 1-8", async () => {
  const dataPath = await tempDataPath();
  const { app } = await createApp({ dataPath, controllerFetch: async () => new Response("{}") });
  await request(app)
    .post("/api/schedules/create")
    .send({ name: "Beds", days: [0, 6], startTime: "07:15", tasks: [{ zones: [6, 8], runTime: 20 }] })
    .expect(200);
  let saved = JSON.parse(await fs.readFile(dataPath, "utf8"));
  const id = Object.keys(saved.schedules)[0];
  assert.deepEqual(saved.schedules[id].tasks[0].zones, [6, 8]);

  await request(app)
    .put("/api/schedules/update")
    .send({ id, name: "Beds late", days: [0], startTime: "08:00", enabled: false, tasks: [{ zones: [8], runTime: 5 }] })
    .expect(200);
  saved = JSON.parse(await fs.readFile(dataPath, "utf8"));
  assert.equal(saved.schedules[id].name, "Beds late");
  assert.deepEqual(saved.schedules[id].tasks[0].zones, [8]);

  await request(app).delete("/api/schedules/delete").send({ id }).expect(200);
  saved = JSON.parse(await fs.readFile(dataPath, "utf8"));
  assert.equal(Object.keys(saved.schedules).length, 0);
});

test("history endpoint returns newest-first records with limit", async () => {
  const history = Array.from({ length: 60 }, (_, i) => ({
    timestamp: 1786141800 - i, zones: [1], event: "Started", reason: "Schedule",
  }));
  const dataPath = await tempDataPath({ schedules: {}, history });
  const { app } = await createApp({ dataPath, controllerFetch: async () => new Response("{}") });
  const res = await request(app).get("/api/history?limit=10").expect(200);
  assert.equal(res.body.length, 10);
  assert.equal(res.body[0].timestamp, 1786141800);
});

test("demo mode is deterministic and never touches the real controller fetch", async () => {
  const dataPath = await tempDataPath();
  let realFetchCalls = 0;
  const spy = async () => { realFetchCalls += 1; return new Response("{}"); };
  const { app } = await createApp({ dataPath, demo: true, controllerFetch: spy });
  const res = await request(app).get("/api/tasks").expect(200);
  assert.ok(Array.isArray(res.body.tasks));
  await request(app).post("/api/tasks/create").send({ zones: [5], runTime: 5 }).expect(200);
  const after = await request(app).get("/api/tasks").expect(200);
  assert.ok(after.body.tasks.some((t) => t.zones.includes(5)));
  assert.equal(realFetchCalls, 0, "demo mode must be incapable of contacting hardware");
});

test("page routes render", async () => {
  const dataPath = await tempDataPath();
  const { app } = await createApp({ dataPath, controllerFetch: async () => new Response("{}") });
  for (const route of ["/", "/quick-task", "/schedules", "/create-schedule", "/edit-schedule", "/activity", "/controller"]) {
    const res = await request(app).get(route).expect(200);
    assert.match(res.headers["content-type"], /html/);
  }
});
