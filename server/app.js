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
const activeScheduleDispatchOwners = new Set();
const activeScheduleDispatches = new Set();

class ControllerError extends Error {}
class ControllerRejectedError extends ControllerError {}
class AmbiguousControllerError extends ControllerError {}
class ControllerReadError extends ControllerError {
  constructor(message = "controller read unavailable") {
    super(message);
    this.code = "CONTROLLER_READ_UNAVAILABLE";
  }
}
class ControllerCapacityError extends ControllerError {
  constructor(message = "controller work capacity is unavailable") {
    super(message);
    this.code = "CONTROLLER_OVERLOADED";
  }
}

function normalizedPublicOrigin(value, label = "publicOrigin") {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be an explicit HTTP(S) origin`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid HTTP(S) origin`);
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password ||
      parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`${label} must be an HTTP(S) origin without credentials, path, query, or fragment`);
  }
  return parsed.origin;
}

export function resolveStartupConfig(env = process.env) {
  if (env.SPRINKLER_DEMO !== "0" && env.SPRINKLER_DEMO !== "1") {
    throw new Error("SPRINKLER_DEMO must be explicitly set to exactly 0 or 1");
  }
  const demo = env.SPRINKLER_DEMO === "1";
  const testOrigin = env.SPRINKLER_TEST_ORIGIN;
  if (testOrigin !== undefined && testOrigin !== "0" && testOrigin !== "1") {
    throw new Error("SPRINKLER_TEST_ORIGIN must be exactly 0 or 1 when set");
  }
  if (testOrigin === "1") {
    if (!demo) throw new Error("SPRINKLER_TEST_ORIGIN is allowed only for a synthetic demo");
    return { demo: true, publicOrigin: null, allowSyntheticTestOrigin: true };
  }
  return {
    demo,
    publicOrigin: normalizedPublicOrigin(env.SPRINKLER_PUBLIC_ORIGIN, "SPRINKLER_PUBLIC_ORIGIN"),
  };
}

export function createSyntheticController(now = () => Math.floor(Date.now() / 1000)) {
  let nextId = 1;
  const state = {
    tasks: [
      { id: "demo-running", zones: [4], runTime: 20, startTime: now() - 240 },
      { id: "demo-queued", zones: [6], runTime: 10, startTime: 0 },
    ],
  };

  return async (url, init = {}) => {
    init.signal?.throwIfAborted();
    const parsed = new URL(url, "http://synthetic.invalid");
    if (parsed.pathname === "/tasks" && !init.method) return Response.json({ tasks: state.tasks });
    if (parsed.pathname === "/tasks/add") {
      const body = JSON.parse(init.body);
      for (const task of body.tasks) {
        init.signal?.throwIfAborted();
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
      init.signal?.throwIfAborted();
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
  const unresolved = operation.state === "pending" || operation.state === "outcome_unknown";
  return {
    operationId: operation.id,
    type: operation.type,
    state: operation.state,
    outcome: unresolved ? "unknown" : operation.state,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    scheduleId: operation.type === "schedule-create" ? operation.scheduleId : undefined,
    recovery: unresolved
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

function scheduleRevision(schedule) {
  return Number.isSafeInteger(schedule?.revision) && schedule.revision > 0 ? schedule.revision : 1;
}

function dispatchOperationSettled(operation, now = Date.now()) {
  operation.dispatchSettledAt = now;
  operation.updatedAt = now;
}

function dispatchOwnerIsActive(operation) {
  if (!Number.isSafeInteger(operation.dispatchPid) || typeof operation.dispatchOwner !== "string") return false;
  if (operation.dispatchPid === process.pid) {
    const token = `${operation.dispatchOwner}:${operation.id}`;
    return activeScheduleDispatches.has(token) ||
      (operation.state === "dispatching" && activeScheduleDispatchOwners.has(operation.dispatchOwner));
  }
  if (Number.isFinite(operation.dispatchSettledAt)) return false;
  try {
    process.kill(operation.dispatchPid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function reconcileInactiveScheduleDispatches(data, now = Date.now()) {
  for (const operation of Object.values(data.operations ?? {})) {
    if (operation?.type === "schedule-start" && operation.state === "dispatching" && !dispatchOwnerIsActive(operation, now)) {
      operation.state = "outcome_unknown";
      operation.updatedAt = now;
    }
  }
}

function scheduleDispatchInProgress(data, scheduleId) {
  reconcileInactiveScheduleDispatches(data);
  return Object.values(data.operations).some((operation) =>
    operation?.type === "schedule-start" && operation.scheduleId === scheduleId &&
    (operation.state === "dispatching" ||
      (operation.state === "outcome_unknown" && dispatchOwnerIsActive(operation)))
  );
}

function scheduleDispatchRetry(res) {
  return res.status(409).json({
    error: "schedule dispatch in progress",
    kind: "schedule_dispatching",
    outcome: "not_applied",
    recovery: "Retry after the current dispatch settles.",
  });
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

  const repository = await new JsonRepository(dataPath, { recoverMissing: demo, ...options.repositoryOptions }).init();
  const controllerHost = options.controllerHost ?? `http://${process.env.MICROCONTROLLER_HOST}`;
  const controllerFetch = demo ? createSyntheticController() : options.controllerFetch ?? ((url, init) => fetch(url, init));
  const controllerTimeoutMs = options.controllerTimeoutMs ?? 4000;
  const controllerMaxConcurrent = options.controllerMaxConcurrent ?? 8;
  const controllerShutdownDrainMs = options.controllerShutdownDrainMs ?? 1000;
  if (!Number.isInteger(controllerMaxConcurrent) || controllerMaxConcurrent < 1) {
    throw new TypeError("controllerMaxConcurrent must be a positive integer");
  }
  const configuredPublicOrigin = options.publicOrigin ?? process.env.SPRINKLER_PUBLIC_ORIGIN;
  const publicOrigin = configuredPublicOrigin ? normalizedPublicOrigin(configuredPublicOrigin) : null;
  const allowSyntheticTestOrigin = options.allowSyntheticTestOrigin === true;
  if (allowSyntheticTestOrigin && !demo) throw new Error("test origin mode is allowed only for a synthetic demo");
  const scheduleDispatchOwner = crypto.randomUUID();
  activeScheduleDispatchOwners.add(scheduleDispatchOwner);
  const controllerLeases = new Set();
  let controllerShuttingDown = false;

  function acquireControllerLease() {
    if (controllerShuttingDown || controllerLeases.size >= controllerMaxConcurrent) return null;
    const lease = {
      abortController: null,
      activePromise: null,
      releaseRequested: false,
      released: false,
      async execute(pathname, init = undefined, mutation = false, retain = false) {
        if (lease.released || lease.activePromise) throw new Error("invalid controller lease state");
        const abortController = new AbortController();
        lease.abortController = abortController;
        let timer;
        let deadlineReject;
        const deadline = new Promise((_, reject) => { deadlineReject = reject; });
        const work = (async () => {
          const response = await controllerFetch(controllerHost + pathname, { ...(init ?? {}), signal: abortController.signal });
          if (!response?.ok) {
            const ErrorType = mutation ? AmbiguousControllerError : ControllerReadError;
            throw new ErrorType(`controller ${mutation ? "outcome unknown" : "read unavailable"} (${response?.status ?? "invalid response"})`);
          }
          try {
            return await response.json();
          } catch (error) {
            const ErrorType = mutation ? AmbiguousControllerError : ControllerReadError;
            throw new ErrorType(`controller ${mutation ? "outcome unknown" : "read unavailable"}: ${error.message}`);
          }
        })();
        lease.activePromise = work;
        const settled = work.then(
          (value) => ({ ok: true, value }),
          (error) => ({ ok: false, error }),
        ).finally(() => {
          lease.activePromise = null;
          lease.abortController = null;
          if (lease.releaseRequested) {
            lease.released = true;
            controllerLeases.delete(lease);
          }
        });
        timer = setTimeout(() => {
          lease.releaseRequested = true;
          const error = new Error("deadline exceeded");
          abortController.abort(error);
          deadlineReject(error);
        }, controllerTimeoutMs);
        try {
          const result = await Promise.race([
            settled.then((outcome) => {
              if (!outcome.ok) throw outcome.error;
              return outcome.value;
            }),
            deadline,
          ]);
          if (!retain) lease.release();
          return result;
        } catch (error) {
          lease.release();
          if (error instanceof ControllerError) throw error;
          const ErrorType = mutation ? AmbiguousControllerError : ControllerReadError;
          throw new ErrorType(`controller ${mutation ? "outcome unknown" : "read unavailable"}: ${error.message}`);
        } finally {
          clearTimeout(timer);
        }
      },
      release(reason = undefined) {
        if (lease.released) return;
        lease.releaseRequested = true;
        if (reason && lease.abortController && !lease.abortController.signal.aborted) lease.abortController.abort(reason);
        if (!lease.activePromise) {
          lease.released = true;
          controllerLeases.delete(lease);
        }
      },
    };
    controllerLeases.add(lease);
    return lease;
  }

  function requireControllerLease() {
    const lease = acquireControllerLease();
    if (!lease) throw new ControllerCapacityError();
    return lease;
  }

  async function controllerRequest(pathname, init = undefined, mutation = false, suppliedLease = null, retain = false) {
    const lease = suppliedLease ?? requireControllerLease();
    return lease.execute(pathname, init, mutation, retain);
  }

  function controllerWorkState() {
    return {
      activeCalls: [...controllerLeases].filter((lease) => lease.activePromise).length,
      admitted: controllerLeases.size,
      shuttingDown: controllerShuttingDown,
    };
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
        const requestOrigin = normalizedPublicOrigin(origin, "request Origin");
        const directScheme = req.socket.encrypted ? "https" : "http";
        const expectedOrigin = publicOrigin ?? (allowSyntheticTestOrigin
          ? normalizedPublicOrigin(`${directScheme}://${req.get("Host")}`, "synthetic test origin")
          : null);
        if (!expectedOrigin) return res.status(403).json({ error: "origin denied" });
        if (requestOrigin !== expectedOrigin) return res.status(403).json({ error: "origin denied" });
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
      const schedule = { ...semanticPayload, lastRun: null, enabled: true, revision: 1 };
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
      if (!Object.hasOwn(data.schedules, parsed.id)) return { missing: true };
      if (scheduleDispatchInProgress(data, parsed.id)) return { dispatching: true };
      const previous = data.schedules[parsed.id];
      data.schedules[parsed.id] = {
        ...previous,
        ...parsed,
        revision: scheduleRevision(previous) + 1,
      };
      delete data.schedules[parsed.id].id;
      return { schedule: data.schedules[parsed.id] };
    });
    if (updated.missing) return res.status(404).json({ error: "schedule not found" });
    if (updated.dispatching) return scheduleDispatchRetry(res);
    res.json(updated.schedule);
  }));

  app.delete("/api/schedules/delete", wrap(async (req, res) => {
    const parsed = deleteBody(req.body, { requestId: true });
    const payloadHash = digest({ id: parsed.id });
    const result = await repository.mutate((data) => {
      const prior = data.operations[parsed.requestId];
      if (prior) return operationMatches(prior, parsed.requestId, "schedule-delete", payloadHash) ? { prior } : { conflict: true };
      if (!Object.hasOwn(data.schedules, parsed.id)) return { missing: true };
      if (scheduleDispatchInProgress(data, parsed.id)) return { dispatching: true };
      delete data.schedules[parsed.id];
      const now = Date.now();
      const operation = { id: parsed.requestId, type: "schedule-delete", payloadHash, state: "completed", createdAt: now, updatedAt: now };
      data.operations[parsed.requestId] = operation;
      return { operation };
    });
    if (result.conflict) return res.status(409).json({ error: "requestId was already used for another operation" });
    if (result.missing) return res.status(404).json({ error: "schedule not found" });
    if (result.dispatching) return scheduleDispatchRetry(res);
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

  app.get("/api/tasks", wrap(async (req, res) => {
    try {
      return res.json(await controllerRequest("/tasks"));
    } catch (error) {
      if (error?.code !== "CONTROLLER_OVERLOADED") throw error;
      res.set("Retry-After", "1");
      return res.status(503).json({
        error: "controller busy",
        kind: "read_overload",
        recovery: "Try again shortly.",
      });
    }
  }));

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
    const preflight = (await repository.read()).operations[parsed.requestId];
    if (preflight) {
      if (!operationMatches(preflight, parsed.requestId, "manual-start", payloadHash)) {
        return res.status(409).json({ error: "requestId was already used for another operation" });
      }
      const status = preflight.state === "completed" ? 200 : preflight.state === "rejected" ? 502 : 202;
      return res.status(status).json(operationPublic(preflight));
    }
    const controllerLease = requireControllerLease();
    let claim;
    try {
      claim = await repository.mutate((data) => {
        const prior = data.operations[parsed.requestId];
        if (prior) return operationMatches(prior, parsed.requestId, "manual-start", payloadHash) ? { prior } : { conflict: true };
        const now = Date.now();
        const operation = { id: parsed.requestId, type: "manual-start", payloadHash, state: "pending", createdAt: now, updatedAt: now };
        data.operations[parsed.requestId] = operation;
        return { operation };
      });
    } catch (error) {
      controllerLease.release();
      throw error;
    }
    if (claim.conflict) {
      controllerLease.release();
      return res.status(409).json({ error: "requestId was already used for another operation" });
    }
    if (claim.prior) {
      controllerLease.release();
      const status = claim.prior.state === "completed" ? 200 : claim.prior.state === "rejected" ? 502 : 202;
      return res.status(status).json(operationPublic(claim.prior));
    }

    try {
      await controllerRequest("/tasks/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tasks: [payload] }),
      }, true, controllerLease);
      await options.afterControllerContact?.({ repository, type: "manual-start", requestId: parsed.requestId });
      const completed = await repository.mutate((data) => {
        const operation = data.operations[parsed.requestId];
        operation.state = "completed";
        operation.updatedAt = Date.now();
        addHistory(data, parsed.zones, "Started", "Remote", undefined, operation.id);
        return operation;
      });
      return res.status(201).json(operationPublic(completed));
    } catch (error) {
      if (error?.code === "REPOSITORY_OVERLOADED") {
        return res.status(202).json(operationPublic(claim.operation));
      }
      const state = error instanceof ControllerRejectedError ? "rejected" : "outcome_unknown";
      let operation;
      try {
        operation = await repository.mutate((data) => {
          const current = data.operations[parsed.requestId];
          current.state = state;
          current.updatedAt = Date.now();
          if (state === "outcome_unknown") addHistory(data, parsed.zones, "Outcome unknown", "Remote", undefined, current.id);
          return current;
        });
      } catch (persistenceError) {
        if (persistenceError?.code === "REPOSITORY_OVERLOADED") return res.status(202).json(operationPublic(claim.operation));
        throw persistenceError;
      }
      if (state === "rejected") return res.status(502).json({ ...operationPublic(operation), error: error.message });
      return res.status(202).json(operationPublic(operation));
    }
  }));

  app.delete("/api/tasks/delete", wrap(async (req, res) => {
    const parsed = deleteBody(req.body, { requestId: true });
    const payloadHash = digest({ id: parsed.id });
    const preflight = (await repository.read()).operations[parsed.requestId];
    if (preflight) {
      if (!operationMatches(preflight, parsed.requestId, "task-delete", payloadHash)) {
        return res.status(409).json({ error: "requestId was already used for another operation" });
      }
      const status = preflight.state === "completed" ? 200 : preflight.state === "rejected" ? 502 : 202;
      return res.status(status).json(operationPublic(preflight));
    }
    const controllerLease = requireControllerLease();
    let claim;
    try {
      claim = await repository.mutate((data) => {
        const prior = data.operations[parsed.requestId];
        if (prior) return operationMatches(prior, parsed.requestId, "task-delete", payloadHash) ? { prior } : { conflict: true };
        const now = Date.now();
        const operation = { id: parsed.requestId, type: "task-delete", payloadHash, state: "pending", createdAt: now, updatedAt: now };
        data.operations[parsed.requestId] = operation;
        return { operation };
      });
    } catch (error) {
      controllerLease.release();
      throw error;
    }
    if (claim.conflict) {
      controllerLease.release();
      return res.status(409).json({ error: "requestId was already used for another operation" });
    }
    if (claim.prior) {
      controllerLease.release();
      const status = claim.prior.state === "completed" ? 200 : claim.prior.state === "rejected" ? 502 : 202;
      return res.status(status).json(operationPublic(claim.prior));
    }

    let task;
    try {
      const current = await controllerRequest("/tasks", undefined, false, controllerLease, true);
      task = current.tasks.find((entry) => String(entry.id) === parsed.id);
    } catch (error) {
      controllerLease.release();
      const operation = await repository.mutate((data) => {
        const currentOperation = data.operations[parsed.requestId];
        currentOperation.state = "rejected";
        currentOperation.updatedAt = Date.now();
        return currentOperation;
      });
      return res.status(error instanceof ControllerRejectedError ? 502 : 503).json({ ...operationPublic(operation), error: "Could not read controller task state; no Stop command was sent." });
    }
    if (!task) {
      controllerLease.release();
      await repository.mutate((data) => {
        data.operations[parsed.requestId].state = "rejected";
        data.operations[parsed.requestId].updatedAt = Date.now();
      });
      return res.status(404).json({ error: "task not found" });
    }
    try {
      await controllerRequest(`/tasks/delete?id=${encodeURIComponent(parsed.id)}`, { method: "DELETE" }, true, controllerLease);
      await options.afterControllerContact?.({ repository, type: "task-delete", requestId: parsed.requestId });
      const operation = await repository.mutate((data) => {
        const currentOperation = data.operations[parsed.requestId];
        currentOperation.state = "completed";
        currentOperation.zones = task.zones;
        currentOperation.updatedAt = Date.now();
        addHistory(data, task.zones, "Stopped", "Remote", undefined, currentOperation.id);
        return currentOperation;
      });
      res.status(201).json(operationPublic(operation));
    } catch (error) {
      if (error?.code === "REPOSITORY_OVERLOADED") {
        return res.status(202).json(operationPublic(claim.operation));
      }
      const state = error instanceof ControllerRejectedError ? "rejected" : "outcome_unknown";
      let operation;
      try {
        operation = await repository.mutate((data) => {
          const currentOperation = data.operations[parsed.requestId];
          currentOperation.state = state;
          currentOperation.zones = task.zones;
          currentOperation.updatedAt = Date.now();
          if (state === "outcome_unknown") addHistory(data, task.zones, "Outcome unknown", "Remote", undefined, currentOperation.id);
          return currentOperation;
        });
      } catch (persistenceError) {
        if (persistenceError?.code === "REPOSITORY_OVERLOADED") return res.status(202).json(operationPublic(claim.operation));
        throw persistenceError;
      }
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
        const controllerLease = acquireControllerLease();
        if (!controllerLease) continue;
        const operationId = `schedule:${id}:${occurrence}`;
        let claimed;
        try {
          claimed = await repository.mutate((data) => {
            const prior = data.operations[operationId];
            if (prior) {
              if (prior.type !== "schedule-start" || prior.scheduleId !== id) return null;
              if (prior.state === "dispatching") {
                reconcileInactiveScheduleDispatches(data);
                return null;
              }
              return prior.state === "pending" ? structuredClone(prior) : null;
            }
            const live = data.schedules[id];
            if (!live || !live.enabled || !live.days.includes(day) || live.startTime !== clock) return null;
            const revision = scheduleRevision(live);
            live.revision = revision;
            const payload = structuredClone(live.tasks);
            const payloadHash = digest(payload);
            const createdAt = Date.now();
            data.operations[operationId] = {
              id: operationId,
              type: "schedule-start",
              scheduleId: id,
              scheduleRevision: revision,
              occurrence,
              payload,
              payloadHash,
              state: "pending",
              createdAt,
              updatedAt: createdAt,
            };
            return structuredClone(data.operations[operationId]);
          });
        } catch (error) {
          controllerLease.release();
          throw error;
        }
        if (!claimed) {
          controllerLease.release();
          continue;
        }
        await options.beforeScheduleDispatchTransition?.({ repository, operationId, scheduleId: id });
        const dispatch = await repository.mutate((data) => {
          const operation = data.operations[operationId];
          if (!operation || operation.state !== "pending") return null;
          const live = data.schedules[id];
          const stillCurrent = live && live.enabled && live.days.includes(day) && live.startTime === clock &&
            operation.occurrence === occurrence && operation.scheduleRevision === scheduleRevision(live) &&
            operation.payloadHash === digest(live.tasks);
          if (!stillCurrent) {
            operation.state = "cancelled";
            operation.cancelReason = "schedule_changed";
            operation.updatedAt = Date.now();
            return null;
          }
          const dispatchStartedAt = Date.now();
          operation.state = "dispatching";
          operation.dispatchOwner = scheduleDispatchOwner;
          operation.dispatchPid = process.pid;
          operation.updatedAt = dispatchStartedAt;
          live.lastRun = Math.floor(now.getTime() / 1000);
          return structuredClone(operation);
        });
        if (!dispatch) {
          controllerLease.release();
          continue;
        }
        claimed = dispatch;
        const dispatchToken = `${scheduleDispatchOwner}:${operationId}`;
        activeScheduleDispatches.add(dispatchToken);
        try {
          const controllerCall = controllerRequest("/tasks/add", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tasks: claimed.payload }),
          }, true, controllerLease);
          const physicalWork = controllerLease.activePromise;
          const markPhysicalSettlement = async () => {
            activeScheduleDispatches.delete(dispatchToken);
            try {
              await repository.mutate((data) => {
                const operation = data.operations[operationId];
                if (operation) dispatchOperationSettled(operation);
              });
            } catch {}
          };
          if (physicalWork) physicalWork.then(markPhysicalSettlement, markPhysicalSettlement).catch(() => {});
          else activeScheduleDispatches.delete(dispatchToken);
          await controllerCall;
          await repository.mutate((data) => {
            const operation = data.operations[operationId];
            operation.state = "completed";
            operation.updatedAt = Date.now();
            let timestamp = Math.floor(now.getTime() / 1000);
            for (const task of claimed.payload) {
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
              for (const task of claimed.payload) addHistory(data, task.zones, "Outcome unknown", "Schedule", Math.floor(now.getTime() / 1000), operationId);
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
  function beginControllerShutdown() {
    stopBackgroundJobs();
    if (controllerShuttingDown) return;
    controllerShuttingDown = true;
    const shutdownError = new Error("server shutting down");
    for (const lease of controllerLeases) lease.release(shutdownError);
  }
  async function cleanup() {
    beginControllerShutdown();
    const draining = [...controllerLeases]
      .map((lease) => lease.activePromise)
      .filter(Boolean)
      .map((work) => Promise.resolve(work).catch(() => {}));
    if (draining.length) {
      await Promise.race([
        Promise.allSettled(draining),
        new Promise((resolve) => setTimeout(resolve, controllerShutdownDrainMs)),
      ]);
    }
    activeScheduleDispatchOwners.delete(scheduleDispatchOwner);
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
    if (err instanceof ControllerReadError) return res.status(503).json({
      error: "controller read unavailable",
      kind: "read_unavailable",
      recovery: "Refresh controller status when the controller is available.",
    });
    if (err instanceof AmbiguousControllerError) return res.status(503).json({ error: "controller outcome unknown", recovery: "Check controller status before retrying." });
    if (err?.code === "REPOSITORY_OVERLOADED" || err?.code === "CONTROLLER_OVERLOADED") {
      res.set("Retry-After", "1");
      return res.status(503).json({
        error: err.code === "CONTROLLER_OVERLOADED" ? "controller work capacity unavailable" : "datastore busy",
        outcome: "not_applied",
        requestId: typeof req.body?.requestId === "string" ? req.body.requestId : undefined,
        recovery: "Not applied. Retry this same requestId after the indicated delay.",
      });
    }
    console.error(err.stack ?? err);
    res.status(500).json({ error: "internal error" });
  });

  return { app, dataPath, demo, repository, refreshActiveZones, runScheduleTick, startBackgroundJobs, stopBackgroundJobs, beginControllerShutdown, controllerWorkState, cleanup };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const port = Number(process.env.PORT || 5000);
  const host = process.env.HOST || "127.0.0.1";
  const startup = resolveStartupConfig();
  const instance = await createApp(startup);
  if (!instance.demo) instance.startBackgroundJobs();
  const server = instance.app.listen(port, host, () => {
    console.log(`Sprinkler Webserver listening on http://${host}:${port}${instance.demo ? " (demo mode)" : ""}`);
  });
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    instance.beginControllerShutdown();
    await new Promise((resolve) => server.close(resolve));
    await instance.cleanup();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
