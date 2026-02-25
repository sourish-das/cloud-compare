// docs/ui/tooltips.js
// Canonical tooltip initializer with future‑proof info button styling

function normalizeInfoBtn(btn) {
  if (!btn) return;
  // Single source of truth for styling (CSS hooks)
  btn.classList.add("info-btn");
  btn.setAttribute("type", "button");
  btn.setAttribute("aria-haspopup", "dialog");
}

/**
 * Generic tooltip/modal wiring
 * - enableHover: true => add hover open/close (only for non-modal tips, and only when device supports hover)
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

  normalizeInfoBtn(btn);

  // Hover capability detection (touch devices often report no hover)
  const CAN_HOVER = !!(window.matchMedia && window.matchMedia("(hover: hover)").matches);

  let hoverTimer = null;
  function clearHoverTimer() {
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
  }

  function getAnchorRect() {
    return anchorEl.getBoundingClientRect();
  }

  function positionTip() {
    const rect = getAnchorRect();
    const scrollX = window.scrollX || window.pageXOffset;
    const scrollY = window.scrollY || window.pageYOffset;
    const left = rect.left + scrollX;
    const top  = rect.bottom + scrollY + 6;

    // If tip has a modal class, let CSS center it; else, anchor it
    const isModal = tip.classList.contains("info-pop--modal");
    if (!isModal) {
      tip.style.position = "absolute";
      tip.style.left = `${left}px`;
      tip.style.top  = `${top}px`;
    } else {
      tip.style.left = "";
      tip.style.top  = "";
      tip.style.position = ""; // fall back to stylesheet rules (fixed/centered)
    }

    const arrow = tip.querySelector(".info-pop__arrow");
    if (arrow && !isModal) {
      const btnRect = btn.getBoundingClientRect();
      const offset = Math.max(10, Math.min(28, btnRect.left - rect.left));
      arrow.style.left = `${offset}px`;
    }
  }

  function openTip() {
    positionTip();
    tip.setAttribute("aria-hidden", "false");
    btn.setAttribute("aria-expanded", "true");
    document.addEventListener("click", outsideClose, { capture: true });
    document.addEventListener("keydown", escClose);
  }

  function closeTip() {
    tip.setAttribute("aria-hidden", "true");
    btn.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", outsideClose, { capture: true });
    document.removeEventListener("keydown", escClose);
  }

  function toggleTip() {
    const open = tip.getAttribute("aria-hidden") === "false";
    open ? closeTip() : openTip();
  }

  function outsideClose(e) {
    // Do not close if the click is inside any of these
    if (
      tip.contains(e.target) ||
      btn.contains(e.target) ||
      label.contains(e.target) ||
      anchorEl.contains(e.target)
    ) {
      return;
    }
    closeTip();
  }

  function escClose(e) {
    if (e.key === "Escape") closeTip();
  }

  // Allow an inline "close" control inside the tooltip (×)
  const closer = tip.querySelector(".info-pop__close");
  if (closer) {
    closer.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTip();
    });
  }

  // ---------- INTERACTION MODEL ----------
  // 1) Click / keyboard toggle (works for all: small tooltips + modal)
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

  // 2) Hover-to-open ONLY when requested and ONLY for non-modal tips
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
    tip.addEventListener("mouseenter", () => {
      clearHoverTimer();
    });
    tip.addEventListener("mouseleave", scheduleClose);

    // Also support focus/blur for keyboard-only users
    btn.addEventListener("focus", openTip);
    btn.addEventListener("blur", scheduleClose);
    if (anchorEl !== btn) {
      anchorEl.addEventListener("focus", openTip);
      anchorEl.addEventListener("blur", scheduleClose);
    }
  }

  // Keep position synced on viewport changes
  window.addEventListener("resize", () => {
    if (tip.getAttribute("aria-hidden") === "false") positionTip();
  });
  window.addEventListener("scroll", () => {
    if (tip.getAttribute("aria-hidden") === "false") positionTip();
  });
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

  // Anchor precisely to the OCI "i" button
  const anchorEl = btn;

  // For labeling/accessible name, reuse the panel heading as "label"
  const label =
    document.querySelector('h3.inline-flex') ||
    document.querySelector('h3:has(#ociInfoBtn)') ||
    document.querySelector('h3') ||
    btn;

  // Force hidden state on boot and ensure anchored behavior
  if (tip) {
    tip.setAttribute("aria-hidden", "true");
    tip.classList.remove("info-pop--modal"); // ensure it's NOT modal
    tip.setAttribute("role", "tooltip");
  }
  if (btn) btn.setAttribute("aria-expanded", "false");

  attachTooltip({ btn, tip, label, anchorEl, enableHover: false });
}
