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
const stopConflicts = new Set();

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

async function stopTask(task) {
  if (stopConflicts.has(String(task.id))) {
    $("#fieldMutationFeedback").textContent = "Stop conflict · controller refresh required before a deliberate new Stop.";
    field?.clearPendingTask(task.id);
    return;
  }
  const store = window.MutationRecovery.storage(`task-delete.${String(task.id)}`);
  let pending = store.load();
  if (!pending) pending = store.save({ requestId: requestId("stop"), payload: { id: String(task.id) } });
  const feedback = $("#fieldMutationFeedback");
  if (Number.isFinite(pending.retryAt) && pending.retryAt > Date.now()) {
    feedback.textContent = `Datastore busy · wait ${Math.ceil((pending.retryAt - Date.now()) / 1000)} second before retrying this same Stop.`;
    return;
  }
  feedback.textContent = "Stopping";
  const result = await window.MutationRecovery.send("/api/tasks/delete", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...pending.payload, requestId: pending.requestId }),
  });
  if (result.kind === "committed") {
    stopConflicts.delete(String(task.id));
    store.clear();
    feedback.textContent = "Task stopped";
    await Promise.all([refreshTasks(), refreshHistory()]);
  } else if (result.kind === "not_applied") {
    pending.retryAt = Date.now() + result.retryAfter * 1000;
    store.save(pending);
    feedback.textContent = `Datastore busy · Stop was not applied. Retry this same Stop in ${result.retryAfter} second${result.retryAfter === 1 ? "" : "s"}.`;
    field?.clearPendingTask(task.id);
  } else if (result.kind === "conflict") {
    store.clear();
    stopConflicts.add(String(task.id));
    feedback.textContent = "Stop conflict · task unchanged. Refresh status before a deliberate new Stop.";
    field?.clearPendingTask(task.id);
  } else if (result.kind === "outcome_unknown" || result.kind === "network_ambiguous") {
    feedback.textContent = "Stop outcome unknown · reconciling. No new Stop will be sent.";
    const reconciled = await window.MutationRecovery.reconcile(pending.requestId);
    if (reconciled.kind === "committed") {
      store.clear();
      feedback.textContent = "Task stopped";
      await Promise.all([refreshTasks(), refreshHistory()]);
    } else if (reconciled.kind === "rejected") {
      store.clear();
      stopConflicts.add(String(task.id));
      feedback.textContent = "Stop rejected · task unchanged. Refresh status before a deliberate new Stop.";
      field?.clearPendingTask(task.id);
    } else if (reconciled.kind === "not_found" || reconciled.kind === "not_applied") {
      feedback.textContent = "Stop not committed · retry only this same Stop.";
      field?.clearPendingTask(task.id);
    } else {
      feedback.textContent = "Stop outcome unknown · check the visible task state. No new Stop will be sent.";
      field?.clearPendingTask(task.id);
    }
  } else {
    store.clear();
    feedback.textContent = `Stop failed · ${result.data.error || "request rejected"}. Task unchanged.`;
    field?.clearPendingTask(task.id);
  }
}

async function refreshTasks() {
  if (!field || refreshInFlight) return;
  refreshInFlight = true;
  try {
    const data = await request("/api/tasks");
    currentTasks = Array.isArray(data.tasks) ? data.tasks : [];
    stopConflicts.clear();
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
  if (fieldElement && window.LivingYard) field = window.LivingYard.renderField(fieldElement, { onStop: stopTask, onRemove: stopTask });
  setupQuickTask();
  if (field) {
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
