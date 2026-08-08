const contract = window.QuickTaskContract;
const ZONE_COUNT = contract.visibleZoneCount;
const grid = document.getElementById("zoneGrid");
const feedback = document.getElementById("taskFeedback");
const duration = document.getElementById("duration");
const startButton = document.getElementById("startBtn");
let controllerAvailable = false;
let ambiguous = false;
let availabilityInFlight = false;

function selectedZones() {
  return Array.from({ length: ZONE_COUNT }, (_, index) => index + 1)
    .filter((zone) => document.getElementById(`zone${zone}`).checked);
}

function validDuration() {
  return Number.isInteger(duration.valueAsNumber) && duration.valueAsNumber >= 1 && duration.valueAsNumber <= 1440;
}

function updateStartState() {
  startButton.disabled = !selectedZones().length || !validDuration() || !controllerAvailable || ambiguous;
}

for (let zone = 1; zone <= ZONE_COUNT; zone += 1) {
  const choice = document.createElement("span");
  choice.className = "choice";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.id = `zone${zone}`;
  input.addEventListener("change", updateStartState);
  const label = document.createElement("label");
  label.htmlFor = input.id;
  label.textContent = String(zone);
  choice.append(input, label);
  grid.append(choice);
}

const presets = document.getElementById("presets");
for (const minutes of contract.durations) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "preset";
  button.dataset.min = String(minutes);
  button.textContent = `${minutes} min`;
  button.classList.toggle("active", minutes === contract.defaultDuration);
  button.addEventListener("click", () => {
    duration.value = String(minutes);
    presets.querySelectorAll(".preset").forEach((entry) => entry.classList.toggle("active", entry === button));
    updateStartState();
  });
  presets.append(button);
}
duration.value = String(contract.defaultDuration);
duration.addEventListener("input", () => {
  presets.querySelectorAll(".preset").forEach((button) => button.classList.toggle("active", button.dataset.min === duration.value));
  updateStartState();
});

async function refreshAvailability() {
  if (availabilityInFlight || ambiguous) return;
  availabilityInFlight = true;
  try {
    const response = await fetch("/api/tasks", { cache: "no-store" });
    if (!response.ok) throw new Error(String(response.status));
    await response.json();
    controllerAvailable = true;
  } catch {
    controllerAvailable = false;
  } finally {
    availabilityInFlight = false;
    updateStartState();
  }
}

startButton.addEventListener("click", async () => {
  const zones = selectedZones();
  const runTime = duration.valueAsNumber;
  if (!zones.length || !validDuration() || startButton.disabled) {
    feedback.textContent = contract.precondition;
    updateStartState();
    return;
  }
  startButton.disabled = true;
  feedback.textContent = "Starting";
  try {
    const response = await fetch("/api/tasks/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: `manual-${crypto.randomUUID()}`, zones, runTime }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Start failed");
    if (result.outcome === "unknown") {
      ambiguous = true;
      feedback.textContent = "Outcome unknown · check Status before taking another action";
      updateStartState();
      return;
    }
    location.assign("/");
  } catch (error) {
    ambiguous = true;
    feedback.textContent = `Could not confirm task · ${error.message}`;
    updateStartState();
  }
});

refreshAvailability();
setInterval(refreshAvailability, 2000);
