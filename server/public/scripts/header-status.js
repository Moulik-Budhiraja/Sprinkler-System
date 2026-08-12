document.addEventListener("DOMContentLoaded", async () => {
  const status = document.getElementById("mobileControllerStatus");
  if (!status || document.getElementById("sprinklerField")) return;
  try {
    const response = await fetch("/api/tasks", { cache: "no-store" });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      if (data.kind === "read_overload") {
        status.textContent = "Controller busy · try again shortly";
        status.closest(".controller-status")?.classList.remove("offline");
        return;
      }
      throw new Error(String(response.status));
    }
    await response.json();
    status.textContent = "Controller online";
    status.closest(".controller-status")?.classList.remove("offline");
  } catch {
    status.textContent = "Controller offline";
    status.closest(".controller-status")?.classList.add("offline");
  }
});

/* Bottom-nav overflow affordance. When the five destinations no longer fit
 * the fold (very narrow layout viewports, 200% text zoom) the nav scrolls
 * internally; these decorative, aria-hidden edge hints advertise the hidden
 * side and retire at the scrolled edge. Assistive tech never needs them —
 * every link stays in the accessibility tree and focus auto-scrolls into
 * view — so the affordance is purely visual. */
document.addEventListener("DOMContentLoaded", () => {
  const nav = document.querySelector(".mobile-nav");
  if (!nav) return;
  const makeHint = (side) => {
    const hint = document.createElement("span");
    hint.className = `nav-scroll-hint nav-scroll-hint-${side}`;
    hint.setAttribute("aria-hidden", "true");
    return hint;
  };
  nav.prepend(makeHint("left"));
  nav.append(makeHint("right"));
  const update = () => {
    const scrollable = nav.scrollWidth > nav.clientWidth + 1;
    nav.classList.toggle("nav-overflowing", scrollable);
    nav.classList.toggle("nav-at-start", nav.scrollLeft <= 1);
    nav.classList.toggle("nav-at-end", nav.scrollLeft + nav.clientWidth >= nav.scrollWidth - 1);
  };
  nav.addEventListener("scroll", update, { passive: true });
  // Keyboard support: engines scroll a focused element only partially into
  // an overflowing container; bring the focused destination fully into the
  // fold so keyboard users always see what they are about to activate.
  nav.addEventListener("focusin", (event) => {
    const link = event.target.closest("a");
    if (link) link.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
  window.addEventListener("resize", update);
  if (typeof ResizeObserver === "function") {
    // Observing the links (not just the bar) catches content-size changes
    // such as text-only zoom, which never resize the fixed bar itself.
    const observer = new ResizeObserver(update);
    observer.observe(nav);
    for (const link of nav.querySelectorAll("a")) observer.observe(link);
  }
  update();
});

/* The lawn/status-field geometry derives from the REAL measured mobile
 * header height (text zoom makes the wrapped heading grow), published as a
 * CSS custom property consumed by the .status-field height calc. */
document.addEventListener("DOMContentLoaded", () => {
  const header = document.querySelector(".mobile-header");
  if (!header) return;
  const publish = () => {
    document.documentElement.style.setProperty(
      "--mobile-header-h",
      `${Math.ceil(header.getBoundingClientRect().height)}px`
    );
  };
  if (typeof ResizeObserver === "function") new ResizeObserver(publish).observe(header);
  window.addEventListener("resize", publish);
  publish();
});
