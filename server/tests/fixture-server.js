import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createApp } from "../app.js";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sprinkler-browser-"));
const dataPath = path.join(dir, "data.json");
const now = 1786190400; // 2026-08-08T12:00:00Z; fixed visual-review clock
const schedules = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`schedule-${i + 1}`, {
  name: ["Morning lawn", "Herb garden", "Trees", "Side beds", "Evening lawn"][i],
  days: i % 2 ? [2, 4, 6] : [1, 3, 5],
  startTime: `${String(6 + i).padStart(2, "0")}:30`,
  lastRun: i === 4 ? null : now - (i + 1) * 86400,
  enabled: i !== 3,
  tasks: [{ zones: [i % 6 + 1], runTime: 10 + i }],
}]));
const history = Array.from({ length: 7 }, (_, i) => ({
  timestamp: now - i * 3600,
  sequence: 7 - i,
  zones: [i % 6 + 1],
  event: i % 3 === 2 ? "Stopped" : "Started",
  reason: i % 2 ? "Remote" : "Schedule",
}));
const seed = { schedules: structuredClone(schedules), history: structuredClone(history) };
await fs.writeFile(dataPath, JSON.stringify({ schedules, history, operations: {} }), { mode: 0o600 });

let mode = "online";
let nextId = 1;
let adds = 0;
let releaseReadOverload = null;
const initialTasks = [
  { id: "running", zones: [4], runTime: 20, startTime: now - 240 },
  { id: "queued", zones: [6], runTime: 10, startTime: 0 },
];
let tasks = structuredClone(initialTasks);
const controllerFetch = async (url, init = {}) => {
  if (mode === "offline") throw new Error("synthetic offline");
  const parsed = new URL(url);
  if (parsed.pathname === "/tasks" && !init.method) {
    if (mode === "read-timeout") {
      return new Promise((resolve, reject) => init.signal?.addEventListener("abort", () =>
        reject(init.signal.reason ?? new DOMException("Aborted", "AbortError")), { once: true }));
    }
    if (mode === "read-reject") return Response.json({ error: "synthetic read unavailable" }, { status: 503 });
    if (mode === "read-abort") throw new DOMException("synthetic read aborted", "AbortError");
    return Response.json({ tasks });
  }
  if (parsed.pathname === "/tasks/add") {
    adds += 1;
    if (mode === "read-overload") {
      return new Promise((resolve) => { releaseReadOverload = () => resolve(Response.json({ success: true })); });
    }
    const body = JSON.parse(init.body);
    tasks.push(...body.tasks.map((task) => ({ id: `browser-${nextId++}`, ...task, startTime: 0 })));
    if (mode === "lost-response") return new Response("lost", { status: 200 });
    return Response.json({ success: true });
  }
  if (parsed.pathname === "/tasks/delete") {
    const id = parsed.searchParams.get("id");
    tasks = tasks.filter((task) => task.id !== id);
    if (mode === "lost-response") return new Response("lost", { status: 200 });
    return Response.json({ success: true });
  }
  return Response.json({ error: "not found" }, { status: 404 });
};

const instance = await createApp({
  dataPath,
  publicOrigin: "http://127.0.0.1:4178",
  controllerFetch,
  controllerTimeoutMs: 250,
  controllerMaxConcurrent: 1,
  repositoryOptions: { maxPendingWrites: 1 },
  afterControllerContact({ repository, type }) {
    if (mode !== "post-controller-overload" || type !== "manual-start") return;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    void repository.mutate(async () => { await gate; }).catch(() => {});
    setTimeout(release, 50);
  },
});
instance.app.post("/__test/controller", (req, res) => {
  mode = req.body?.mode ?? mode;
  if (req.body?.release && releaseReadOverload) {
    const release = releaseReadOverload;
    releaseReadOverload = null;
    release();
  }
  if (Array.isArray(req.body?.tasks)) tasks = req.body.tasks;
  res.json({ mode, tasks });
});
instance.app.get("/__test/state", (req, res) => res.json({ mode, tasks, adds, controllerWork: instance.controllerWorkState() }));
instance.app.post("/__test/reset", async (req, res) => {
  mode = "online";
  nextId = 1;
  adds = 0;
  if (releaseReadOverload) {
    const release = releaseReadOverload;
    releaseReadOverload = null;
    release();
  }
  tasks = structuredClone(initialTasks);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await instance.repository.mutate((data) => {
        data.schedules = structuredClone(seed.schedules);
        data.history = structuredClone(seed.history);
        data.operations = {};
      });
      break;
    } catch (error) {
      if (error.code !== "REPOSITORY_OVERLOADED" || attempt >= 20) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  res.json({ reset: true });
});
const server = instance.app.listen(4178, "127.0.0.1", () => console.log("production createApp fixture http://127.0.0.1:4178"));

async function shutdown() {
  await new Promise((resolve) => server.close(resolve));
  await instance.cleanup();
  await fs.rm(dir, { recursive: true, force: true });
  process.exit(0);
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);