const QUICK_TASK_DURATIONS = window.QuickTaskContract.durations;
const QUICK_TASK_DEFAULT_DURATION = window.QuickTaskContract.defaultDuration;
const VISIBLE_ZONE_COUNT = window.QuickTaskContract.visibleZoneCount;
const selectedZones = new Set();
let selectedDuration = QUICK_TASK_DEFAULT_DURATION;
let quickTaskControllerAvailable = false;
let quickTaskAmbiguous = false;
let currentTasks = [];
// True once ANY successful controller read happened this session: the
// explicit line between no-known-data (announce unavailable, claim
// nothing) and stale-last-known (re-present known facts, qualified).
let hasSyncedControllerState = false;
let startingZones = [];
let field;
let refreshInFlight = false;
let pollTimer;
const deleteRequestIds = new Map();
const manualMutationStore = window.MutationRecovery.storage("manual-start");
let pendingManualMutation = manualMutationStore.load();
let quickTaskConflict = false;
let quickTaskRetryWaiting = false;
const taskDeleteConflicts = new Map();
const pendingTaskDeletes = new Map();
const taskDeleteInFlight = new Set();

const $ = (selector) => document.querySelector(selector);
const node = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};
const requestId = (prefix) => `${prefix}-${crypto.randomUUID()}`;

async function request(url, options) {
  const response = await fetch(url, options);
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok) {
    const error = new Error(data.error || `${response.status} ${response.statusText}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function formatTime(value) {
  if (!/^\d{2}:\d{2}$/.test(value || "")) return "Time unavailable";
  const [hour, minute] = value.split(":").map(Number);
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(2000, 0, 1, hour, minute));
}

function relativeTime(timestamp) {
  if (!Number.isFinite(timestamp)) return "Not yet run";
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp * 1000) / 60000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} hr ago`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(timestamp * 1000));
}

function formatDate(timestamp) {
  if (!Number.isFinite(timestamp)) return "Date unavailable";
  return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "short", day: "numeric" }).format(new Date(timestamp * 1000));
}

function formatClock(timestamp) {
  if (!Number.isFinite(timestamp)) return "—";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(timestamp * 1000));
}

function setControllerStatus(state) {
  const status = $("#mobileControllerStatus");
  const wrap = status?.closest(".controller-status");
  const freshness = $("[data-testid=controller-freshness]");
  if (status) status.textContent = state === "online" ? "Controller online" : state === "busy" ? "Controller busy · try again shortly" : state === "stale" ? "Controller offline · last known state" : "Controller offline";
  wrap?.classList.toggle("offline", state !== "online" && state !== "busy");
  if (freshness) {
    freshness.dataset.state = state === "online" ? "live" : state;
    // "last-known" may only ever be claimed when known state actually
    // exists (state === "stale"); a fresh outage has no data to show.
    freshness.textContent = state === "online" ? "Controller status current"
      : state === "busy" ? "Controller busy · try again shortly"
        : state === "stale" ? "Controller offline · showing stale last-known state"
          : "Controller offline · no data received yet";
  }
}

function updateQuickTaskSubmit() {
  const submit = document.querySelector("#quickTaskForm [type=submit]");
  if (!submit) return;
  const validZones = [...selectedZones].every((zone) => Number.isInteger(zone) && zone >= 1 && zone <= VISIBLE_ZONE_COUNT);
  submit.disabled = !selectedZones.size || !validZones || !quickTaskControllerAvailable || quickTaskAmbiguous || quickTaskConflict || quickTaskRetryWaiting || !pendingManualSelectionMatchesPayload();
}

function lockQuickTask(locked) {
  document.querySelectorAll("#quickTaskForm .qt-duration, #quickTaskForm .qt-close").forEach((control) => { control.disabled = locked; });
  field?.setIdleLocked(locked);
}

function describeSelection(zones) {
  if (!zones.length) return "";
  const label = window.LivingYard.listZones(zones);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/* The floating island must NEVER cover the field, a silhouette, or an
 * anchored Stop/Remove dock — and it must never restrict scrolling or
 * focus. Where the fixed bottom-right island fits below the field at
 * scroll-top, it stays fixed. Where it cannot (short desktop windows),
 * it becomes DOCUMENT-ANCHORED: absolutely positioned in the dashboard
 * just below the field, over a reserved band that pushes Schedules and
 * History down, so it scrolls WITH the page — it can never cover the
 * field and never needs a scroll floor. The mode choice compares
 * scroll-invariant document geometry, so it never flaps with scrolling. */
function syncQuickTaskIslandPlacement() {
  const island = document.querySelector("[data-testid=quick-task-island]");
  if (!island) return;
  if (!island.__placementObserved && typeof ResizeObserver === "function") {
    island.__placementObserved = true;
    const observer = new ResizeObserver(syncQuickTaskIslandPlacement);
    observer.observe(island);
    // Layout settling above the lawn (fonts, sections) moves the field's
    // document bottom without any island resize; body size tracks it.
    observer.observe(document.body);
  }
  const dashboard = document.querySelector(".shell.dashboard");
  const clearDocked = () => {
    island.classList.remove("qt-island-docked");
    dashboard?.classList.remove("quick-task-docked");
    dashboard?.style.removeProperty("--qt-island-top");
    dashboard?.style.removeProperty("--qt-island-band");
  };
  if (island.hidden || !dashboard) {
    clearDocked();
    return;
  }
  const field = document.querySelector("[data-testid=field]");
  if (!field) {
    clearDocked();
    return;
  }
  const height = island.scrollHeight + 2;
  const fieldRect = field.getBoundingClientRect();
  const fieldDocBottom = fieldRect.bottom + window.scrollY;
  // The never-cover contract applies at EVERY width. The fixed anchor
  // differs per layout: desktop floats 24px off the viewport bottom;
  // mobile floats 10px above the fixed nav (whose measured height already
  // carries the safe-area inset). The field's own bottom margin is the
  // reserved dock band — docks live there, so clearance includes it.
  const mobile = !window.matchMedia("(min-width: 900px)").matches;
  const nav = document.querySelector(".mobile-nav");
  const bottomGap = mobile && nav ? nav.getBoundingClientRect().height + 10 : 24;
  const dockBand = Number.parseFloat(getComputedStyle(field).marginBottom) || 0;
  const naturalTop = window.innerHeight - bottomGap - height;
  if (fieldDocBottom + dockBand + 8 > naturalTop) {
    const dashboardDocTop = dashboard.getBoundingClientRect().top + window.scrollY;
    dashboard.classList.add("quick-task-docked");
    dashboard.style.setProperty("--qt-island-top", `${Math.round(fieldDocBottom + dockBand - dashboardDocTop + 8)}px`);
    dashboard.style.setProperty("--qt-island-band", `${Math.round(height + 24)}px`);
    island.classList.add("qt-island-docked");
  } else {
    clearDocked();
  }
}
window.addEventListener("resize", syncQuickTaskIslandPlacement);

function syncQuickTaskIsland() {
  const island = document.querySelector("[data-testid=quick-task-island]");
  if (!island) return;
  const zones = [...selectedZones].sort((a, b) => a - b);
  // A pending same-key retry must always describe its complete immutable
  // payload, even while the controller temporarily prunes a busy zone.
  const summaryZones = pendingManualMutation
    ? [...pendingManualMutation.payload.zones].sort((a, b) => a - b)
    : zones;
  const summary = $("#quickTaskZones");
  if (summary) summary.textContent = describeSelection(summaryZones);
  const islandWasHidden = island.hidden;
  island.hidden = zones.length === 0 && !pendingManualMutation;
  // The dashboard reserves island scroll clearance only while it is open.
  document.querySelector(".shell.dashboard")?.classList.toggle("quick-task-open", !island.hidden);
  syncQuickTaskIslandPlacement();
  if (islandWasHidden && !island.hidden && island.classList.contains("qt-island-docked")) {
    // One-time reveal on open: bring the document-anchored island into
    // view; afterwards the user scrolls completely freely.
    island.scrollIntoView({ block: "nearest" });
  }
  if (island.hidden) {
    const message = $("#quickMessage");
    const persistentFeedback = $("#fieldMutationFeedback");
    if (message?.textContent && persistentFeedback) persistentFeedback.textContent = message.textContent;
    if (message) message.textContent = "";
  }
}

/* The field owns idle-zone toggling; this mirror keeps the island truthful. */
function handleIdleSelectionChange(zones, reason) {
  selectedZones.clear();
  zones.forEach((zone) => selectedZones.add(zone));
  if (reason === "toggle") quickTaskConflict = false;
  syncQuickTaskIsland();
  updateQuickTaskSubmit();
}

function pendingManualSelectionMatchesPayload() {
  if (!pendingManualMutation) return true;
  const zones = pendingManualMutation.payload.zones;
  return selectedZones.size === zones.length && zones.every((zone) => selectedZones.has(zone));
}

function pendingManualZonesAreIdle() {
  const zones = pendingManualMutation?.payload.zones || [];
  return zones.length > 0 && zones.every((zone) => !currentTasks.some((task) => task.zones.includes(zone)));
}

function allowManualRetry(seconds = 0) {
  quickTaskAmbiguous = false;
  quickTaskRetryWaiting = seconds > 0;
  lockQuickTask(true);
  const enable = () => { quickTaskRetryWaiting = false; $("#quickMessage").textContent = "Datastore busy · not applied. Retry only this same request."; updateQuickTaskSubmit(); };
  if (seconds > 0) setTimeout(enable, seconds * 1000); else enable();
}

/* Successful start: the pending create is durable, so the contextual
 * selection retires and success is announced from the persistent field
 * live region (the island hides once nothing is selected). */
async function completeQuickTaskStart() {
  manualMutationStore.clear();
  pendingManualMutation = null;
  quickTaskAmbiguous = false;
  lockQuickTask(false);
  const message = $("#quickMessage");
  if (message) message.textContent = "";
  field?.clearIdleSelection();
  syncQuickTaskIsland();
  const announce = taskDeleteFeedback();
  if (announce) announce.textContent = "Task added";
  await refreshTasks();
}

async function reconcileManualMutation() {
  quickTaskAmbiguous = true;
  lockQuickTask(true);
  updateQuickTaskSubmit();
  const message = $("#quickMessage");
  message.textContent = "Outcome unknown · checking the durable operation. No new request will be sent.";
  const result = await window.MutationRecovery.reconcile(pendingManualMutation.requestId);
  if (result.kind === "committed") {
    await completeQuickTaskStart();
  } else if (result.kind === "rejected") {
    manualMutationStore.clear();
    pendingManualMutation = null;
    quickTaskAmbiguous = false;
    quickTaskConflict = true;
    lockQuickTask(false);
    message.textContent = "Start rejected · task unchanged. Refresh status or edit before a deliberate new Start.";
    syncQuickTaskIsland();
    updateQuickTaskSubmit();
  } else if (result.kind === "not_found" || result.kind === "not_applied") {
    allowManualRetry();
  } else {
    message.textContent = "Outcome unknown · check Status. This request will not be sent again.";
  }
}

function taskDeleteFeedback() {
  return $("#fieldMutationFeedback");
}

function rememberTaskDelete(store, pending) {
  const taskId = String(pending.payload.id);
  const existing = pendingTaskDeletes.get(taskId);
  store.save(pending);
  pendingTaskDeletes.set(taskId, { store, pending, reconciliationStarted: existing?.reconciliationStarted || false });
  return pending;
}

function forgetTaskDelete(taskId, store) {
  store.clear();
  pendingTaskDeletes.delete(String(taskId));
  field?.clearPendingTask(taskId);
}

function pendingTaskDeleteCopy() {
  const labels = [...new Set([...pendingTaskDeletes.values()]
    .filter(({ pending }) => pending.recoveryState === "pending" || pending.recoveryState === "sending")
    .map(({ pending }) => pending.operationKind)
    .filter((kind) => kind === "stop" || kind === "remove")
    .map((kind) => window.MutationRecovery.taskDeleteSemantics(kind).label))];
  if (labels.length === 1) return window.MutationRecovery.taskDeleteSemantics(labels[0].toLowerCase()).pending;
  if (labels.length > 1) return `${labels.join(" and ")} outcomes unknown · reconciling. No new ${labels.join(" or ")} will be sent.`;
  return "Task action outcome unknown · reconciling. No new Stop or Remove will be sent.";
}

function enableTaskDeleteRetry(taskId, pending, semantics) {
  const remaining = Math.max(0, (pending.retryAt || 0) - Date.now());
  const enable = () => {
    const current = pendingTaskDeletes.get(String(taskId));
    if (!current || current.pending.requestId !== pending.requestId || current.pending.recoveryState === "pending") return;
    field?.clearPendingTask(taskId);
  };
  if (remaining > 0) setTimeout(enable, remaining);
  else enable();
  if (remaining > 0) taskDeleteFeedback().textContent = semantics.notApplied(Math.max(1, Math.ceil(remaining / 1000)));
}

async function reconcileTaskDelete(taskId, entry) {
  const { store, pending } = entry;
  const semantics = window.MutationRecovery.taskDeleteSemantics(pending.operationKind);
  const result = await window.MutationRecovery.reconcile(pending.requestId);
  if (result.kind === "committed") {
    forgetTaskDelete(taskId, store);
    taskDeleteFeedback().textContent = semantics.success;
    await Promise.all([refreshTasks(), refreshHistory()]);
  } else if (result.kind === "rejected") {
    forgetTaskDelete(taskId, store);
    taskDeleteConflicts.set(String(taskId), semantics.kind);
    taskDeleteFeedback().textContent = semantics.rejected;
  } else if (result.kind === "not_found" || result.kind === "not_applied") {
    pending.recoveryState = "retry";
    delete pending.retryAt;
    rememberTaskDelete(store, pending);
    field?.clearPendingTask(taskId);
    taskDeleteFeedback().textContent = semantics.notCommitted;
  } else {
    taskDeleteFeedback().textContent = semantics.unresolved;
  }
}

function beginTaskDeleteReconciliation(taskId, entry) {
  const kind = entry.pending.operationKind;
  if (entry.reconciliationStarted || (kind !== "stop" && kind !== "remove")) return;
  entry.reconciliationStarted = true;
  void reconcileTaskDelete(taskId, entry);
}

function restoreTaskDeleteMutations() {
  const entries = window.MutationRecovery.storageEntries("task-delete.");
  for (const { store, value } of entries) {
    const taskId = String(value.payload.id || "");
    if (!taskId) { store.clear(); continue; }
    if (!value.recoveryState) value.recoveryState = "pending";
    const entry = { store, pending: value, reconciliationStarted: false };
    pendingTaskDeletes.set(taskId, entry);
    field?.restorePendingTask(taskId, value.operationKind);
  }
  const unresolved = [...pendingTaskDeletes.entries()].filter(([, { pending }]) => pending.recoveryState !== "retry");
  if (unresolved.length) {
    taskDeleteFeedback().textContent = pendingTaskDeleteCopy();
    for (const [taskId, entry] of unresolved) beginTaskDeleteReconciliation(taskId, entry);
  }
  for (const [taskId, { pending }] of pendingTaskDeletes) {
    if (pending.recoveryState === "retry") {
      const semantics = window.MutationRecovery.taskDeleteSemantics(pending.operationKind);
      taskDeleteFeedback().textContent = pending.retryAt
        ? semantics.notApplied(Math.max(1, Math.ceil((pending.retryAt - Date.now()) / 1000)))
        : semantics.notCommitted;
      enableTaskDeleteRetry(taskId, pending, semantics);
    }
  }
}

async function stopTask(task, operationKind) {
  const taskId = String(task.id);
  const semantics = window.MutationRecovery.taskDeleteSemantics(operationKind);
  const conflictKind = taskDeleteConflicts.get(taskId);
  if (conflictKind) {
    const conflict = window.MutationRecovery.taskDeleteSemantics(conflictKind);
    taskDeleteFeedback().textContent = `${conflict.label} conflict · controller refresh required before a deliberate new ${conflict.label}.`;
    field?.clearPendingTask(task.id);
    return;
  }
  const store = window.MutationRecovery.storage(`task-delete.${taskId}`);
  let pending = pendingTaskDeletes.get(taskId)?.pending || store.load();
  if (pending && pending.operationKind && pending.operationKind !== semantics.kind) {
    field?.restorePendingTask(task.id, pending.operationKind);
    taskDeleteFeedback().textContent = window.MutationRecovery.taskDeleteSemantics(pending.operationKind).unresolved;
    return;
  }
  if (pending?.recoveryState === "pending" || taskDeleteInFlight.has(taskId)) {
    field?.restorePendingTask(task.id, pending.operationKind);
    taskDeleteFeedback().textContent = window.MutationRecovery.taskDeleteSemantics(pending.operationKind).pending;
    return;
  }
  if (!pending) {
    pending = { requestId: requestId(semantics.kind), payload: { id: taskId }, operationKind: semantics.kind, recoveryState: "sending" };
  } else {
    pending.operationKind = semantics.kind;
    pending.recoveryState = "sending";
  }
  rememberTaskDelete(store, pending);
  const feedback = taskDeleteFeedback();
  if (Number.isFinite(pending.retryAt) && pending.retryAt > Date.now()) {
    feedback.textContent = semantics.waiting(Math.ceil((pending.retryAt - Date.now()) / 1000));
    enableTaskDeleteRetry(taskId, pending, semantics);
    return;
  }
  feedback.textContent = semantics.progress;
  taskDeleteInFlight.add(taskId);
  const result = await window.MutationRecovery.send("/api/tasks/delete", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...pending.payload, requestId: pending.requestId }),
  });
  taskDeleteInFlight.delete(taskId);
  if (result.kind === "committed") {
    taskDeleteConflicts.delete(taskId);
    forgetTaskDelete(taskId, store);
    feedback.textContent = semantics.success;
    await Promise.all([refreshTasks(), refreshHistory()]);
  } else if (result.kind === "not_applied") {
    pending.retryAt = Date.now() + result.retryAfter * 1000;
    pending.recoveryState = "retry";
    rememberTaskDelete(store, pending);
    feedback.textContent = semantics.notApplied(result.retryAfter);
    enableTaskDeleteRetry(taskId, pending, semantics);
  } else if (result.kind === "conflict") {
    forgetTaskDelete(taskId, store);
    taskDeleteConflicts.set(taskId, semantics.kind);
    feedback.textContent = semantics.conflict;
  } else if (result.kind === "outcome_unknown" || result.kind === "network_ambiguous") {
    pending.recoveryState = "pending";
    delete pending.retryAt;
    rememberTaskDelete(store, pending);
    feedback.textContent = semantics.pending;
    const entry = pendingTaskDeletes.get(taskId);
    entry.reconciliationStarted = true;
    await reconcileTaskDelete(taskId, entry);
  } else {
    forgetTaskDelete(taskId, store);
    feedback.textContent = semantics.failed(result.data.error);
  }
}

async function refreshTasks() {
  if (!field || refreshInFlight) return;
  refreshInFlight = true;
  try {
    const data = await request("/api/tasks");
    currentTasks = Array.isArray(data.tasks) ? data.tasks : [];
    taskDeleteConflicts.clear();
    for (const [taskId, entry] of pendingTaskDeletes) {
      if (entry.pending.operationKind !== "stop" && entry.pending.operationKind !== "remove") {
        const task = currentTasks.find((candidate) => String(candidate.id) === taskId);
        if (task) {
          entry.pending.operationKind = task.startTime && task.startTime !== 0 ? "stop" : "remove";
          entry.store.save(entry.pending);
        }
      }
      if (entry.pending.recoveryState === "pending") beginTaskDeleteReconciliation(taskId, entry);
      const retryStillWaiting = entry.pending.recoveryState === "retry"
        && Number.isFinite(entry.pending.retryAt)
        && entry.pending.retryAt > Date.now();
      if (entry.pending.recoveryState !== "retry" || retryStillWaiting) {
        field.restorePendingTask(taskId, entry.pending.operationKind);
      }
    }
    startingZones = [];
    quickTaskControllerAvailable = true;
    hasSyncedControllerState = true;
    setControllerStatus("online");
    field.update({ tasks: currentTasks, startingZones, stale: false });
    if (pendingManualMutation && !pendingManualSelectionMatchesPayload() && pendingManualZonesAreIdle()) {
      field.setIdleSelection(pendingManualMutation.payload.zones, "restore");
    }
  } catch (error) {
    quickTaskControllerAvailable = false;
    const busy = error?.data?.kind === "read_overload";
    // One truth model for every read failure (offline, timeout, reject,
    // abort, busy/overload):
    //  - no successful read yet  -> announce unavailable; claim nothing;
    //    disable everything; zero docks.
    //  - known last state        -> re-present it qualified as stale;
    //    withdraw every control/dock; keep shared-task facts truthful.
    setControllerStatus(busy ? "busy" : hasSyncedControllerState ? "stale" : "offline");
    field.update({
      tasks: currentTasks,
      startingZones,
      stale: hasSyncedControllerState,
      offline: !hasSyncedControllerState,
    });
  } finally {
    updateQuickTaskSubmit();
    refreshInFlight = false;
  }
}

function schedulePoll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    if (!document.hidden) await refreshTasks();
    schedulePoll();
  }, 2000);
}

function setupQuickTask() {
  const durations = $("#quickDurations");
  const form = $("#quickTaskForm");
  if (!durations || !form) return;
  const submit = form.querySelector("[type=submit]");
  for (const minutes of QUICK_TASK_DURATIONS) {
    const button = node("button", "qt-duration", `${minutes}m`);
    button.type = "button";
    button.setAttribute("aria-label", `${minutes} minutes`);
    button.setAttribute("aria-pressed", String(minutes === selectedDuration));
    button.addEventListener("click", () => {
      quickTaskConflict = false;
      selectedDuration = minutes;
      durations.querySelectorAll("button").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
      updateQuickTaskSubmit();
    });
    durations.append(button);
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = $("#quickMessage");
    if (!selectedZones.size || submit.disabled) { message.textContent = window.QuickTaskContract.precondition; return; }
    submit.disabled = true;
    message.textContent = "Starting";
    if (!pendingManualMutation) {
      pendingManualMutation = manualMutationStore.save({
        requestId: requestId("manual"),
        payload: { zones: [...selectedZones], runTime: selectedDuration },
      });
    }
    lockQuickTask(true);
    startingZones = [...pendingManualMutation.payload.zones];
    field?.update({ tasks: currentTasks, startingZones });
    const result = await window.MutationRecovery.send("/api/tasks/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: pendingManualMutation.requestId, ...pendingManualMutation.payload }),
    });
    startingZones = [];
    field?.update({ tasks: currentTasks, startingZones, stale: false });
    if (result.kind === "committed") {
      await completeQuickTaskStart();
    } else if (result.kind === "not_applied") {
      pendingManualMutation.retryAt = Date.now() + result.retryAfter * 1000;
      manualMutationStore.save(pendingManualMutation);
      message.textContent = `Datastore busy · not applied. Retry this same request in ${result.retryAfter} second${result.retryAfter === 1 ? "" : "s"}.`;
      allowManualRetry(result.retryAfter);
    } else if (result.kind === "conflict") {
      manualMutationStore.clear();
      pendingManualMutation = null;
      quickTaskAmbiguous = false;
      quickTaskConflict = true;
      lockQuickTask(false);
      message.textContent = `Request conflict · ${result.data.error}. Refresh status or edit the task before starting again.`;
      syncQuickTaskIsland();
    } else if (result.kind === "outcome_unknown" || result.kind === "network_ambiguous") {
      quickTaskAmbiguous = true;
      message.textContent = "Outcome unknown · reconciling the durable operation. No new request will be sent.";
      await reconcileManualMutation();
    } else {
      manualMutationStore.clear();
      pendingManualMutation = null;
      quickTaskAmbiguous = false;
      lockQuickTask(false);
      message.textContent = `Start failed · ${result.data.error || "request rejected"}`;
      syncQuickTaskIsland();
    }
    updateQuickTaskSubmit();
  });

  $("#quickTaskClose")?.addEventListener("click", () => {
    field?.clearIdleSelection({ refocus: true });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !field || !selectedZones.size) return;
    // A busy-zone status selection owns Escape while it is active (the field
    // marks a consumed Escape via preventDefault); a pending create keeps its
    // selection so recovery stays anchored to the same payload.
    if (event.defaultPrevented) return;
    if (pendingManualMutation || quickTaskAmbiguous || quickTaskRetryWaiting) return;
    const island = document.querySelector("[data-testid=quick-task-island]");
    field.clearIdleSelection({ refocus: Boolean(island?.contains(document.activeElement)) });
  });

  if (pendingManualMutation) {
    selectedDuration = pendingManualMutation.payload.runTime;
    durations.querySelectorAll("button").forEach((button) => button.setAttribute("aria-pressed", String(Number.parseInt(button.textContent, 10) === selectedDuration)));
    field?.setIdleSelection(pendingManualMutation.payload.zones, "restore");
    lockQuickTask(true);
    if (Number.isFinite(pendingManualMutation.retryAt)) allowManualRetry(Math.max(0, (pendingManualMutation.retryAt - Date.now()) / 1000));
    else void reconcileManualMutation();
  }
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function taskSequence(schedule) {
  return (schedule.tasks || []).map((task, index) => `${index + 1}. Zone${task.zones.length === 1 ? "" : "s"} ${task.zones.join(", ")} · ${task.runTime} min`).join("; ");
}

function scheduleRow(id, schedule, dedicated) {
  // Today summary rows are real links into the exact schedule on /schedules;
  // the dedicated page rows are focusable anchor targets for that link.
  const row = node(dedicated ? "article" : "a", dedicated ? "schedule-data-row" : "schedule-summary-row");
  row.dataset.scheduleRow = id;
  const name = node("strong", "schedule-name", schedule.name || "Untitled schedule");
  const state = node("span", "schedule-state", schedule.enabled ? "Enabled" : "Paused");
  state.dataset.scheduleState = "";
  const time = node("time", "schedule-time mono", formatTime(schedule.startTime));
  const top = node("div", "schedule-row-top");
  top.append(name, state, time);
  row.append(top);
  if (!dedicated) {
    row.dataset.scheduleLink = "";
    row.href = `/schedules#${encodeURIComponent(id)}`;
    // The aria-label supersedes the row contents in the accessible-name
    // computation, so it must carry everything the row shows: identifier,
    // Enabled/Paused status, start time, and the navigation purpose.
    row.setAttribute(
      "aria-label",
      `${schedule.name || "Untitled schedule"}, ${schedule.enabled ? "Enabled" : "Paused"}, ${formatTime(schedule.startTime)} — open in all schedules`
    );
    row.append(node("span", "schedule-summary-meta", taskSequence(schedule)));
    row.addEventListener("click", rememberTodayScroll);
    return row;
  }
  row.id = id;
  row.tabIndex = -1;
  const days = node("div", "schedule-days", (schedule.days || []).map((day) => DAY_NAMES[day]).join(" · "));
  days.dataset.scheduleDays = "";
  const sequence = node("div", "schedule-sequence", taskSequence(schedule));
  sequence.dataset.scheduleSequence = "";
  const last = node("div", "schedule-last", Number.isFinite(schedule.lastRun) ? `Last run ${relativeTime(schedule.lastRun)}` : "Not yet run");
  last.dataset.scheduleLastRun = "";
  const actions = node("div", "schedule-actions");
  const edit = node("a", "text-action", "Edit");
  edit.href = `/edit-schedule?id=${encodeURIComponent(id)}`;
  edit.setAttribute("aria-label", `Edit ${schedule.name || "untitled schedule"}`);
  const remove = node("button", "text-action danger-action", "Delete");
  remove.type = "button";
  remove.setAttribute("aria-label", `Delete ${schedule.name || "untitled schedule"}`);
  remove.addEventListener("click", async () => {
    if (!window.confirm(`Delete ${schedule.name || "this schedule"}?`)) return;
    remove.disabled = true;
    const stableId = deleteRequestIds.get(id) || requestId("schedule-delete");
    deleteRequestIds.set(id, stableId);
    try {
      await request("/api/schedules/delete", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, requestId: stableId }),
      });
      deleteRequestIds.delete(id);
      row.remove();
    } catch (error) {
      remove.disabled = false;
      const note = node("p", "row-feedback", error.status ? "Delete failed · schedule unchanged" : "Delete outcome unknown · refresh before another action");
      row.append(note);
    }
  });
  actions.append(edit, remove);
  row.append(days, sequence, last, actions);
  return row;
}

function renderSchedules(data) {
  const container = $("#schedules");
  if (!container) return;
  container.replaceChildren();
  const dedicated = document.body.dataset.page === "schedules";
  const entries = Object.entries(data);
  const visible = dedicated ? entries : entries.slice(0, 3);
  if (!visible.length) return container.append(node("p", "empty", "No schedules"));
  for (const [id, schedule] of visible) container.append(scheduleRow(id, schedule, dedicated));
}

/* Deep link from a Today schedule row: focus, scroll to and highlight the
 * exact schedule row named by the URL hash on the dedicated page. */
function focusScheduleFromHash() {
  if (document.body.dataset.page !== "schedules") return;
  const raw = location.hash.slice(1);
  if (!raw) return;
  let id = raw;
  try { id = decodeURIComponent(raw); } catch {}
  const row = document.getElementById(id);
  if (!row || row.dataset.scheduleRow === undefined) return;
  document.querySelectorAll(".schedule-data-row.is-highlighted")
    .forEach((other) => other.classList.remove("is-highlighted"));
  row.classList.add("is-highlighted");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  row.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
  row.focus({ preventScroll: true });
}

async function refreshSchedules() {
  if (!$("#schedules")) return;
  try { renderSchedules(await request("/api/schedules")); }
  catch { $("#schedules").replaceChildren(node("p", "empty", "Schedules unavailable")); }
  focusScheduleFromHash();
}

function renderHistory(events) {
  const container = $("#history");
  if (!container) return;
  container.replaceChildren();
  const dedicated = document.body.dataset.page === "activity";
  const visible = dedicated ? events : events.slice(0, 8);
  if (!visible.length) return container.append(node("p", "empty", "No history"));
  let currentDate = "";
  for (const event of visible) {
    if (dedicated) {
      const date = formatDate(event.timestamp);
      if (date !== currentDate) {
        currentDate = date;
        const heading = node("h2", "history-date", date);
        heading.dataset.historyDate = "";
        container.append(heading);
      }
    }
    // One coherent row: a colour glyph (decorative), a primary phrase such
    // as "Zones 1, 4 stopped", and attached metadata "Remote · 1:26 AM".
    const row = node("div", "history-row");
    row.dataset.historyRow = "";
    const zones = (event.zones || []).join(", ");
    const eventName = event.event || "Event";
    const icon = node("span", `history-icon ${eventName.toLowerCase().replaceAll(" ", "-")}`);
    icon.setAttribute("aria-hidden", "true");
    const body = node("div", "history-body");
    const primary = node("p", "history-primary",
      `${event.zones?.length === 1 ? "Zone" : "Zones"} ${zones} ${eventName.toLowerCase()}`);
    const meta = node("p", "history-meta", `${event.reason || "Controller"} · `);
    const time = node("time", "mono", dedicated ? formatClock(event.timestamp) : relativeTime(event.timestamp));
    meta.append(time);
    body.append(primary, meta);
    row.append(icon, body);
    container.append(row);
  }
}

async function refreshHistory() {
  if (!$("#history")) return;
  try { renderHistory(await request("/api/history?limit=250")); }
  catch { $("#history").replaceChildren(node("p", "empty", "History unavailable")); }
}

/* Back-restoration of the Today context. Native scroll restoration runs
 * against the PRE-hydration document (schedules/history render async), so
 * on shorter desktop documents Back lands at the top. The intended offset
 * is remembered when a schedule deep link is activated and re-applied
 * after hydration — only on genuine back/forward returns (including
 * BFCache pageshow), never on direct loads, with no history mutation. */
const TODAY_SCROLL_KEY = "living-yard-today-scroll";

function rememberTodayScroll() {
  try {
    sessionStorage.setItem(TODAY_SCROLL_KEY, String(Math.round(window.scrollY)));
  } catch {}
}

function maybeRestoreTodayScroll(fromPageShow = false) {
  if (location.hash) return;
  let stored = null;
  try {
    stored = sessionStorage.getItem(TODAY_SCROLL_KEY);
  } catch {}
  if (stored === null) return;
  const [entry] = (performance.getEntriesByType && performance.getEntriesByType("navigation")) || [];
  const backForward = fromPageShow || (entry && entry.type === "back_forward");
  try {
    sessionStorage.removeItem(TODAY_SCROLL_KEY);
  } catch {}
  // A direct load discards the stale context instead of hijacking scroll.
  if (!backForward) return;
  const target = Number.parseInt(stored, 10);
  if (!Number.isFinite(target) || target <= 0) return;
  const started = performance.now();
  const apply = () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    if (max >= target - 4 || performance.now() - started > 2000) {
      const destination = Math.min(target, Math.max(0, max));
      if (Math.abs(window.scrollY - destination) > 4) window.scrollTo(0, destination);
      return;
    }
    requestAnimationFrame(apply);
  };
  apply();
}

window.addEventListener("pageshow", (event) => {
  if (event.persisted) maybeRestoreTodayScroll(true);
});

document.addEventListener("DOMContentLoaded", () => {
  const fieldElement = $("#sprinklerField");
  if (fieldElement && window.LivingYard) {
    const fieldHandlers = {
      onStop: (task) => stopTask(task, "stop"),
      onRemove: (task) => stopTask(task, "remove"),
    };
    // Only the Today dashboard turns idle field zones into a Quick Task
    // selector; the status route stays glance-and-stop only.
    if ($("#quickTaskForm")) fieldHandlers.onIdleSelectionChange = handleIdleSelectionChange;
    field = window.LivingYard.renderField(fieldElement, fieldHandlers);
  }
  setupQuickTask();
  if (field) {
    restoreTaskDeleteMutations();
    refreshTasks();
    schedulePoll();
    $("#refreshController")?.addEventListener("click", () => {
      quickTaskConflict = false;
      refreshTasks();
    });
    window.addEventListener("focus", refreshTasks);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshTasks(); });
  }
  refreshSchedules();
  refreshHistory();
  maybeRestoreTodayScroll();
});
