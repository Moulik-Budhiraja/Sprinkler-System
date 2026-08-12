const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FORBIDDEN_IDS = new Set(["__proto__", "prototype", "constructor"]);
const HISTORY_EVENTS = new Set(["Started", "Stopped"]);
const HISTORY_REASONS = new Set(["Manual", "Completed", "Remote", "Home Assistant", "Schedule"]);

export class ValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function object(value, name = "body") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError(`${name} must be an object`);
  return value;
}

function exactKeys(value, allowed, name = "body") {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new ValidationError(`${name} contains unsupported fields`);
}

export function safeId(value, name = "id", { min = 1 } = {}) {
  if (typeof value !== "string" || value.length < min || !SAFE_ID.test(value) || FORBIDDEN_IDS.has(value)) {
    throw new ValidationError(`${name} is invalid`);
  }
  return value;
}

function boolean(value, name) {
  if (typeof value !== "boolean") throw new ValidationError(`${name} must be a boolean`);
  return value;
}

function boundedInteger(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

export function zones(value, { max = 8 } = {}) {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) throw new ValidationError("zones must be a nonempty array");
  const parsed = value.map((zone) => boundedInteger(zone, "zone", 1, max));
  if (new Set(parsed).size !== parsed.length) throw new ValidationError("zones must be unique");
  return parsed;
}

function task(value, zoneMax = 8) {
  object(value, "task");
  exactKeys(value, ["zones", "runTime"], "task");
  return {
    zones: zones(value.zones, { max: zoneMax }),
    runTime: boundedInteger(value.runTime, "runTime", 1, 1440),
  };
}

function tasks(value, zoneMax = 8) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) throw new ValidationError("tasks must contain 1 to 32 tasks");
  return value.map((entry) => task(entry, zoneMax));
}

function days(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 7) throw new ValidationError("days must be a nonempty array");
  const parsed = value.map((day) => boundedInteger(day, "day", 0, 6));
  if (new Set(parsed).size !== parsed.length) throw new ValidationError("days must be unique");
  return parsed;
}

function time(value) {
  if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new ValidationError("startTime must be valid HH:MM");
  return value;
}

function name(value) {
  if (typeof value !== "string") throw new ValidationError("name must be text");
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 80) throw new ValidationError("name must contain 1 to 80 characters");
  return trimmed;
}

export function manualTaskBody(body) {
  object(body);
  exactKeys(body, ["requestId", "zones", "runTime"]);
  return {
    requestId: safeId(body.requestId, "requestId", { min: 8 }),
    zones: zones(body.zones),
    runTime: boundedInteger(body.runTime, "runTime", 1, 1440),
  };
}

export function scheduleCreateBody(body) {
  object(body);
  exactKeys(body, ["requestId", "name", "days", "startTime", "tasks"]);
  return {
    requestId: safeId(body.requestId, "requestId", { min: 8 }),
    name: name(body.name),
    days: days(body.days),
    startTime: time(body.startTime),
    tasks: tasks(body.tasks),
  };
}

export function scheduleUpdateBody(body) {
  object(body);
  exactKeys(body, ["id", "name", "days", "startTime", "tasks", "enabled"]);
  return {
    id: safeId(body.id),
    name: name(body.name),
    days: days(body.days),
    startTime: time(body.startTime),
    tasks: tasks(body.tasks),
    enabled: boolean(body.enabled, "enabled"),
  };
}

export function deleteBody(body, { requestId = false } = {}) {
  object(body);
  exactKeys(body, requestId ? ["id", "requestId"] : ["id"]);
  const result = { id: safeId(body.id) };
  if (requestId) result.requestId = safeId(body.requestId, "requestId", { min: 8 });
  return result;
}

export function zoneBody(body) {
  object(body);
  exactKeys(body, ["zone", "on"]);
  return { zone: boundedInteger(body.zone, "zone", 1, 8), on: boolean(body.on, "on") };
}

export function historyBody(body) {
  object(body);
  exactKeys(body, ["zones", "event", "reason"]);
  const event = typeof body.event === "string" ? body.event : "";
  const reason = typeof body.reason === "string" ? body.reason : "";
  if (!HISTORY_EVENTS.has(event) || !HISTORY_REASONS.has(reason)) throw new ValidationError("history event or reason is invalid");
  return { zones: zones(body.zones), event, reason };
}

export function historyLimit(value) {
  if (value === undefined) return 250;
  if (!/^\d+$/.test(String(value))) throw new ValidationError("limit must be an integer from 1 to 250");
  return boundedInteger(Number(value), "limit", 1, 250);
}
