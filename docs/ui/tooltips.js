// docs/ui/tooltips.js
// Canonical tooltip initializer with future‑proof info button styling

function normalizeInfoBtn(btn) {
  if (!btn) return;
  // Single source of truth for styling (CSS hooks)
  btn.classList.add("info-btn");
  btn.setAttribute("type", "button");
  btn.setAttribute("aria-haspopup", "dialog");
}

function attachTooltip({
  btn,
  tip,
  label,
  anchorEl
}) {
  if (!btn || !tip || !label || !anchorEl) return;

  normalizeInfoBtn(btn);

  function getAnchorRect() {
    return anchorEl.getBoundingClientRect();
  }

  function positionTip() {
    const rect = getAnchorRect();
    const scrollX = window.scrollX || window.pageXOffset;
    const scrollY = window.scrollY || window.pageYOffset;
    const left = rect.left + scrollX;
    const top  = rect.bottom + scrollY + 6;

    tip.style.position = "absolute";
    tip.style.left = `${left}px`;
    tip.style.top  = `${top}px`;

    const arrow = tip.querySelector(".info-pop__arrow");
    if (arrow) {
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
    if (
      tip.contains(e.target) ||
      btn.contains(e.target) ||
      label.contains(e.target) ||
      anchorEl.contains(e.target)
    ) return;
    closeTip();
  }

  function escClose(e) {
    if (e.key === "Escape") closeTip();
  }

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
    anchorEl: document.getElementById("storageType")
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
    anchorEl: document.getElementById("os")
  });
}
