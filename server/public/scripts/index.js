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
  submit.disabled = !selectedZones.size || !validZones || !quickTaskControllerAvailable || quickTaskAmbiguous;
}

async function stopTask(task) {
  const id = requestId("stop");
  try {
    const result = await request("/api/tasks/delete", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: String(task.id), requestId: id }),
    });
    if (result.outcome === "unknown") {
      setControllerStatus("stale");
      field?.update({ tasks: currentTasks, stale: true });
      return;
    }
    await Promise.all([refreshTasks(), refreshHistory()]);
  } catch {
    setControllerStatus("stale");
    field?.update({ tasks: currentTasks, stale: true });
  }
}

async function refreshTasks() {
  if (!field || refreshInFlight) return;
  refreshInFlight = true;
  try {
    const data = await request("/api/tasks");
    currentTasks = Array.isArray(data.tasks) ? data.tasks : [];
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
      selectedDuration = minutes;
      durations.querySelectorAll("button").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
    });
    durations.append(button);
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = $("#quickMessage");
    if (!selectedZones.size || submit.disabled) { message.textContent = window.QuickTaskContract.precondition; return; }
    submit.disabled = true;
    let keepDisabled = false;
    message.textContent = "Starting";
    startingZones = [...selectedZones];
    field?.update({ tasks: currentTasks, startingZones });
    try {
      const result = await request("/api/tasks/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: requestId("manual"), zones: [...selectedZones], runTime: selectedDuration }),
      });
      if (result.outcome === "unknown") {
        quickTaskAmbiguous = true;
        keepDisabled = true;
        startingZones = [];
        field?.update({ tasks: currentTasks, stale: true });
        message.textContent = "Outcome unknown · check Status before taking another action";
        setControllerStatus("stale");
      } else {
        selectedZones.clear();
        zones.querySelectorAll("button").forEach((button) => button.setAttribute("aria-pressed", "false"));
        message.textContent = "Task added";
        await refreshTasks();
      }
    } catch {
      quickTaskAmbiguous = true;
      keepDisabled = true;
      startingZones = [];
      field?.update({ tasks: currentTasks, stale: true });
      message.textContent = "Could not confirm task · check Status before taking another action";
    } finally { submit.disabled = keepDisabled; updateQuickTaskSubmit(); }
  });
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
    $("#refreshController")?.addEventListener("click", refreshTasks);
    window.addEventListener("focus", refreshTasks);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshTasks(); });
  }
  refreshSchedules();
  refreshHistory();
});
