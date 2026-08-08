import express from "express";
import bodyParser from "body-parser";
import os from "os";
import path from "path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "url";
import fs from "fs/promises";
import { v4 as uuid4 } from "uuid";
import { savePath } from "./constants.js";
import { JsonRepository } from "./repository.js";
import {
  ValidationError,
  deleteBody,
  historyBody,
  historyLimit,
  manualTaskBody,
  safeId,
  scheduleCreateBody,
  scheduleUpdateBody,
  zoneBody,
} from "./validation.js";
import dotenv from "dotenv";
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

class ControllerError extends Error {}
class ControllerRejectedError extends ControllerError {}
class AmbiguousControllerError extends ControllerError {}

export function createSyntheticController(now = () => Math.floor(Date.now() / 1000)) {
  let nextId = 1;
  const state = {
    tasks: [
      { id: "demo-running", zones: [4], runTime: 20, startTime: now() - 240 },
      { id: "demo-queued", zones: [6], runTime: 10, startTime: 0 },
    ],
  };

  return async (url, init = {}) => {
    const parsed = new URL(url, "http://synthetic.invalid");
    if (parsed.pathname === "/tasks" && !init.method) return Response.json({ tasks: state.tasks });
    if (parsed.pathname === "/tasks/add") {
      const body = JSON.parse(init.body);
      for (const task of body.tasks) {
        state.tasks.push({
          id: `demo-${nextId++}`,
          zones: task.zones,
          runTime: task.runTime,
          startTime: state.tasks.some((entry) => entry.startTime !== 0) ? 0 : now(),
        });
      }
      return Response.json({ success: true });
    }
    if (parsed.pathname === "/tasks/delete") {
      const id = parsed.searchParams.get("id");
      const existed = state.tasks.some((entry) => entry.id === id);
      state.tasks = state.tasks.filter((entry) => entry.id !== id);
      return Response.json(existed ? { success: true } : { error: "not found" }, { status: existed ? 200 : 404 });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  };
}

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function operationMatches(operation, requestId, type, payloadHash) {
  return operation?.id === requestId && operation.type === type && operation.payloadHash === payloadHash;
}

function operationPublic(operation) {
  return {
    operationId: operation.id,
    type: operation.type,
    state: operation.state,
    outcome: operation.state === "outcome_unknown" ? "unknown" : operation.state,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    scheduleId: operation.type === "schedule-create" ? operation.scheduleId : undefined,
    recovery: operation.state === "outcome_unknown"
      ? "Outcome unknown. Check controller status before taking another action. This request will not be sent again."
      : undefined,
  };
}

function addHistory(data, zones, event, reason, timestamp = Math.floor(Date.now() / 1000), operationId = undefined) {
  const sequence = data.history.reduce((maximum, entry) => Number.isInteger(entry.sequence) ? Math.max(maximum, entry.sequence) : maximum, 0) + 1;
  const entry = { timestamp, sequence, zones, event, reason };
  if (operationId) entry.operationId = operationId;
  data.history = [entry, ...data.history].slice(0, 250);
  return entry;
}

function orderedSchedules(schedules) {
  return Object.fromEntries(Object.entries(schedules).sort(([idA, a], [idB, b]) =>
    String(a.startTime).localeCompare(String(b.startTime)) ||
    String(a.name).localeCompare(String(b.name)) || idA.localeCompare(idB)
  ));
}

export async function createApp(options = {}) {
  const demo = options.demo ?? process.env.SPRINKLER_DEMO === "1";
  let ownedDemoDir = null;
  let dataPath = options.dataPath;
  if (!dataPath && demo) {
    ownedDemoDir = await fs.mkdtemp(path.join(os.tmpdir(), "sprinkler-demo-"));
    await fs.chmod(ownedDemoDir, 0o700);
    dataPath = path.join(ownedDemoDir, "data.json");
  }
  dataPath ??= savePath;

  const repository = await new JsonRepository(dataPath, { recoverMissing: demo }).init();
  const controllerHost = options.controllerHost ?? `http://${process.env.MICROCONTROLLER_HOST}`;
  const controllerFetch = demo ? createSyntheticController() : options.controllerFetch ?? ((url, init) => fetch(url, init));
  const controllerTimeoutMs = options.controllerTimeoutMs ?? 4000;

  async function controllerRequest(pathname, init = undefined, mutation = false) {
    let timer;
    let response;
    try {
      response = await Promise.race([
        controllerFetch(controllerHost + pathname, init),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("deadline exceeded")), controllerTimeoutMs);
        }),
      ]);
    } catch (error) {
      throw new AmbiguousControllerError(`controller outcome unknown: ${error.message}`);
    } finally {
      clearTimeout(timer);
    }
    if (!response?.ok) {
      const ErrorType = mutation ? AmbiguousControllerError : ControllerRejectedError;
      throw new ErrorType(`controller ${mutation ? "outcome unknown" : "rejected request"} (${response?.status ?? "invalid response"})`);
    }
    try {
      return await response.json();
    } catch (error) {
      const ErrorType = mutation ? AmbiguousControllerError : ControllerRejectedError;
      throw new ErrorType(`controller ${mutation ? "outcome unknown" : "returned invalid data"}: ${error.message}`);
    }
  }

  const app = express();
  app.disable("x-powered-by");
  app.set("view engine", "ejs");
  app.set("views", path.join(__dirname, "views"));
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    if (req.path.startsWith("/api/")) res.set("Cache-Control", "no-store");
    next();
  });
  app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h", fallthrough: true }));
  app.use(bodyParser.json({ limit: "64kb", strict: true }));
  app.use((req, res, next) => {
    if (!MUTATION_METHODS.has(req.method) || !req.path.startsWith("/api/")) return next();
    if (req.get("Sec-Fetch-Site") === "cross-site") return res.status(403).json({ error: "cross-site mutation denied" });
    const origin = req.get("Origin");
    if (origin) {
      try {
        if (new URL(origin).host !== req.get("Host")) return res.status(403).json({ error: "origin denied" });
      } catch {
        return res.status(403).json({ error: "origin denied" });
      }
    }
    return next();
  });

  const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

  app.get("/healthz", (req, res) => res.json({ ok: true, mode: demo ? "synthetic" : "controller" }));
  app.get("/", (req, res) => res.render("index"));
  app.get("/status", (req, res) => res.render("status"));
  app.get("/quick-task", (req, res) => res.render("quick-task"));
  app.get("/schedules", (req, res) => res.render("schedules"));
  app.get("/create-schedule", (req, res) => res.render("create-schedule"));
  app.get("/edit-schedule", (req, res) => res.render("edit-schedule"));
  app.get("/activity", (req, res) => res.render("activity"));
  app.get("/controller", (req, res) => res.render("controller"));

  app.get("/api/schedules", wrap(async (req, res) => res.json(orderedSchedules((await repository.read()).schedules))));

  app.post("/api/schedules/create", wrap(async (req, res) => {
    const parsed = scheduleCreateBody(req.body);
    const { requestId, ...semanticPayload } = parsed;
    const payloadHash = digest(semanticPayload);
    const result = await repository.mutate((data) => {
      const prior = data.operations[requestId];
      if (prior) {
        return operationMatches(prior, requestId, "schedule-create", payloadHash)
          ? { prior, schedule: data.schedules[prior.scheduleId] }
          : { conflict: true };
      }
      const id = uuid4();
      const schedule = { ...semanticPayload, lastRun: null, enabled: true };
      const now = Date.now();
      data.schedules[id] = schedule;
      data.operations[requestId] = {
        id: requestId,
        type: "schedule-create",
        payloadHash,
        scheduleId: id,
        state: "completed",
        createdAt: now,
        updatedAt: now,
      };
      return { operation: data.operations[requestId], schedule };
    });
    if (result.conflict) return res.status(409).json({ error: "requestId was already used for another operation" });
    const operation = result.prior ?? result.operation;
    res.status(result.prior ? 200 : 201).json({
      id: operation.scheduleId,
      ...(result.schedule ?? {}),
      operationId: operation.id,
      state: operation.state,
    });
  }));

  app.put("/api/schedules/update", wrap(async (req, res) => {
    const parsed = scheduleUpdateBody(req.body);
    const updated = await repository.mutate((data) => {
      if (!Object.hasOwn(data.schedules, parsed.id)) return null;
      data.schedules[parsed.id] = { ...data.schedules[parsed.id], ...parsed };
      delete data.schedules[parsed.id].id;
      return data.schedules[parsed.id];
    });
    if (!updated) return res.status(404).json({ error: "schedule not found" });
    res.json(updated);
  }));

  app.delete("/api/schedules/delete", wrap(async (req, res) => {
    const parsed = deleteBody(req.body, { requestId: true });
    const payloadHash = digest({ id: parsed.id });
    const result = await repository.mutate((data) => {
      const prior = data.operations[parsed.requestId];
      if (prior) return operationMatches(prior, parsed.requestId, "schedule-delete", payloadHash) ? { prior } : { conflict: true };
      if (!Object.hasOwn(data.schedules, parsed.id)) return { missing: true };
      delete data.schedules[parsed.id];
      const now = Date.now();
      const operation = { id: parsed.requestId, type: "schedule-delete", payloadHash, state: "completed", createdAt: now, updatedAt: now };
      data.operations[parsed.requestId] = operation;
      return { operation };
    });
    if (result.conflict) return res.status(409).json({ error: "requestId was already used for another operation" });
    if (result.missing) return res.status(404).json({ error: "schedule not found" });
    res.status(result.prior ? 200 : 201).json(operationPublic(result.prior ?? result.operation));
  }));

  app.get("/api/history", wrap(async (req, res) => {
    const limit = historyLimit(req.query.limit);
    const history = [...(await repository.read()).history]
      .sort((a, b) => b.timestamp - a.timestamp || (b.sequence ?? 0) - (a.sequence ?? 0));
    res.json(history.slice(0, limit));
  }));

  app.post("/api/history/create", wrap(async (req, res) => {
    const parsed = historyBody(req.body);
    const entry = await repository.mutate((data) => addHistory(data, parsed.zones, parsed.event, parsed.reason));
    res.status(201).json(entry);
  }));

  app.get("/api/tasks", wrap(async (req, res) => res.json(await controllerRequest("/tasks"))));

  app.get("/api/operations/:id", wrap(async (req, res) => {
    const id = safeId(req.params.id);
    const operation = (await repository.read()).operations[id];
    if (!operation) return res.status(404).json({ error: "operation not found" });
    res.json(operationPublic(operation));
  }));

  app.post("/api/tasks/create", wrap(async (req, res) => {
    const parsed = manualTaskBody(req.body);
    const payload = { zones: parsed.zones, runTime: parsed.runTime };
    const payloadHash = digest(payload);
    const claim = await repository.mutate((data) => {
      const prior = data.operations[parsed.requestId];
      if (prior) return operationMatches(prior, parsed.requestId, "manual-start", payloadHash) ? { prior } : { conflict: true };
      const now = Date.now();
      const operation = { id: parsed.requestId, type: "manual-start", payloadHash, state: "pending", createdAt: now, updatedAt: now };
      data.operations[parsed.requestId] = operation;
      return { operation };
    });
    if (claim.conflict) return res.status(409).json({ error: "requestId was already used for another operation" });
    if (claim.prior) {
      const status = claim.prior.state === "completed" ? 200 : claim.prior.state === "rejected" ? 502 : 202;
      return res.status(status).json(operationPublic(claim.prior));
    }

    try {
      await controllerRequest("/tasks/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tasks: [payload] }),
      }, true);
      const completed = await repository.mutate((data) => {
        const operation = data.operations[parsed.requestId];
        operation.state = "completed";
        operation.updatedAt = Date.now();
        addHistory(data, parsed.zones, "Started", "Remote", undefined, operation.id);
        return operation;
      });
      return res.status(201).json(operationPublic(completed));
    } catch (error) {
      const state = error instanceof ControllerRejectedError ? "rejected" : "outcome_unknown";
      const operation = await repository.mutate((data) => {
        const current = data.operations[parsed.requestId];
        current.state = state;
        current.updatedAt = Date.now();
        if (state === "outcome_unknown") addHistory(data, parsed.zones, "Outcome unknown", "Remote", undefined, current.id);
        return current;
      });
      if (state === "rejected") return res.status(502).json({ ...operationPublic(operation), error: error.message });
      return res.status(202).json(operationPublic(operation));
    }
  }));

  app.delete("/api/tasks/delete", wrap(async (req, res) => {
    const parsed = deleteBody(req.body, { requestId: true });
    const payloadHash = digest({ id: parsed.id });
    const claim = await repository.mutate((data) => {
      const prior = data.operations[parsed.requestId];
      if (prior) return operationMatches(prior, parsed.requestId, "task-delete", payloadHash) ? { prior } : { conflict: true };
      const now = Date.now();
      const operation = { id: parsed.requestId, type: "task-delete", payloadHash, state: "pending", createdAt: now, updatedAt: now };
      data.operations[parsed.requestId] = operation;
      return { operation };
    });
    if (claim.conflict) return res.status(409).json({ error: "requestId was already used for another operation" });
    if (claim.prior) {
      const status = claim.prior.state === "completed" ? 200 : claim.prior.state === "rejected" ? 502 : 202;
      return res.status(status).json(operationPublic(claim.prior));
    }

    let task;
    try {
      const current = await controllerRequest("/tasks");
      task = current.tasks.find((entry) => String(entry.id) === parsed.id);
    } catch (error) {
      const operation = await repository.mutate((data) => {
        const currentOperation = data.operations[parsed.requestId];
        currentOperation.state = "rejected";
        currentOperation.updatedAt = Date.now();
        return currentOperation;
      });
      return res.status(error instanceof ControllerRejectedError ? 502 : 503).json({ ...operationPublic(operation), error: "Could not read controller task state; no Stop command was sent." });
    }
    if (!task) {
      await repository.mutate((data) => {
        data.operations[parsed.requestId].state = "rejected";
        data.operations[parsed.requestId].updatedAt = Date.now();
      });
      return res.status(404).json({ error: "task not found" });
    }
    await repository.mutate((data) => { data.operations[parsed.requestId].zones = task.zones; });
    try {
      await controllerRequest(`/tasks/delete?id=${encodeURIComponent(parsed.id)}`, { method: "DELETE" }, true);
      const operation = await repository.mutate((data) => {
        const currentOperation = data.operations[parsed.requestId];
        currentOperation.state = "completed";
        currentOperation.updatedAt = Date.now();
        addHistory(data, task.zones, "Stopped", "Remote", undefined, currentOperation.id);
        return currentOperation;
      });
      res.status(201).json(operationPublic(operation));
    } catch (error) {
      const state = error instanceof ControllerRejectedError ? "rejected" : "outcome_unknown";
      const operation = await repository.mutate((data) => {
        const currentOperation = data.operations[parsed.requestId];
        currentOperation.state = state;
        currentOperation.updatedAt = Date.now();
        if (state === "outcome_unknown") addHistory(data, task.zones, "Outcome unknown", "Remote", undefined, currentOperation.id);
        return currentOperation;
      });
      res.status(state === "rejected" ? 502 : 202).json(operationPublic(operation));
    }
  }));

  let activeZones = [];
  async function refreshActiveZones() {
    const data = await controllerRequest("/tasks");
    activeZones = [...new Set(data.tasks.flatMap((task) => task.zones))].sort((a, b) => a - b);
  }
  app.get("/api/zones", (req, res) => res.json(activeZones));
  app.post("/api/zones", wrap(async (req, res) => {
    const parsed = zoneBody(req.body);
    if (!parsed.on) {
      return res.status(409).json({ error: "The controller cannot safely stop one zone. Stop the truthful whole task by task ID." });
    }
    return res.status(409).json({ error: "Use the idempotent task endpoint with a stable requestId to start watering." });
  }));

  let tickRunning = false;
  async function runScheduleTick(now = new Date()) {
    if (tickRunning) return;
    tickRunning = true;
    try {
      const snapshot = await repository.read();
      const day = now.getDay();
      const clock = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      const occurrence = Math.floor(now.getTime() / 60000);
      for (const [id, schedule] of Object.entries(snapshot.schedules)) {
        if (!schedule.enabled || !schedule.days.includes(day) || schedule.startTime !== clock) continue;
        const operationId = `schedule:${id}:${occurrence}`;
        const payloadHash = digest(schedule.tasks);
        const claimed = await repository.mutate((data) => {
          if (data.operations[operationId]) return false;
          const live = data.schedules[id];
          if (!live || !live.enabled || !live.days.includes(day) || live.startTime !== clock) return false;
          const timestamp = Math.floor(now.getTime() / 1000);
          const createdAt = Date.now();
          data.operations[operationId] = { id: operationId, type: "schedule-start", payloadHash, state: "pending", createdAt, updatedAt: createdAt };
          live.lastRun = timestamp;
          return true;
        });
        if (!claimed) continue;
        try {
          await controllerRequest("/tasks/add", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tasks: schedule.tasks }),
          }, true);
          await repository.mutate((data) => {
            const operation = data.operations[operationId];
            operation.state = "completed";
            operation.updatedAt = Date.now();
            let timestamp = Math.floor(now.getTime() / 1000);
            for (const task of schedule.tasks) {
              addHistory(data, task.zones, "Started", "Schedule", timestamp, operationId);
              timestamp += task.runTime * 60;
            }
          });
        } catch (error) {
          await repository.mutate((data) => {
            const operation = data.operations[operationId];
            operation.state = error instanceof ControllerRejectedError ? "rejected" : "outcome_unknown";
            operation.updatedAt = Date.now();
            if (operation.state === "outcome_unknown") {
              for (const task of schedule.tasks) addHistory(data, task.zones, "Outcome unknown", "Schedule", Math.floor(now.getTime() / 1000), operationId);
            }
          });
        }
      }
    } finally {
      tickRunning = false;
    }
  }

  let jobsStopped = true;
  const timers = new Set();
  function scheduleJob(work, delay) {
    const timer = setTimeout(async () => {
      timers.delete(timer);
      if (jobsStopped) return;
      try { await work(); } catch (error) { console.error(error); }
      if (!jobsStopped) scheduleJob(work, delay);
    }, delay);
    timers.add(timer);
  }
  function startBackgroundJobs() {
    if (!jobsStopped) return;
    jobsStopped = false;
    scheduleJob(refreshActiveZones, 10000);
    scheduleJob(runScheduleTick, 5000);
  }
  function stopBackgroundJobs() {
    jobsStopped = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  }
  async function cleanup() {
    stopBackgroundJobs();
    if (ownedDemoDir) {
      const owned = ownedDemoDir;
      ownedDemoDir = null;
      await fs.rm(owned, { recursive: true, force: true });
    }
  }

  app.use((err, req, res, next) => {
    if (err instanceof ValidationError) return res.status(err.status).json({ error: err.message });
    if (err?.type === "entity.too.large") return res.status(413).json({ error: "request body too large" });
    if (err instanceof SyntaxError && err.status === 400 && "body" in err) return res.status(400).json({ error: "malformed JSON" });
    if (err instanceof ControllerRejectedError) return res.status(502).json({ error: err.message });
    if (err instanceof AmbiguousControllerError) return res.status(503).json({ error: "controller outcome unknown", recovery: "Check controller status before retrying." });
    if (err?.code === "REPOSITORY_OVERLOADED") {
      res.set("Retry-After", "1");
      return res.status(503).json({ error: "datastore busy", recovery: "Retry this same requestId after the indicated delay." });
    }
    console.error(err.stack ?? err);
    res.status(500).json({ error: "internal error" });
  });

  return { app, dataPath, demo, repository, refreshActiveZones, runScheduleTick, startBackgroundJobs, stopBackgroundJobs, cleanup };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const port = Number(process.env.PORT || 5000);
  const host = process.env.HOST || "127.0.0.1";
  const instance = await createApp();
  if (!instance.demo) instance.startBackgroundJobs();
  const server = instance.app.listen(port, host, () => {
    console.log(`Sprinkler Webserver listening on http://${host}:${port}${instance.demo ? " (demo mode)" : ""}`);
  });
  const shutdown = async () => {
    server.close();
    await instance.cleanup();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
