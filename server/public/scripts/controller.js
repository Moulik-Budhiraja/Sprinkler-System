document.addEventListener("DOMContentLoaded", async () => {
  const reachability = document.getElementById("controllerReachability");
  const summary = document.getElementById("controllerTaskSummary");
  const mobile = document.getElementById("mobileControllerStatus");
  try {
    const response = await fetch("/api/tasks");
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      if (error.kind === "read_overload") {
        reachability.textContent = "Controller busy · try again shortly";
        mobile.textContent = "Controller busy · try again shortly";
        summary.textContent = "Task state refresh pending";
        return;
      }
      throw new Error(String(response.status));
    }
    const data = await response.json();
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    const running = tasks.filter((task) => task.startTime).length;
    const queued = tasks.length - running;
    reachability.textContent = "Controller online";
    mobile.textContent = "Controller online";
    summary.textContent = `${running} running · ${queued} queued`;
  } catch {
    reachability.textContent = "Controller offline";
    mobile.textContent = "Controller offline";
    summary.textContent = "Task state unavailable";
    mobile.closest(".controller-status")?.classList.add("offline");
  }
});
