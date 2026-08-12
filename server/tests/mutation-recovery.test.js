import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadRecovery() {
  const values = new Map();
  const sessionStorage = {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
  const window = { sessionStorage };
  const source = await fs.readFile(path.join(root, "public/scripts/mutation-recovery.js"), "utf8");
  vm.runInNewContext(source, { window, sessionStorage, fetch: async () => { throw new Error("not used"); }, setTimeout, Promise, Number, JSON, encodeURIComponent });
  return { recovery: window.MutationRecovery, sessionStorage };
}

test("task delete semantics preserve exact Stop and Remove recovery language", async () => {
  const { recovery } = await loadRecovery();
  const stop = recovery.taskDeleteSemantics("stop");
  const remove = recovery.taskDeleteSemantics("remove");

  assert.deepEqual({ kind: stop.kind, label: stop.label, progress: stop.progress, success: stop.success },
    { kind: "stop", label: "Stop", progress: "Stopping", success: "Task stopped" });
  assert.deepEqual({ kind: remove.kind, label: remove.label, progress: remove.progress, success: remove.success },
    { kind: "remove", label: "Remove", progress: "Removing", success: "Task removed" });
  assert.equal(remove.notApplied(1), "Datastore busy · Remove was not applied. Retry this same Remove in 1 second.");
  assert.equal(remove.notApplied(2), "Datastore busy · Remove was not applied. Retry this same Remove in 2 seconds.");
  assert.equal(remove.conflict, "Remove conflict · task unchanged. Refresh status before a deliberate new Remove.");
  assert.equal(remove.pending, "Remove outcome unknown · reconciling. No new Remove will be sent.");
  assert.equal(remove.notCommitted, "Remove not committed · retry only this same Remove.");
  assert.equal(remove.unresolved, "Remove outcome unknown · check the visible task state. No new Remove will be sent.");
  for (const value of Object.values(remove).filter((entry) => typeof entry === "string")) assert.doesNotMatch(value, /Stop/);
});

test("task delete recovery inventory retains kind and stable request payload without cross-kind overwrite", async () => {
  const { recovery } = await loadRecovery();
  recovery.storage("task-delete.running").save({ requestId: "stop-key", payload: { id: "running" }, operationKind: "stop", recoveryState: "pending" });
  recovery.storage("task-delete.queued").save({ requestId: "remove-key", payload: { id: "queued" }, operationKind: "remove", recoveryState: "retry", retryAt: 42 });

  const entries = recovery.storageEntries("task-delete.");
  assert.equal(entries.length, 2);
  assert.equal(JSON.stringify(entries.map(({ scope, value }) => ({ scope, value }))), JSON.stringify([
    { scope: "task-delete.running", value: { requestId: "stop-key", payload: { id: "running" }, operationKind: "stop", recoveryState: "pending" } },
    { scope: "task-delete.queued", value: { requestId: "remove-key", payload: { id: "queued" }, operationKind: "remove", recoveryState: "retry", retryAt: 42 } },
  ]));
});
