import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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
  assert.match(primary._repository.checksum, /^[a-f0-9]{64}$/);
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
