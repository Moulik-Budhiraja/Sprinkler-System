const QUICK_TASK_DURATIONS = window.QuickTaskContract.durations;
const QUICK_TASK_DEFAULT_DURATION = window.QuickTaskContract.defaultDuration;
const VISIBLE_ZONE_COUNT = window.QuickTaskContract.visibleZoneCount;
const selectedZones = new Set();
let selectedDuration = QUICK_TASK_DEFAULT_DURATION;
let quickTaskControllerAvailable = false;
let quickTaskAmbiguous = false;
let currentTasks = [];
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
  if (status) status.textContent = state === "online" ? "Controller online" : state === "stale" ? "Controller offline · last known state" : "Controller offline";
  wrap?.classList.toggle("offline", state !== "online");
  if (freshness) {
    freshness.dataset.state = state === "online" ? "live" : "stale";
    freshness.textContent = state === "online" ? "Controller status current" : "Controller offline · showing stale last-known state";
  }
}

function updateQuickTaskSubmit() {
  const submit = document.querySelector("#quickTaskForm [type=submit]");
  if (!submit) return;
  const validZones = [...selectedZones].every((zone) => Number.isInteger(zone) && zone >= 1 && zone <= VISIBLE_ZONE_COUNT);
  submit.disabled = !selectedZones.size || !validZones || !quickTaskControllerAvailable || quickTaskAmbiguous || quickTaskConflict || quickTaskRetryWaiting;
}

function lockQuickTask(locked) {
  document.querySelectorAll("#quickTaskForm .qt-zone, #quickTaskForm .qt-duration").forEach((control) => { control.disabled = locked; });
}

function allowManualRetry(seconds = 0) {
  quickTaskAmbiguous = false;
  quickTaskRetryWaiting = seconds > 0;
  lockQuickTask(true);
  const enable = () => { quickTaskRetryWaiting = false; $("#quickMessage").textContent = "Datastore busy · not applied. Retry only this same request."; updateQuickTaskSubmit(); };
  if (seconds > 0) setTimeout(enable, seconds * 1000); else enable();
}

async function reconcileManualMutation() {
  quickTaskAmbiguous = true;
  lockQuickTask(true);
  updateQuickTaskSubmit();
  const message = $("#quickMessage");
  message.textContent = "Outcome unknown · checking the durable operation. No new request will be sent.";
  const result = await window.MutationRecovery.reconcile(pendingManualMutation.requestId);
  if (result.kind === "committed") {
    manualMutationStore.clear();
    pendingManualMutation = null;
    selectedZones.clear();
    lockQuickTask(false);
    quickTaskAmbiguous = false;
    message.textContent = "Task added";
    await refreshTasks();
  } else if (result.kind === "rejected") {
    manualMutationStore.clear();
    pendingManualMutation = null;
    quickTaskAmbiguous = false;
    quickTaskConflict = true;
    lockQuickTask(false);
    message.textContent = "Start rejected · task unchanged. Refresh status or edit before a deliberate new Start.";
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
    setControllerStatus("online");
    field.update({ tasks: currentTasks, startingZones, stale: false });
  } catch {
    quickTaskControllerAvailable = false;
    setControllerStatus(currentTasks.length ? "stale" : "offline");
    field.update({ tasks: currentTasks, startingZones, stale: true });
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
  const zones = $("#quickZones");
  const durations = $("#quickDurations");
  const form = $("#quickTaskForm");
  if (!zones || !durations || !form) return;
  const submit = form.querySelector("[type=submit]");
  for (let zone = 1; zone <= VISIBLE_ZONE_COUNT; zone += 1) {
    const button = node("button", "qt-zone", String(zone));
    button.type = "button";
    button.setAttribute("aria-label", `Zone ${zone}`);
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => {
      quickTaskConflict = false;
      selectedZones.has(zone) ? selectedZones.delete(zone) : selectedZones.add(zone);
      button.setAttribute("aria-pressed", String(selectedZones.has(zone)));
      updateQuickTaskSubmit();
    });
    zones.append(button);
  }
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
      manualMutationStore.clear();
      pendingManualMutation = null;
      selectedZones.clear();
      lockQuickTask(false);
      zones.querySelectorAll("button").forEach((button) => button.setAttribute("aria-pressed", "false"));
      message.textContent = "Task added";
      await refreshTasks();
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
    }
    updateQuickTaskSubmit();
  });

  if (pendingManualMutation) {
    selectedZones.clear();
    pendingManualMutation.payload.zones.forEach((zone) => selectedZones.add(zone));
    selectedDuration = pendingManualMutation.payload.runTime;
    zones.querySelectorAll("button").forEach((button, index) => button.setAttribute("aria-pressed", String(selectedZones.has(index + 1))));
    durations.querySelectorAll("button").forEach((button) => button.setAttribute("aria-pressed", String(Number.parseInt(button.textContent, 10) === selectedDuration)));
    lockQuickTask(true);
    if (Number.isFinite(pendingManualMutation.retryAt)) allowManualRetry(Math.max(0, (pendingManualMutation.retryAt - Date.now()) / 1000));
    else void reconcileManualMutation();
  }
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function taskSequence(schedule) {
  return (schedule.tasks || []).map((task, index) => `${index + 1}. Zone${task.zones.length === 1 ? "" : "s"} ${task.zones.join(", ")} · ${task.runTime} min`).join("  ");
}

function scheduleRow(id, schedule, dedicated) {
  const row = node("article", dedicated ? "schedule-data-row" : "schedule-summary-row");
  row.dataset.scheduleRow = id;
  const name = node("strong", "schedule-name", schedule.name || "Untitled schedule");
  const state = node("span", "schedule-state", schedule.enabled ? "Enabled" : "Paused");
  state.dataset.scheduleState = "";
  const time = node("time", "schedule-time mono", formatTime(schedule.startTime));
  const top = node("div", "schedule-row-top");
  top.append(name, state, time);
  row.append(top);
  if (!dedicated) {
    row.append(node("span", "schedule-summary-meta", taskSequence(schedule)));
    return row;
  }
  const days = node("div", "schedule-days", (schedule.days || []).map((day) => DAY_NAMES[day]).join(" · "));
  days.dataset.scheduleDays = "";
  const sequence = node("div", "schedule-sequence", taskSequence(schedule));
  sequence.dataset.scheduleSequence = "";
  const last = node("div", "schedule-last", `Last run ${relativeTime(schedule.lastRun)}`);
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

async function refreshSchedules() {
  if (!$("#schedules")) return;
  try { renderSchedules(await request("/api/schedules")); }
  catch { $("#schedules").replaceChildren(node("p", "empty", "Schedules unavailable")); }
}

function renderHistory(events) {
  const container = $("#history");
  if (!container) return;
  container.replaceChildren();
  const dedicated = document.body.dataset.page === "activity";
  const visible = dedicated ? events : events.slice(0, 4);
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
    const row = node("div", dedicated ? "history-data-row" : "history-summary-row");
    row.dataset.historyRow = "";
    const zones = (event.zones || []).join(", ");
    const eventName = event.event || "Event";
    const state = node("strong", `history-event ${eventName.toLowerCase().replaceAll(" ", "-")}`, eventName);
    const zoneText = node("span", "history-zones", `${event.zones?.length === 1 ? "Zone" : "Zones"} ${zones}`);
    const reason = node("span", "history-reason", event.reason || "Controller");
    const time = node("time", "history-time mono", dedicated ? formatClock(event.timestamp) : relativeTime(event.timestamp));
    row.append(time, state, zoneText, reason);
    container.append(row);
  }
}

async function refreshHistory() {
  if (!$("#history")) return;
  try { renderHistory(await request("/api/history?limit=250")); }
  catch { $("#history").replaceChildren(node("p", "empty", "History unavailable")); }
}

document.addEventListener("DOMContentLoaded", () => {
  const fieldElement = $("#sprinklerField");
  if (fieldElement && window.LivingYard) {
    field = window.LivingYard.renderField(fieldElement, {
      onStop: (task) => stopTask(task, "stop"),
      onRemove: (task) => stopTask(task, "remove"),
    });
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
});
