const ZONE_COUNT = 6;
const grid = document.getElementById("zoneGrid");
const feedback = document.getElementById("taskFeedback");
for (let zone = 1; zone <= ZONE_COUNT; zone += 1) {
  const choice = document.createElement("span"); choice.className = "choice";
  const input = document.createElement("input"); input.type = "checkbox"; input.id = `zone${zone}`;
  const label = document.createElement("label"); label.htmlFor = input.id; label.textContent = String(zone);
  choice.append(input, label); grid.append(choice);
}
const duration = document.getElementById("duration");
document.querySelectorAll(".preset").forEach((button) => button.addEventListener("click", () => {
  duration.value = button.dataset.min;
  document.querySelectorAll(".preset").forEach((entry) => entry.classList.toggle("active", entry === button));
}));
duration.addEventListener("input", () => document.querySelectorAll(".preset").forEach((button) => button.classList.toggle("active", button.dataset.min === duration.value)));

document.getElementById("startBtn").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const zones = Array.from({ length: ZONE_COUNT }, (_, index) => index + 1).filter((zone) => document.getElementById(`zone${zone}`).checked);
  const runTime = duration.valueAsNumber;
  if (!zones.length || !Number.isInteger(runTime) || runTime < 1 || runTime > 1440) { feedback.textContent = "Select zones and enter 1–1440 minutes"; return; }
  button.disabled = true; feedback.textContent = "Starting";
  try {
    const response = await fetch("/api/tasks/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: `manual-${crypto.randomUUID()}`, zones, runTime }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Start failed");
    if (result.outcome === "unknown") { feedback.textContent = "Outcome unknown · check Status before taking another action"; return; }
    location.assign("/");
  } catch (error) { feedback.textContent = `Could not confirm task · ${error.message}`; }
});
