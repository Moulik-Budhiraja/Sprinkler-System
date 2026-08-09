import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import request from "supertest";

import { createApp } from "../app.js";
import { JsonRepository } from "../repository.js";

async function tempDataPath(data = { schedules: {}, history: [], operations: {} }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sprinkler-certification-repair-"));
  const dataPath = path.join(directory, "data.json");
  await fs.writeFile(dataPath, JSON.stringify(data), { mode: 0o600 });
  return dataPath;
}

async function withBoundInstance(instance, work) {
  const fixtureId = crypto.randomUUID();
  const observations = [];
  const server = http.createServer((req, res) => {
    res.setHeader("X-Sprinkler-Test-Fixture", fixtureId);
    res.once("finish", () => observations.push({ method: req.method, target: req.url, status: res.statusCode }));
    instance.app(req, res);
  });
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
    server.listen(0, "127.0.0.1");
  });
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    return await work(request(origin), { fixtureId, origin, observations });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    const connections = await new Promise((resolve, reject) =>
      server.getConnections((error, count) => error ? reject(error) : resolve(count)));
    assert.equal(connections, 0, `${fixtureId} leaked listener connections`);
    await instance.cleanup();
  }
}

function dueSchedule(now, tasks = [{ zones: [1], runTime: 5 }]) {
  return {
    name: "Race schedule",
    days: [now.getDay()],
    startTime: `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`,
    tasks,
    enabled: true,
    lastRun: null,
    revision: 1,
  };
}

const payloadDigest = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

test("scheduler never dispatches the stale zone 1/5 payload after a concurrent zone 6/60 edit", async () => {
  const now = new Date(2026, 7, 8, 6, 30, 5);
  const dataPath = await tempDataPath({ schedules: { race: dueSchedule(now) }, history: [], operations: {} });
  const calls = [];
  const instance = await createApp({
    dataPath,
    controllerFetch: async (url, init = {}) => {
      calls.push(JSON.parse(init.body));
      return Response.json({ success: true });
    },
  });
  const staleSnapshot = await instance.repository.read();
  let releaseSnapshot;
  const snapshotReleased = new Promise((resolve) => { releaseSnapshot = resolve; });
  let snapshotRequested;
  const tickReadStarted = new Promise((resolve) => { snapshotRequested = resolve; });
  const originalRead = instance.repository.read.bind(instance.repository);
  let reads = 0;
  instance.repository.read = async () => {
    reads += 1;
    if (reads !== 1) return originalRead();
    snapshotRequested();
    await snapshotReleased;
    return staleSnapshot;
  };

  const tick = instance.runScheduleTick(now);
  await tickReadStarted;
  const editor = await new JsonRepository(dataPath).init();
  await editor.mutate((data) => {
    data.schedules.race.tasks = [{ zones: [6], runTime: 60 }];
    data.schedules.race.revision += 1;
  });
  releaseSnapshot();
  await tick;

  assert.deepEqual(calls, [{ tasks: [{ zones: [6], runTime: 60 }] }]);
  const stored = await editor.read();
  assert.equal(stored.operations[`schedule:race:${Math.floor(now.getTime() / 60000)}`].scheduleRevision, 2);
  assert.deepEqual(stored.history.map(({ zones }) => zones), [[6]]);
  await instance.cleanup();
});

test("scheduler cancels a claimed occurrence edited before atomic dispatch without controller contact", async () => {
  const now = new Date(2026, 7, 8, 6, 30, 5);
  const dataPath = await tempDataPath({ schedules: { race: dueSchedule(now) }, history: [], operations: {} });
  let calls = 0;
  const editor = await new JsonRepository(dataPath).init();
  const instance = await createApp({
    dataPath,
    beforeScheduleDispatchTransition: async () => editor.mutate((data) => {
      data.schedules.race.tasks = [{ zones: [6], runTime: 60 }];
      data.schedules.race.revision += 1;
    }),
    controllerFetch: async () => {
      calls += 1;
      return Response.json({ success: true });
    },
  });
  await instance.runScheduleTick(now);
  const operation = (await editor.read()).operations[`schedule:race:${Math.floor(now.getTime() / 60000)}`];
  assert.equal(calls, 0);
  assert.equal(operation.state, "cancelled");
  assert.equal(operation.cancelReason, "schedule_changed");
  await instance.cleanup();
});

for (const action of ["edit", "disable", "delete"]) {
  test(`${action} returns a truthful retry contract while the claimed schedule is dispatching`, async () => {
    const now = new Date(2026, 7, 8, 6, 30, 5);
    const dataPath = await tempDataPath({ schedules: { guarded: dueSchedule(now) }, history: [], operations: {} });
    let contacted;
    const controllerContact = new Promise((resolve) => { contacted = resolve; });
    let settle;
    const controllerSettlement = new Promise((resolve) => { settle = resolve; });
    const instance = await createApp({
      dataPath,
      controllerFetch: async () => {
        contacted();
        await controllerSettlement;
        return Response.json({ success: true });
      },
    });
    const tick = instance.runScheduleTick(now);
    await controllerContact;
    const response = action === "delete"
      ? await request(instance.app).delete("/api/schedules/delete").send({ id: "guarded", requestId: `guarded-${action}-request` })
      : await request(instance.app).put("/api/schedules/update").send({
        id: "guarded",
        name: "Guarded",
        days: [now.getDay()],
        startTime: "06:30",
        tasks: action === "edit" ? [{ zones: [6], runTime: 60 }] : [{ zones: [1], runTime: 5 }],
        enabled: action !== "disable",
      });
    assert.equal(response.status, 409);
    assert.deepEqual(response.body, {
      error: "schedule dispatch in progress",
      kind: "schedule_dispatching",
      outcome: "not_applied",
      recovery: "Retry after the current dispatch settles.",
    });
    assert.equal((await instance.repository.read()).schedules.guarded.revision, 1);
    settle();
    await tick;
    assert.equal((await instance.repository.read()).operations[`schedule:guarded:${Math.floor(now.getTime() / 60000)}`].state, "completed");
    const retry = action === "delete"
      ? await request(instance.app).delete("/api/schedules/delete").send({ id: "guarded", requestId: `guarded-${action}-request` })
      : await request(instance.app).put("/api/schedules/update").send({
        id: "guarded",
        name: "Guarded",
        days: [now.getDay()],
        startTime: "06:30",
        tasks: action === "edit" ? [{ zones: [6], runTime: 60 }] : [{ zones: [1], runTime: 5 }],
        enabled: action !== "disable",
      });
    assert.equal(retry.status, action === "delete" ? 201 : 200);
    assert.notEqual(retry.body.kind, "schedule_dispatching");
    await instance.cleanup();
  });
}

test("documented Compose deployment always builds audited source from a digest-pinned base", async () => {
  const repositoryRoot = new URL("../../", import.meta.url);
  const [readme, compose, dockerfile] = await Promise.all([
    fs.readFile(new URL("README.md", repositoryRoot), "utf8"),
    fs.readFile(new URL("server/docker-compose.yml", repositoryRoot), "utf8"),
    fs.readFile(new URL("server/Dockerfile", repositoryRoot), "utf8"),
  ]);
  assert.match(readme, /docker compose up -d --build --pull never/);
  assert.match(compose, /build:\s*\n\s+context: \.\s*\n\s+dockerfile: Dockerfile\s*\n\s+pull_policy: build/);
  assert.doesNotMatch(compose, /^\s*image:/m);
  assert.doesNotMatch(compose, /:latest\b/);
  assert.match(dockerfile, /^FROM node:22\.14\.0-alpine3\.21@sha256:[a-f0-9]{64}$/m);
  assert.match(dockerfile, /sha256:9bef0ef1e268f60627da9ba7d7605e8831d5b56ad07487d24d1aa386336d1944/);
});

for (const [failure, controllerFetch] of [
  ["timeout", async () => new Promise(() => {})],
  ["rejection", async () => Response.json({ error: "unavailable" }, { status: 503 })],
  ["network abort", async () => { throw new DOMException("read aborted", "AbortError"); }],
]) {
  test(`controller ${failure} on GET tasks uses only the read-unavailable contract`, async () => {
    const instance = await createApp({
      dataPath: await tempDataPath(),
      controllerFetch,
      controllerTimeoutMs: 8,
      controllerShutdownDrainMs: 8,
    });
    await withBoundInstance(instance, async (client, identity) => {
      const response = await client.get("/api/tasks");
      assert.equal(response.headers["x-sprinkler-test-fixture"], identity.fixtureId,
        `request escaped bound fixture ${identity.fixtureId} at ${identity.origin}`);
      assert.equal(response.status, 503,
        `unexpected ${response.status} from ${identity.fixtureId}: ${JSON.stringify({ body: response.body, observations: identity.observations })}`);
      assert.equal(response.headers["retry-after"], undefined);
      assert.deepEqual(response.body, {
        error: "controller read unavailable",
        kind: "read_unavailable",
        recovery: "Refresh controller status when the controller is available.",
      });
      assert.doesNotMatch(JSON.stringify(response.body), /outcome|unknown|same request|retry/i);
      assert.deepEqual(identity.observations, [{ method: "GET", target: "/api/tasks", status: 503 }]);
    });
  });
}

test("late controller settlement keeps an outcome-unknown schedule immutable until physical work ends", async () => {
  const now = new Date(2026, 7, 8, 6, 30, 5);
  const dataPath = await tempDataPath({ schedules: { late: dueSchedule(now) }, history: [], operations: {} });
  let contacted;
  const contact = new Promise((resolve) => { contacted = resolve; });
  let settle;
  const settlement = new Promise((resolve) => { settle = resolve; });
  const instance = await createApp({
    dataPath,
    controllerTimeoutMs: 8,
    controllerShutdownDrainMs: 8,
    controllerFetch: async () => {
      contacted();
      await settlement;
      return Response.json({ success: true });
    },
  });
  const tick = instance.runScheduleTick(now);
  await contact;
  await tick;
  const operationId = `schedule:late:${Math.floor(now.getTime() / 60000)}`;
  await withBoundInstance(instance, async (client, identity) => {
    try {
      const beforeBlocked = await instance.repository.read();
      assert.equal(beforeBlocked.operations[operationId].state, "outcome_unknown");
      assert.ok(beforeBlocked.schedules.late, "late schedule remains persisted while controller work is unsettled");
      const body = {
        id: "late",
        name: "Late replacement",
        days: [now.getDay()],
        startTime: "06:30",
        tasks: [{ zones: [6], runTime: 60 }],
        enabled: true,
      };
      const blocked = await client.put("/api/schedules/update").send(body);
      assert.equal(blocked.headers["x-sprinkler-test-fixture"], identity.fixtureId,
        `blocked update escaped fixture ${identity.fixtureId} at ${identity.origin}`);
      assert.equal(blocked.status, 409,
        `unexpected blocked response ${blocked.status}: ${JSON.stringify({ body: blocked.body, observations: identity.observations })}`);
      assert.equal(blocked.body.kind, "schedule_dispatching");
      settle();
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if ((await instance.repository.read()).operations[operationId].dispatchSettledAt) break;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      assert.ok((await instance.repository.read()).operations[operationId].dispatchSettledAt);
      const applied = await client.put("/api/schedules/update").send(body);
      assert.equal(applied.headers["x-sprinkler-test-fixture"], identity.fixtureId,
        `settled update escaped fixture ${identity.fixtureId} at ${identity.origin}`);
      assert.equal(applied.status, 200,
        `unexpected settled response ${applied.status}: ${JSON.stringify({ body: applied.body, observations: identity.observations })}`);
      assert.deepEqual(identity.observations.map(({ method, target, status }) => ({ method, target, status })), [
        { method: "PUT", target: "/api/schedules/update", status: 409 },
        { method: "PUT", target: "/api/schedules/update", status: 200 },
      ]);
    } finally {
      settle();
    }
  });
});

test("100 repeated zone 1/5 claims edited to zone 6/60 before dispatch make zero stale controller calls", async () => {
  const baseNow = new Date(2026, 7, 8, 6, 0, 5);
  const dataPath = await tempDataPath();
  const editor = await new JsonRepository(dataPath).init();
  let staleCalls = 0;
  let calls = 0;
  const instance = await createApp({
    dataPath,
    beforeScheduleDispatchTransition: async ({ scheduleId }) => editor.mutate((data) => {
      data.schedules[scheduleId].tasks = [{ zones: [6], runTime: 60 }];
      data.schedules[scheduleId].revision += 1;
    }),
    controllerFetch: async (url, init) => {
      calls += 1;
      const task = JSON.parse(init.body).tasks[0];
      if (task.zones[0] === 1 || task.runTime === 5) staleCalls += 1;
      return Response.json({ success: true });
    },
  });
  for (let repetition = 0; repetition < 100; repetition += 1) {
    const now = new Date(baseNow.getTime() + repetition * 60_000);
    const id = `race-${repetition}`;
    await editor.mutate((data) => { data.schedules[id] = dueSchedule(now); });
    await instance.runScheduleTick(now);
  }
  assert.equal(calls, 0);
  assert.equal(staleCalls, 0);
  const stored = await editor.read();
  assert.equal(Object.values(stored.operations).filter(({ state }) => state === "cancelled").length, 100);
  await instance.cleanup();
});

test("two repository instances atomically dispatch one same-occurrence schedule call", async () => {
  const now = new Date(2026, 7, 8, 6, 30, 5);
  const dataPath = await tempDataPath({ schedules: { shared: dueSchedule(now) }, history: [], operations: {} });
  let calls = 0;
  let contacted;
  const controllerContact = new Promise((resolve) => { contacted = resolve; });
  let settle;
  const controllerSettlement = new Promise((resolve) => { settle = resolve; });
  const controllerFetch = async () => {
    calls += 1;
    contacted();
    await controllerSettlement;
    return Response.json({ success: true });
  };
  const first = await createApp({ dataPath, controllerFetch });
  const second = await createApp({ dataPath, controllerFetch });
  const firstTick = first.runScheduleTick(now);
  await controllerContact;
  await second.runScheduleTick(now);
  assert.equal(calls, 1);
  assert.equal((await second.repository.read()).operations[`schedule:shared:${Math.floor(now.getTime() / 60000)}`].state, "dispatching");
  settle();
  await firstTick;
  const stored = await first.repository.read();
  assert.equal(Object.values(stored.operations).filter(({ type }) => type === "schedule-start").length, 1);
  assert.equal(stored.history.length, 1);
  await first.cleanup();
  await second.cleanup();
});

test("restart resumes a pre-contact pending claim but never replays a dispatching claim", async () => {
  const now = new Date(2026, 7, 8, 6, 30, 5);
  const occurrence = Math.floor(now.getTime() / 60000);
  const payload = [{ zones: [2], runTime: 15 }];
  const operationId = `schedule:restart:${occurrence}`;
  const operation = {
    id: operationId,
    type: "schedule-start",
    scheduleId: "restart",
    scheduleRevision: 1,
    occurrence,
    payload,
    payloadHash: payloadDigest(payload),
    state: "pending",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const pendingPath = await tempDataPath({ schedules: { restart: dueSchedule(now, payload) }, history: [], operations: { [operationId]: operation } });
  let pendingCalls = 0;
  const pending = await createApp({ dataPath: pendingPath, controllerFetch: async () => {
    pendingCalls += 1;
    return Response.json({ success: true });
  } });
  await pending.runScheduleTick(now);
  assert.equal(pendingCalls, 1);
  assert.equal((await pending.repository.read()).operations[operationId].state, "completed");
  await pending.cleanup();

  const dispatchingPath = await tempDataPath({
    schedules: { restart: dueSchedule(now, payload) },
    history: [],
    operations: { [operationId]: { ...operation, state: "dispatching" } },
  });
  let replayCalls = 0;
  const dispatching = await createApp({ dataPath: dispatchingPath, controllerFetch: async () => {
    replayCalls += 1;
    return Response.json({ success: true });
  } });
  await dispatching.runScheduleTick(now);
  assert.equal(replayCalls, 0);
  assert.equal((await dispatching.repository.read()).operations[operationId].state, "outcome_unknown");
  await dispatching.cleanup();
});
