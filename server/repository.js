import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const EMPTY_DATA = Object.freeze({ schedules: {}, history: [], operations: {} });
const REVISION = Symbol("repositoryRevision");
const SNAPSHOT_FORMAT = 2;
const MAX_REVISION = Number.MAX_SAFE_INTEGER - 1;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const operationTypes = new Set(["schedule-create", "schedule-delete", "manual-start", "task-delete", "schedule-start"]);
const admissions = new Map();

export class RepositoryOverloadedError extends Error {
  constructor() {
    super("datastore write admission overloaded");
    this.code = "REPOSITORY_OVERLOADED";
    this.status = 503;
  }
}

function normalizeOperations(operations) {
  if (!operations || typeof operations !== "object" || Array.isArray(operations)) return {};
  return Object.fromEntries(Object.entries(operations).map(([id, operation]) => {
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
      return [id, { id, type: "legacy-unknown", state: "invalid" }];
    }
    const validHash = typeof operation.payloadHash === "string" && /^[a-f0-9]{64}$/.test(operation.payloadHash);
    if (operation.id === id && (operation.type === "legacy-unknown" || (operationTypes.has(operation.type) && validHash))) return [id, operation];
    return [id, { ...operation, id, type: "legacy-unknown" }];
  }));
}

function admit(key, maximum, work) {
  let admission = admissions.get(key);
  if (!admission) {
    admission = { pending: 0, tail: Promise.resolve() };
    admissions.set(key, admission);
  }
  if (admission.pending >= maximum) throw new RepositoryOverloadedError();
  admission.pending += 1;
  const result = admission.tail.then(work);
  const settled = result.finally(() => { admission.pending -= 1; }).then(() => {}, () => {});
  admission.tail = settled;
  settled.then(() => {
    if (admission.pending === 0 && admission.tail === settled) admissions.delete(key);
  });
  return result;
}

function normalize(data, revision = Number.isSafeInteger(data?.[REVISION]) ? data[REVISION] : 0) {
  const normalized = {
    schedules: data && typeof data.schedules === "object" && !Array.isArray(data.schedules) ? data.schedules : {},
    history: Array.isArray(data?.history) ? data.history : [],
    operations: data && typeof data.operations === "object" && !Array.isArray(data.operations) ? data.operations : {},
  };
  Object.defineProperty(normalized, REVISION, { value: revision, writable: true });
  return normalized;
}

function dataPayload(data) {
  const normalized = normalize(data);
  return {
    schedules: normalized.schedules,
    history: normalized.history,
    operations: normalized.operations,
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function v2Checksum(payload, revision) {
  return crypto.createHash("sha256").update(canonicalJson({
    format: SNAPSHOT_FORMAT,
    revision,
    payload,
  })).digest("hex");
}

function legacyChecksum(data) {
  return crypto.createHash("sha256").update(JSON.stringify(dataPayload(data))).digest("hex");
}

function serialize(data, revision) {
  const payload = dataPayload(data);
  return `${JSON.stringify({
    ...payload,
    _repository: { format: SNAPSHOT_FORMAT, revision, checksum: v2Checksum(payload, revision) },
  })}\n`;
}

function parseSnapshot(raw) {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid datastore snapshot");
  const metadata = parsed._repository;
  if (metadata === undefined) return { data: normalize(parsed, 0), kind: "legacy" };
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("invalid datastore revision metadata");
  if (metadata.format === 1) {
    if (!Number.isSafeInteger(metadata.revision) || metadata.revision < 0 || metadata.checksum !== legacyChecksum(parsed)) {
      throw new Error("invalid datastore revision metadata");
    }
    return { data: normalize(parsed, 0), kind: "legacy" };
  }
  const payload = dataPayload(parsed);
  const metadataKeys = Object.keys(metadata).sort();
  if (metadata.format !== SNAPSHOT_FORMAT || metadataKeys.join(",") !== "checksum,format,revision" ||
      !Number.isSafeInteger(metadata.revision) || metadata.revision < 0 || metadata.revision > MAX_REVISION ||
      typeof metadata.checksum !== "string" || metadata.checksum !== v2Checksum(payload, metadata.revision)) {
    throw new Error("invalid datastore revision metadata");
  }
  return { data: normalize(parsed, metadata.revision), kind: "v2", checksum: metadata.checksum };
}

async function processStartIdentity(pid) {
  if (process.platform === "linux") {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const fieldsAfterCommand = stat.slice(close + 2).split(" ");
    const startTicks = fieldsAfterCommand[19];
    if (!/^\d+$/.test(startTicks || "")) throw new Error("invalid process start identity");
    return `linux:${startTicks}`;
  }
  const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="], { timeout: 1000 });
  const identity = stdout.trim();
  if (!identity) throw Object.assign(new Error("process not found"), { code: "ESRCH" });
  return identity;
}

const currentProcessStart = processStartIdentity(process.pid);

export class JsonRepository {
  constructor(dataPath, {
    recoverMissing = false,
    lockTimeoutMs = 5000,
    staleLockMs = 30000,
    maxPendingWrites = 1024,
    onDurabilityBoundary = null,
  } = {}) {
    this.dataPath = dataPath;
    this.backupPath = `${dataPath}.bak`;
    this.lockPath = `${dataPath}.lock`;
    this.recoverMissing = recoverMissing;
    this.lockTimeoutMs = lockTimeoutMs;
    this.staleLockMs = staleLockMs;
    if (!Number.isSafeInteger(maxPendingWrites) || maxPendingWrites < 1) throw new TypeError("maxPendingWrites must be a positive integer");
    this.maxPendingWrites = maxPendingWrites;
    this.admissionKey = path.resolve(dataPath);
    this.onDurabilityBoundary = onDurabilityBoundary;
  }

  async init() {
    await fs.mkdir(path.dirname(this.dataPath), { recursive: true, mode: 0o700 });
    try {
      await fs.chmod(path.dirname(this.dataPath), 0o700);
    } catch {}
    await this.#withLock(async () => {
      try {
        await this.#readCurrent({ repair: true });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await this.#writeRevision(structuredClone(EMPTY_DATA), 1);
      }
    });
    return this;
  }

  async read() {
    try {
      return await this.#readCurrent();
    } catch (error) {
      if (error.code !== "ENOENT" || !this.recoverMissing) throw error;
      return this.#withLock(async () => {
        try {
          return await this.#readCurrent({ repair: true });
        } catch (inner) {
          if (inner.code !== "ENOENT") throw inner;
          const empty = structuredClone(EMPTY_DATA);
          await this.#writeRevision(empty, 1);
          return normalize(empty, 1);
        }
      });
    }
  }

  async mutate(mutator) {
    return this.#withLock(async () => {
      let data;
      try {
        data = await this.#readCurrent({ repair: true });
      } catch (error) {
        if (error.code !== "ENOENT" || !this.recoverMissing) throw error;
        data = normalize(structuredClone(EMPTY_DATA), 0);
      }
      const result = await mutator(data);
      data.operations = normalizeOperations(data.operations);
      await this.#writeRevision(data, data[REVISION] + 1);
      return result;
    });
  }

  async #readSnapshot(filePath) {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = parseSnapshot(raw);
      return { filePath, raw, ...parsed, error: null };
    } catch (error) {
      return { filePath, raw: null, data: null, kind: null, checksum: null, error };
    }
  }

  async #readCurrent({ repair = false } = {}) {
    const [primary, recovery] = await Promise.all([
      this.#readSnapshot(this.dataPath),
      this.#readSnapshot(this.backupPath),
    ]);
    const valid = [primary, recovery].filter((snapshot) => snapshot.data);
    if (!valid.length) {
      if (primary.error?.code === "ENOENT" && recovery.error?.code === "ENOENT") throw primary.error;
      throw primary.error?.code !== "ENOENT" ? primary.error : recovery.error;
    }

    const v2 = valid.filter((snapshot) => snapshot.kind === "v2");
    let selected;
    if (v2.length) {
      v2.sort((left, right) => right.data[REVISION] - left.data[REVISION] || (left.filePath === this.dataPath ? -1 : 1));
      if (v2.length === 2 && v2[0].data[REVISION] === v2[1].data[REVISION] && v2[0].checksum !== v2[1].checksum) {
        throw new Error("divergent datastore snapshots at equal revision");
      }
      selected = v2[0];
    } else {
      // Legacy revisions were not bound to their payload. Never use them for ranking.
      selected = primary.data ? primary : recovery;
    }

    const newest = selected.data;
    newest.operations = normalizeOperations(newest.operations);
    const revision = selected.kind === "v2" ? newest[REVISION] : 1;
    const serialized = serialize(newest, revision);
    const synchronized = primary.raw === serialized && recovery.raw === serialized;
    if (repair && !synchronized) await this.#writeRevision(newest, revision);
    return normalize(newest, revision);
  }

  async #ownerIsDeadOrReused(owner) {
    if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0 || typeof owner.processStart !== "string") return true;
    try {
      process.kill(owner.pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return true;
      if (error.code !== "EPERM") return false;
    }
    try {
      return await processStartIdentity(owner.pid) !== owner.processStart;
    } catch (error) {
      return error.code === "ESRCH";
    }
  }

  async #recoverExpiredLock() {
    let stat;
    try {
      stat = await fs.stat(this.lockPath);
    } catch (error) {
      if (error.code === "ENOENT") return true;
      throw error;
    }
    if (Date.now() - stat.mtimeMs <= this.staleLockMs) return false;

    let owner = null;
    try {
      owner = JSON.parse(await fs.readFile(path.join(this.lockPath, "owner.json"), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) return false;
    }
    if (owner && !(await this.#ownerIsDeadOrReused(owner))) return false;

    // Rename elects exactly one recoverer and prevents an old token from deleting a new lock.
    const quarantine = `${this.lockPath}.recovered-${process.pid}-${crypto.randomUUID()}`;
    try {
      await fs.rename(this.lockPath, quarantine);
    } catch (error) {
      if (["ENOENT", "EEXIST", "ENOTEMPTY"].includes(error.code)) return true;
      throw error;
    }
    try {
      if (owner) {
        const moved = JSON.parse(await fs.readFile(path.join(quarantine, "owner.json"), "utf8"));
        if (moved.token !== owner.token) {
          try { await fs.rename(quarantine, this.lockPath); } catch {}
          return false;
        }
      }
      await fs.rm(quarantine, { recursive: true, force: true });
      return true;
    } catch {
      try { await fs.rename(quarantine, this.lockPath); } catch {}
      return false;
    }
  }

  async #acquireLock() {
    const started = Date.now();
    const processStart = await currentProcessStart;
    while (true) {
      const token = crypto.randomUUID();
      const candidate = `${this.lockPath}.candidate-${process.pid}-${token}`;
      try {
        await fs.mkdir(candidate, { mode: 0o700 });
        await fs.writeFile(path.join(candidate, "owner.json"), JSON.stringify({
          version: 1,
          token,
          pid: process.pid,
          processStart,
          leaseUntil: Date.now() + this.staleLockMs,
        }), { mode: 0o600 });
        await fs.rename(candidate, this.lockPath);
        return { token, processStart };
      } catch (error) {
        await fs.rm(candidate, { recursive: true, force: true }).catch(() => {});
        if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
        await this.#recoverExpiredLock();
        if (Date.now() - started >= this.lockTimeoutMs) throw new Error("datastore lock timeout");
        await sleep(8 + Math.floor(Math.random() * 8));
      }
    }
  }

  async #renewLock(lock) {
    let owner;
    try {
      owner = JSON.parse(await fs.readFile(path.join(this.lockPath, "owner.json"), "utf8"));
    } catch {
      return false;
    }
    if (owner.token !== lock.token) return false;
    const tmp = path.join(this.lockPath, `.owner.${lock.token}.tmp`);
    try {
      await fs.writeFile(tmp, JSON.stringify({ ...owner, leaseUntil: Date.now() + this.staleLockMs }), { mode: 0o600 });
      const current = JSON.parse(await fs.readFile(path.join(this.lockPath, "owner.json"), "utf8"));
      if (current.token !== lock.token) return false;
      await fs.rename(tmp, path.join(this.lockPath, "owner.json"));
      const now = new Date();
      await fs.utimes(this.lockPath, now, now);
      return true;
    } catch {
      return false;
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
  }

  async #releaseLock(lock) {
    let owner;
    try {
      owner = JSON.parse(await fs.readFile(path.join(this.lockPath, "owner.json"), "utf8"));
    } catch {
      return;
    }
    if (owner.token !== lock.token) return;
    const released = `${this.lockPath}.released-${process.pid}-${lock.token}`;
    try {
      await fs.rename(this.lockPath, released);
      const moved = JSON.parse(await fs.readFile(path.join(released, "owner.json"), "utf8"));
      if (moved.token !== lock.token) {
        try { await fs.rename(released, this.lockPath); } catch {}
        return;
      }
      await fs.rm(released, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  #withLock(work) {
    return admit(this.admissionKey, this.maxPendingWrites, () => this.#withCrossProcessLock(work));
  }

  async #withCrossProcessLock(work) {
    const lock = await this.#acquireLock();
    let active = true;
    let renewal = Promise.resolve();
    const heartbeatMs = Math.max(10, Math.floor(this.staleLockMs / 3));
    const heartbeat = setInterval(() => {
      if (active) renewal = renewal.then(() => this.#renewLock(lock));
    }, heartbeatMs);
    heartbeat.unref?.();
    try {
      return await work();
    } finally {
      active = false;
      clearInterval(heartbeat);
      await renewal;
      await this.#releaseLock(lock);
    }
  }

  async #syncDirectory(directory) {
    try {
      const dirHandle = await fs.open(directory, "r");
      try { await dirHandle.sync(); } finally { await dirHandle.close(); }
    } catch (error) {
      if (!["EINVAL", "ENOTSUP", "EISDIR"].includes(error.code)) throw error;
    }
  }

  async #boundary(name) {
    await this.onDurabilityBoundary?.(name);
  }

  async #replaceDurably(target, payload, prefix) {
    const directory = path.dirname(target);
    const tmp = path.join(directory, `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    const handle = await fs.open(tmp, "wx", 0o600);
    try {
      await handle.writeFile(payload, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(tmp, target);
      await fs.chmod(target, 0o600);
      await this.#boundary(`${prefix}-renamed`);
      await this.#syncDirectory(directory);
      await this.#boundary(`${prefix}-directory-synced`);
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
  }

  async #writeRevision(data, revision) {
    const payload = serialize(data, revision);
    await this.#replaceDurably(this.dataPath, payload, "primary");
    await this.#replaceDurably(this.backupPath, payload, "recovery");
    data[REVISION] = revision;
  }
}
