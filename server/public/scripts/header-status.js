document.addEventListener("DOMContentLoaded", async () => {
  const status = document.getElementById("mobileControllerStatus");
  if (!status || document.getElementById("sprinklerField")) return;
  try {
    const response = await fetch("/api/tasks", { cache: "no-store" });
    if (!response.ok) throw new Error(String(response.status));
    await response.json();
    status.textContent = "Controller online";
    status.closest(".controller-status")?.classList.remove("offline");
  } catch {
    status.textContent = "Controller offline";
    status.closest(".controller-status")?.classList.add("offline");
  }
});
