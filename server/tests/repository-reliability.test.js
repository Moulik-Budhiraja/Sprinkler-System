import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import crypto from "node:crypto";

import { JsonRepository } from "../repository.js";

const empty = () => ({ schedules: {}, history: [], operations: {} });

async function tempPath() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sprinkler-repository-reliability-"));
  return path.join(directory, "data.json");
}

async function acknowledgedRevision(repository, index) {
  const operationId = `operation-${index}`;
  await repository.mutate((data) => {
    data.schedules[`schedule-${index}`] = { name: `Revision ${index}` };
    data.operations[operationId] = { id: operationId, requestId: `request-${index}`, state: "claimed" };
  });
}

async function snapshots(dataPath) {
  return Promise.all([dataPath, `${dataPath}.bak`].map(async (file) => JSON.parse(await fs.readFile(file, "utf8"))));
}

function legacySnapshot(payload, revision = undefined) {
  if (revision === undefined) return payload;
  const checksum = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return { ...payload, _repository: { format: 1, revision, checksum } };
}

test("latest acknowledged revision including operation claims survives absent or corrupt primary", async () => {
  for (const damage of ["absent", "corrupt"]) {
    const dataPath = await tempPath();
    const repository = await new JsonRepository(dataPath).init();
    for (let index = 1; index <= 8; index += 1) await acknowledgedRevision(repository, index);

    if (damage === "absent") await fs.rm(dataPath);
    else await fs.writeFile(dataPath, "{corrupt", "utf8");

    const recovered = await new JsonRepository(dataPath).init();
    const data = await recovered.read();
    assert.equal(Object.keys(data.schedules).length, 8, damage);
    assert.equal(Object.keys(data.operations).length, 8, damage);
    assert.equal(data.operations["operation-8"].state, "claimed", damage);
  }
});

test("valid newest primary repairs absent or corrupt backup without rolling back", async () => {
  for (const damage of ["absent", "corrupt"]) {
    const dataPath = await tempPath();
    const repository = await new JsonRepository(dataPath).init();
    for (let index = 1; index <= 4; index += 1) await acknowledgedRevision(repository, index);
    if (damage === "absent") await fs.rm(`${dataPath}.bak`);
    else await fs.writeFile(`${dataPath}.bak`, "not-json", "utf8");

    const recovered = await new JsonRepository(dataPath).init();
    assert.equal(Object.keys((await recovered.read()).operations).length, 4, damage);
    const backup = JSON.parse(await fs.readFile(`${dataPath}.bak`, "utf8"));
    assert.equal(Object.keys(backup.operations).length, 4, damage);
  }
});

test("acknowledgement follows durable primary and recovery snapshot rename and fsync boundaries", async () => {
  const dataPath = await tempPath();
  const boundaries = [];
  const repository = await new JsonRepository(dataPath, {
    onDurabilityBoundary: (boundary) => boundaries.push(boundary),
  }).init();
  boundaries.length = 0;

  await acknowledgedRevision(repository, 1);
  assert.deepEqual(boundaries, [
    "primary-renamed",
    "primary-directory-synced",
    "recovery-renamed",
    "recovery-directory-synced",
  ]);
  const primary = JSON.parse(await fs.readFile(dataPath, "utf8"));
  const backup = JSON.parse(await fs.readFile(`${dataPath}.bak`, "utf8"));
  assert.deepEqual(backup, primary);
  assert.ok(Number.isSafeInteger(primary._repository.revision));
  assert.equal(primary._repository.revision, 2);
  assert.equal(primary._repository.format, 2);
  assert.match(primary._repository.checksum, /^[a-f0-9]{64}$/);
});

test("v2 checksum rejects every protected envelope field changed without recomputing it", async () => {
  for (const tamper of [
    (snapshot) => { snapshot._repository.revision += 999; },
    (snapshot) => { snapshot._repository.format = 3; },
    (snapshot) => { snapshot._repository.checksum = "0".repeat(64); },
    (snapshot) => { snapshot.schedules.stale = { name: "forged" }; },
  ]) {
    const dataPath = await tempPath();
    const repository = await new JsonRepository(dataPath).init();
    await acknowledgedRevision(repository, 1);
    const stale = JSON.parse(await fs.readFile(`${dataPath}.bak`, "utf8"));
    await acknowledgedRevision(repository, 2);
    tamper(stale);
    await fs.writeFile(`${dataPath}.bak`, JSON.stringify(stale), "utf8");

    const restarted = await new JsonRepository(dataPath).init();
    const data = await restarted.read();
    assert.ok(data.operations["operation-2"]);
    assert.equal(data.schedules.stale, undefined);
    const [primary, recovery] = await snapshots(dataPath);
    assert.deepEqual(recovery, primary);
  }
});

test("v2 peers select the newest valid revision but fail closed on equal-revision divergence and absurd revisions", async () => {
  const dataPath = await tempPath();
  const repository = await new JsonRepository(dataPath).init();
  const older = JSON.parse(await fs.readFile(dataPath, "utf8"));
  await acknowledgedRevision(repository, 1);
  await fs.writeFile(dataPath, JSON.stringify(older), "utf8");
  const restarted = await new JsonRepository(dataPath).init();
  assert.ok((await restarted.read()).operations["operation-1"]);

  const current = JSON.parse(await fs.readFile(dataPath, "utf8"));
  const forkPath = await tempPath();
  const forkRepository = await new JsonRepository(forkPath).init();
  await forkRepository.mutate((data) => { data.schedules.fork = { name: "fork" }; });
  const divergent = await fs.readFile(forkPath, "utf8");
  await fs.writeFile(`${dataPath}.bak`, divergent, "utf8");
  await assert.rejects(new JsonRepository(dataPath).init(), /invalid datastore|divergent/i);

  current._repository.revision = Number.MAX_SAFE_INTEGER + 1;
  await fs.writeFile(dataPath, JSON.stringify(current), "utf8");
  await fs.writeFile(`${dataPath}.bak`, "corrupt", "utf8");
  await assert.rejects(new JsonRepository(dataPath).init(), /invalid datastore/i);
});

test("legacy migration prefers primary, uses recovery only when needed, and rewrites both peers as v2", async () => {
  const primaryLegacy = { schedules: { primary: { name: "primary" } }, history: [], operations: { kept: { state: "claimed" } } };
  const recoveryLegacy = { schedules: { recovery: { name: "recovery" } }, history: [], operations: {} };
  const primaryCases = [{ kind: "valid", raw: JSON.stringify(primaryLegacy) }, { kind: "absent", raw: null }, { kind: "corrupt", raw: "{corrupt" }];
  for (const primaryCase of primaryCases) {
    const dataPath = await tempPath();
    if (primaryCase.raw === null) await fs.rm(dataPath, { force: true });
    else await fs.writeFile(dataPath, primaryCase.raw, "utf8");
    await fs.writeFile(`${dataPath}.bak`, JSON.stringify(legacySnapshot(recoveryLegacy, 999999)), "utf8");
    const repository = await new JsonRepository(dataPath).init();
    const data = await repository.read();
    if (primaryCase.kind === "valid") {
      assert.ok(data.schedules.primary);
      assert.equal(data.schedules.recovery, undefined);
      assert.ok(data.operations.kept);
    } else {
      assert.ok(data.schedules.recovery);
    }
    const [writtenPrimary, writtenRecovery] = await snapshots(dataPath);
    assert.deepEqual(writtenRecovery, writtenPrimary);
    assert.equal(writtenPrimary._repository.format, 2);
  }
});

test("a valid v2 peer prevents legacy downgrade confusion and repairs restart peers", async () => {
  const dataPath = await tempPath();
  const repository = await new JsonRepository(dataPath).init();
  await acknowledgedRevision(repository, 1);
  const validV2 = await fs.readFile(`${dataPath}.bak`, "utf8");
  const legacy = { schedules: { downgraded: { name: "stale" } }, history: [], operations: {} };
  await fs.writeFile(dataPath, JSON.stringify(legacy), "utf8");
  await fs.writeFile(`${dataPath}.bak`, validV2, "utf8");
  const restarted = await new JsonRepository(dataPath).init();
  const data = await restarted.read();
  assert.ok(data.operations["operation-1"]);
  assert.equal(data.schedules.downgraded, undefined);
  const [primary, recovery] = await snapshots(dataPath);
  assert.deepEqual(primary, recovery);
  assert.equal(primary._repository.format, 2);
});

test("restart preserves the last acknowledged revision across every injected write boundary", async () => {
  for (const boundary of ["primary-renamed", "primary-directory-synced", "recovery-renamed", "recovery-directory-synced"]) {
    const dataPath = await tempPath();
    const initial = await new JsonRepository(dataPath).init();
    await acknowledgedRevision(initial, 1);
    const interrupted = await new JsonRepository(dataPath, {
      onDurabilityBoundary: (observed) => {
        if (observed === boundary) throw new Error(`injected crash after ${boundary}`);
      },
    }).init();
    await assert.rejects(acknowledgedRevision(interrupted, 2), /injected crash/);

    const restarted = await new JsonRepository(dataPath).init();
    const recovered = await restarted.read();
    assert.ok(recovered.operations["operation-1"], boundary);
    const primary = JSON.parse(await fs.readFile(dataPath, "utf8"));
    const backup = JSON.parse(await fs.readFile(`${dataPath}.bak`, "utf8"));
    assert.deepEqual(backup, primary, boundary);
  }
});

test("renewed live owner is not stolen after scaled work exceeds stale threshold", async () => {
  const dataPath = await tempPath();
  await fs.writeFile(dataPath, JSON.stringify(empty()), { mode: 0o600 });
  const first = await new JsonRepository(dataPath, { staleLockMs: 45, lockTimeoutMs: 1000 }).init();
  const second = await new JsonRepository(dataPath, { staleLockMs: 45, lockTimeoutMs: 1000 }).init();

  const slow = first.mutate(async (data) => {
    await new Promise((resolve) => setTimeout(resolve, 180));
    data.schedules.slow = { name: "slow" };
  });
  await new Promise((resolve) => setTimeout(resolve, 70));
  const competing = second.mutate((data) => { data.schedules.competing = { name: "competing" }; });
  await Promise.all([slow, competing]);

  assert.deepEqual(Object.keys((await second.read()).schedules).sort(), ["competing", "slow"]);
});

test("same-process repositories admit writes FIFO before starting each cross-process lock deadline", async () => {
  const dataPath = await tempPath();
  const first = await new JsonRepository(dataPath, { lockTimeoutMs: 25 }).init();
  const second = await new JsonRepository(dataPath, { lockTimeoutMs: 25 }).init();
  const order = [];
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  let firstAdmitted;
  const admitted = new Promise((resolve) => { firstAdmitted = resolve; });

  const slow = first.mutate(async (data) => {
    order.push("first-start");
    firstAdmitted();
    await firstBlocked;
    data.schedules.first = { name: "first" };
    order.push("first-end");
  });
  await admitted;
  const queued = second.mutate((data) => {
    order.push("second");
    data.schedules.second = { name: "second" };
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  releaseFirst();
  await Promise.all([slow, queued]);

  assert.deepEqual(order, ["first-start", "first-end", "second"]);
  assert.deepEqual(Object.keys((await first.read()).schedules).sort(), ["first", "second"]);
});

test("a failed admitted writer does not poison the same-process repository queue", async () => {
  const dataPath = await tempPath();
  let injectFailure = false;
  const failing = await new JsonRepository(dataPath, {
    onDurabilityBoundary: async (boundary) => {
      if (injectFailure && boundary === "primary-directory-synced") {
        injectFailure = false;
        throw new Error("injected queued writer failure");
      }
    },
  }).init();
  const following = await new JsonRepository(dataPath).init();
  injectFailure = true;

  const failed = failing.mutate((data) => { data.schedules.failed = { name: "failed" }; });
  const succeeded = following.mutate((data) => { data.schedules.succeeded = { name: "succeeded" }; });
  await assert.rejects(failed, /injected queued writer failure/);
  await succeeded;

  const restarted = await new JsonRepository(dataPath).init();
  assert.ok((await restarted.read()).schedules.succeeded);
});

test("same-process admission overload is bounded and returns an explicit retryable error", async () => {
  const dataPath = await tempPath();
  const first = await new JsonRepository(dataPath, { maxPendingWrites: 2 }).init();
  const second = await new JsonRepository(dataPath, { maxPendingWrites: 2 }).init();
  const third = await new JsonRepository(dataPath, { maxPendingWrites: 2 }).init();
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let admitted;
  const started = new Promise((resolve) => { admitted = resolve; });
  const active = first.mutate(async () => { admitted(); await blocked; });
  await started;
  const queued = second.mutate((data) => { data.schedules.queued = { name: "queued" }; });
  await assert.rejects(third.mutate(() => {}), (error) =>
    error.code === "REPOSITORY_OVERLOADED" && error.status === 503
  );
  release();
  await Promise.all([active, queued]);
});

test("expired crashed owner is recovered and a PID-reuse identity mismatch is not treated as the owner", async () => {
  for (const owner of [
    { token: "crashed-owner", pid: 99999999, processStart: "dead", heartbeatAt: 0 },
    { token: "reused-pid", pid: process.pid, processStart: "not-this-process", heartbeatAt: 0 },
  ]) {
    const dataPath = await tempPath();
    await fs.writeFile(dataPath, JSON.stringify(empty()), { mode: 0o600 });
    const lockPath = `${dataPath}.lock`;
    await fs.mkdir(lockPath);
    await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify(owner));
    const old = new Date(Date.now() - 5000);
    await fs.utimes(lockPath, old, old);
    const repository = await new JsonRepository(dataPath, { staleLockMs: 20, lockTimeoutMs: 500 }).init();
    await repository.mutate((data) => { data.schedules.recovered = { name: "recovered" }; });
    assert.ok((await repository.read()).schedules.recovered);
  }
});

test("competing stale-lock recoverers elect one owner and leave no quarantine or lock", async () => {
  const dataPath = await tempPath();
  await fs.writeFile(dataPath, JSON.stringify(empty()), { mode: 0o600 });
  const lockPath = `${dataPath}.lock`;
  await fs.mkdir(lockPath);
  await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ token: "dead", pid: 99999999, processStart: "dead", heartbeatAt: 0 }));
  const old = new Date(Date.now() - 5000);
  await fs.utimes(lockPath, old, old);

  const repositories = Array.from({ length: 4 }, () => new JsonRepository(dataPath, { staleLockMs: 20, lockTimeoutMs: 2000 }));
  await Promise.all(repositories.map((repository, index) => repository.mutate((data) => {
    data.schedules[`recoverer-${index}`] = { name: `recoverer-${index}` };
  })));
  assert.equal(Object.keys((await repositories[0].read()).schedules).length, 4);
  const siblings = await fs.readdir(path.dirname(dataPath));
  assert.equal(siblings.filter((name) => name.includes(".lock")).length, 0);
});

test("an old owning token cannot release a replacement owner lock", async () => {
  const dataPath = await tempPath();
  await fs.writeFile(dataPath, JSON.stringify(empty()), { mode: 0o600 });
  const repository = await new JsonRepository(dataPath, { staleLockMs: 1000, lockTimeoutMs: 2000 }).init();
  let finish;
  const blocked = new Promise((resolve) => { finish = resolve; });
  const mutation = repository.mutate(async (data) => {
    await blocked;
    data.schedules.oldOwner = { name: "old owner" };
  });

  const ownerPath = `${dataPath}.lock/owner.json`;
  let original;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { original = JSON.parse(await fs.readFile(ownerPath, "utf8")); break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(original?.token);
  const replacement = { ...original, token: "replacement-owner-token", leaseUntil: Date.now() + 5000 };
  await fs.writeFile(ownerPath, JSON.stringify(replacement), { mode: 0o600 });
  finish();
  await mutation;

  assert.equal(JSON.parse(await fs.readFile(ownerPath, "utf8")).token, replacement.token);
  await fs.rm(`${dataPath}.lock`, { recursive: true, force: true });
});
