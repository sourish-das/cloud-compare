// docs/ui/tooltips.js
// Canonical tooltip initializer with future‑proof info button styling

/* ======================================================
   INTERNAL HELPERS
   ====================================================== */

function normalizeInfoBtn(btn) {
  if (!btn) return;
  // Single source of truth for styling (CSS hooks)
  btn.classList.add("info-btn");
  btn.setAttribute("type", "button");
  btn.setAttribute("aria-haspopup", "dialog");
}

function canHover() {
  try {
    return !!(window.matchMedia && window.matchMedia("(hover: hover)").matches);
  } catch {
    return false;
  }
}

function getRect(el) {
  return el?.getBoundingClientRect?.() || { left: 0, top: 0, bottom: 0 };
}

function setAriaHidden(tip, hidden) {
  if (!tip) return;
  tip.setAttribute("aria-hidden", hidden ? "true" : "false");
}

function isOpen(tip) {
  return tip?.getAttribute?.("aria-hidden") === "false";
}

/**
 * Attach a small, anchored tooltip or a modal-like panel.
 * - enableHover: true => hover open/close (only for non-modal tips and hover-capable devices)
 * - anchorEl: element used to position non-modal tips
 */
function attachTooltip({
  btn,
  tip,
  label,
  anchorEl,
  enableHover = false
}) {
  if (!btn || !tip || !label || !anchorEl) return;

  // Avoid double-binding the same tooltip
  if (btn.__tooltipBound && btn.__tooltipBound.has(tip)) return;
  if (!btn.__tooltipBound) btn.__tooltipBound = new WeakSet();
  btn.__tooltipBound.add(tip);

  normalizeInfoBtn(btn);

  const CAN_HOVER = canHover();
  let hoverTimer = null;

  function clearHoverTimer() {
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
  }

  function positionTip() {
    const isModal = tip.classList.contains("info-pop--modal");
    if (isModal) {
      // Modal flavor is centered by CSS; leave positioning to stylesheet
      tip.style.left = "";
      tip.style.top = "";
      tip.style.position = "";
      return;
    }

    const rect = getRect(anchorEl);
    const scrollX = window.scrollX || window.pageXOffset || 0;
    const scrollY = window.scrollY || window.pageYOffset || 0;

    const left = rect.left + scrollX;
    const top  = rect.bottom + scrollY + 6; // small offset below control

    tip.style.position = "absolute";
    tip.style.left = `${left}px`;
    tip.style.top  = `${top}px`;

    const arrow = tip.querySelector(".info-pop__arrow");
    if (arrow) {
      const btnRect = getRect(btn);
      const offset = Math.max(10, Math.min(28, btnRect.left - rect.left));
      arrow.style.left = `${offset}px`;
    }
  }

  function openTip() {
    positionTip();
    setAriaHidden(tip, false);
    btn.setAttribute("aria-expanded", "true");

    // Bind once per open to avoid stacking listeners
    document.addEventListener("mousedown", outsideClose, { capture: true });
    document.addEventListener("keydown", escClose);
    window.addEventListener("resize", onViewport);
    window.addEventListener("scroll", onViewport, { passive: true });
  }

  function closeTip() {
    setAriaHidden(tip, true);
    btn.setAttribute("aria-expanded", "false");

    document.removeEventListener("mousedown", outsideClose, { capture: true });
    document.removeEventListener("keydown", escClose);
    window.removeEventListener("resize", onViewport);
    window.removeEventListener("scroll", onViewport);
  }

  function toggleTip() {
    isOpen(tip) ? closeTip() : openTip();
  }

  function outsideClose(e) {
    // If click is inside any of these, do not close
    if (tip.contains(e.target) || btn.contains(e.target) || label.contains(e.target) || anchorEl.contains(e.target)) {
      return;
    }
    closeTip();
  }

  function escClose(e) {
    if (e.key === "Escape") closeTip();
  }

  function onViewport() {
    if (isOpen(tip)) positionTip();
  }

  // Inline "×" closer (optional)
  const closer = tip.querySelector(".info-pop__close");
  if (closer) {
    closer.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTip();
    });
  }

  // ---------- INTERACTION MODEL ----------
  // 1) Click / keyboard toggle (all tooltips)
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleTip();
  });

  btn.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleTip();
    }
  });

  // 2) Hover-to-open for small, anchored tips (if enabled and device supports hover)
  const isModal = tip.classList.contains("info-pop--modal");
  if (enableHover && !isModal && CAN_HOVER) {
    const HOVER_OPEN_DELAY_MS = 120;
    const HOVER_CLOSE_DELAY_MS = 120;

    function scheduleOpen() {
      clearHoverTimer();
      hoverTimer = setTimeout(openTip, HOVER_OPEN_DELAY_MS);
    }

    function scheduleClose() {
      clearHoverTimer();
      hoverTimer = setTimeout(closeTip, HOVER_CLOSE_DELAY_MS);
    }

    // Hover on the button
    btn.addEventListener("mouseenter", scheduleOpen);
    btn.addEventListener("mouseleave", scheduleClose);

    // Hover on the anchor area (e.g., the select) if different from the button
    if (anchorEl !== btn) {
      anchorEl.addEventListener("mouseenter", scheduleOpen);
      anchorEl.addEventListener("mouseleave", scheduleClose);
    }

    // Keep open while hovering the tooltip itself
    tip.addEventListener("mouseenter", () => clearHoverTimer());
    tip.addEventListener("mouseleave", scheduleClose);

    // Focus/blur support for keyboard users
    btn.addEventListener("focus", openTip);
    btn.addEventListener("blur", scheduleClose);
    if (anchorEl !== btn) {
      anchorEl.addEventListener("focus", openTip);
      anchorEl.addEventListener("blur", scheduleClose);
    }
  }

  // Ensure initial hidden state
  setAriaHidden(tip, true);
  btn.setAttribute("aria-expanded", "false");
}

/* ======================================================
   PUBLIC INITIALIZERS
   ====================================================== */

export function initStorageTypeTooltip() {
  attachTooltip({
    btn: document.getElementById("storageInfoBtn"),
    tip: document.getElementById("storageInfoTip"),
    label: document.querySelector('label[for="storageType"].label-with-info'),
    anchorEl: document.getElementById("storageType"),
    enableHover: true   // open/close on hover for small tooltip
  });
}

/**
 * OS selector tooltip. This assumes your HTML tooltip
 * content already mentions Linux, RHEL, and Windows.
 */
export function initOsTypeTooltip() {
  const label =
    document.querySelector('label[for="os"].label-with-info') ||
    document.querySelector('label[for="os"]');

  attachTooltip({
    btn: document.getElementById("osInfoBtn"),
    tip: document.getElementById("osInfoTip"),
    label,
    anchorEl: document.getElementById("os"),
    enableHover: true   // open/close on hover for small tooltip
  });
}

/**
 * OCI info: open next to the "i" button in the card title.
 * We anchor to the button itself and KEEP click-to-open/close.
 * (No hover for long content to avoid accidental triggers.)
 *
 * IMPORTANT: The OCI info element must use class "info-pop"
 * (NOT "info-pop--modal") in HTML to be positioned next to the button.
 */
export function initOciTooltip() {
  const btn  = document.getElementById("ociInfoBtn");
  const tip  = document.getElementById("ociInfoTip");

  if (!btn || !tip) return;

  // Anchor precisely to the OCI "i" button
  const anchorEl = btn;

  // For labeling/accessible name, reuse the panel heading as "label"
  const label =
    document.querySelector('h3.inline-flex') ||
    document.querySelector('h3:has(#ociInfoBtn)') ||
    document.querySelector('h3') ||
    btn;

  // Force hidden state on boot and ensure anchored behavior
  setAriaHidden(tip, true);
  tip.classList.remove("info-pop--modal"); // ensure it's NOT modal
  tip.setAttribute("role", "tooltip");
  btn.setAttribute("aria-expanded", "false");

  attachTooltip({ btn, tip, label, anchorEl, enableHover: false });
}
