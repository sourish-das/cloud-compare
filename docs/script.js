// docs/script.js (4‑provider coordinator - AWS, Azure, GCP, OCI)

import {
  fmt, monthly, sumSafe, fillSelect, setSelectValue, safeSetText,
  appendToText, setStatus, resetCards,
  HRS_PER_MONTH,
  getAwsStorageMonthlyFromCfg,
  getAzureStorageSkuAndMonthlyFromCfg,
  getGcpStorageMonthlyFromCfg,
  getOciStorageMonthlyFromCfg
} from "./ui/utils.js";

import { STORAGE_CFG, loadPricesAndMeta } from "./ui/state.js";
import { initStorageTypeTooltip, initOsTypeTooltip, initOciTooltip } from "./ui/tooltips.js";

import {
  findBestAws,
  findBestAzure,
  gcpFamilyMatch,
  findBestOci
} from "./ui/matchers.js";

/* ============================================================
   Freshness loader: docs/data/buildInfo.json (published by update-all.yml)
============================================================ */
async function loadBuildInfo() {
  try {
    const r = await fetch('./data/buildInfo.json?v=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/* ============================================================
   FILTERS (show controls)
   - NOTE: OCI shows Processor (not Family)
============================================================ */
function showFamilyFilters() {
  // OCI: use ociProcessorWrap instead of the old ociFamilyWrap
  ["awsFamilyWrap", "azFamilyWrap", "gcpFamilyWrap", "ociProcessorWrap"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = "flex";
  });
}

/* ============================================================
   STORAGE HELPERS (delegate to utils.js)
============================================================ */
function getAwsStorageMonthly(type, gb) {
  return getAwsStorageMonthlyFromCfg(type, gb, STORAGE_CFG.aws);
}
function getAzureStorage(type, gb) {
  return getAzureStorageSkuAndMonthlyFromCfg(type, gb, STORAGE_CFG.azure);
}
function getGcpStorageMonthly(type, gb) {
  return getGcpStorageMonthlyFromCfg(type, gb, STORAGE_CFG.gcp);
}

/* ============================================================
   Windows ↔ Arm guardrails (provider-agnostic helpers)
   - Keep Windows off Arm families/series across providers.
============================================================ */
function isArmArchField(obj) {
  const a = String(obj?.arch || obj?.cpuArch || obj?.architecture || "").toLowerCase();
  return a.includes("arm") || a.includes("aarch64") || a.includes("ampere");
}
function isArmSkuPattern(provider, skuString) {
  const s = String(skuString || "").toLowerCase();

  if (provider === "aws") {
    // Graviton & A1 families (t4g, c7g, m7g, r7g, a1)
    return /(t4g|a1|c\d+g|m\d+g|r\d+g)\b/.test(s) || s.includes("graviton");
  }
  if (provider === "azure") {
    // Arm series are the *psv5 (Dpsv5/Dpldsv5/Epsv5)
    return /\b(dpsv5|dpldsv5|epsv5)\b/.test(s);
  }
  if (provider === "gcp") {
    // Arm families: T2A/C4A/N4A, plus Grace A4X
    return /\b(t2a|c4a|n4a|a4x)\b/.test(s);
  }
  if (provider === "oci") {
    // Ampere A1/A2; also catch "ampere"/"arm"
    return /\.a1\b|\.a2\b/.test(s) || s.includes("ampere") || s.includes("arm");
  }
  return false;
}
function isArmEntry(provider, entry) {
  const byArch = isArmArchField(entry);
  const label = entry?.instance || entry?.family || entry?.series || entry?.size || "";
  const byName = isArmSkuPattern(provider, label);
  return byArch || byName;
}
function filterOutArmForWindows(list, provider, os) {
  if (String(os || "").toLowerCase() !== "windows") return Array.isArray(list) ? list : [];
  if (!Array.isArray(list)) return [];
  const filtered = list.filter(x => !isArmEntry(provider, x));
  // If everything got filtered out (unlikely), fall back to original to avoid a hard failure.
  return filtered.length > 0 ? filtered : list;
}
function sanitizeFamilyForWindows(provider, family, os) {
  if (String(os || "").toLowerCase() !== "windows") return family || "";
  return isArmSkuPattern(provider, family) ? "" : (family || "");
}

/* Disable specific option values in a <select> if present (case-insensitive) */
function disableOptionsIfPresent(selectEl, values, disabled) {
  if (!selectEl || !Array.isArray(values) || values.length === 0) return;
  const targets = values.map(v => String(v).toLowerCase());
  Array.from(selectEl.options || []).forEach(opt => {
    if (targets.includes(String(opt.value).toLowerCase())) {
      opt.disabled = !!disabled;
    }
  });
}

/* Sanitize family dropdowns + OCI processor dropdown when OS toggles */
function sanitizeFamiliesForWindows(os) {
  const isWin = String(os || "").toLowerCase() === "windows";

  // AWS family
  const awsSel = document.getElementById("awsFamily");
  if (awsSel) {
    if (isWin && isArmSkuPattern("aws", awsSel.value)) awsSel.value = "";
    disableOptionsIfPresent(awsSel, ["t4g", "c7g", "m7g", "r7g", "a1", "graviton"], isWin);
  }

  // Azure family
  const azSel = document.getElementById("azFamily");
  if (azSel) {
    if (isWin && isArmSkuPattern("azure", azSel.value)) azSel.value = "";
    disableOptionsIfPresent(azSel, ["Dpsv5", "Dpldsv5", "Epsv5"], isWin);
  }

  // GCP family
  const gcpSel = document.getElementById("gcpFamily");
  if (gcpSel) {
    if (isWin && isArmSkuPattern("gcp", gcpSel.value)) gcpSel.value = "";
    disableOptionsIfPresent(gcpSel, ["t2a", "c4a", "n4a", "a4x"], isWin);
  }

  // OCI processor
  const ociProcEl = document.getElementById("ociProcessor");
  if (ociProcEl) {
    // Disable "arm" option when OS = Windows; revert to Auto if currently set
    Array.from(ociProcEl.options || []).forEach(opt => {
      if (String(opt.value).toLowerCase() === "arm") opt.disabled = isWin;
    });
    if (isWin && String(ociProcEl.value).toLowerCase() === "arm") {
      ociProcEl.value = "auto";
    }
  }
}

/* ============================================================
   findBestGcp()
============================================================ */
function findBestGcp(list, vcpu, ram, os, family) {
  if (!Array.isArray(list) || list.length === 0)
    throw new Error("GCP price list is empty");

  const wantOs = String(os || "").toLowerCase();

  const filtered = list.filter(x =>
    x &&
    isFinite(x.vcpu) &&
    isFinite(x.ram) &&
    isFinite(x.pricePerHourUSD) &&
    (!wantOs || String(x.os || "").toLowerCase() === wantOs) &&
    gcpFamilyMatch(x, family)
  );

  if (filtered.length === 0) {
    const fLabel = family ? ` family=${family}` : "";
    throw new Error(`No GCP entries for OS=${os || "any"}${fLabel}`);
  }

  let best = null, bestScore = Infinity;
  for (const x of filtered) {
    const score = Math.abs(x.vcpu - vcpu) + Math.abs(x.ram - ram);
    const tieBreaker = x.pricePerHourUSD;
    if (score < bestScore || (score === bestScore && tieBreaker < (best?.pricePerHourUSD ?? Infinity))) {
      best = x;
      bestScore = score;
    }
  }
  return best;
}

/* ============================================================
   OCI helpers (UI-side)
   - latest generation per processor family
============================================================ */
function ociLatestGen(linux, processor) {
  if (!linux || !processor || processor === "auto") return null;

  // Newest -> oldest preference (extend when Oracle adds new gens)
  const ORDER = {
    amd:   ["E6", "E5", "E4", "E3"],
    arm:   ["A4", "A2", "A1"],
    intel: ["Optimized3", "Standard3"]
  };

  const arr = processor === "amd"   ? (linux.amd   || [])
            : processor === "arm"   ? (linux.arm   || [])
            : processor === "intel" ? (linux.intel || [])
            : [];

  if (!Array.isArray(arr) || arr.length === 0) return null;

  const gens = new Set(arr.map(e => String(e.gen || "").toLowerCase()));
  for (const g of (ORDER[processor] || [])) {
    if (gens.has(g.toLowerCase())) return g;
  }
  // Fallback: lexicographically latest if labels differ
  return arr
    .map(e => String(e.gen || ""))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
    .pop() || null;
}

/* ============================================================
   MAIN compare()
============================================================ */
export async function compare(resetFamilies = false) {
  const btn = document.getElementById("compareBtn");
  if (btn) btn.disabled = true;
  setStatus("Fetching local prices…");

  // Reset family / processor dropdowns on request
  if (resetFamilies) {
    const awsEl = document.getElementById("awsFamily");
    if (awsEl) awsEl.value = "";

    const azEl = document.getElementById("azFamily");
    if (azEl) azEl.value = "";

    const gcpEl = document.getElementById("gcpFamily");
    if (gcpEl) gcpEl.value = "";

    // OCI: reset processor selector to Auto
    const ociProcReset = document.getElementById("ociProcessor");
    if (ociProcReset) ociProcReset.value = "auto";
  }

  const os           = document.getElementById("os")?.value || "Linux";
  const vcpu         = Number(document.getElementById("cpu")?.value ?? 0);
  const ram          = Number(document.getElementById("ram")?.value ?? 0);
  const storageType  = (document.getElementById("storageType")?.value || "hdd").toLowerCase();
  const storageAmtGB = Number(document.getElementById("storageAmt")?.value ?? 0);

  // Read raw family selections, then sanitize for Windows
  const familyAwsRaw = document.getElementById("awsFamily")?.value || "";
  const familyAzRaw  = document.getElementById("azFamily")?.value  || "";
  const familyGcpRaw = document.getElementById("gcpFamily")?.value || "";

  const familyAws = sanitizeFamilyForWindows("aws",   familyAwsRaw, os);
  const familyAz  = sanitizeFamilyForWindows("azure", familyAzRaw,  os);
  const familyGcp = sanitizeFamilyForWindows("gcp",   familyGcpRaw, os);

  // NEW: OCI processor (replaces 'family')
  const ociProcEl = document.getElementById("ociProcessor");
  let ociProcessor = (ociProcEl?.value || "auto").toLowerCase();

  // Enforce Windows ≠ Ampere (UI-side)
  if (String(os).toLowerCase() === "windows") {
    const armOpt = ociProcEl?.querySelector('option[value="arm"]');
    if (armOpt) armOpt.disabled = true;
    if (ociProcessor === "arm") {
      ociProcessor = "auto";
      if (ociProcEl) ociProcEl.value = "auto";
    }
  } else {
    const armOpt = ociProcEl?.querySelector('option[value="arm"]');
    if (armOpt) armOpt.disabled = false;
  }

  // Also sanitize dropdowns now (so the UI reflects the constraint)
  sanitizeFamiliesForWindows(os);

  try {
    resetCards();

    const data = await loadPricesAndMeta();

    /* ---------- Footer: freshness + row counts (robust, no optional chaining) ---------- */
    try {
      function len(a) { return Array.isArray(a) ? a.length : 0; }
      function ociRowCount(oci) {
        if (!oci || typeof oci !== "object") return 0;
        const linux = oci.linux || {};
        return len(linux.amd) + len(linux.arm) + len(linux.intel);
      }

      const info = await loadBuildInfo();
      const counts = {
        az: Array.isArray(data.azure) ? data.azure.length : 0,
        aw: Array.isArray(data.aws)   ? data.aws.length   : 0,
        gc: Array.isArray(data.gcp)   ? data.gcp.length   : 0,
        oc: ociRowCount(data.oci)
      };
      const when = (info && info.generatedAt) ? info.generatedAt : "—";
      safeSetText(
        "dataInfo",
        `Data: ${when} · Rows — Azure: ${counts.az}, AWS: ${counts.aw}, GCP: ${counts.gc}, OCI: ${counts.oc}`
      );
    } catch (e) {
      console.warn("Footer render failed:", e);
      safeSetText("dataInfo", "Data: — · Rows — Azure: —, AWS: —, GCP: —, OCI: —");
    }

    // Defensive pre-filtering: keep Windows off Arm families (data-level) for AWS/Azure/GCP
    const awsList = filterOutArmForWindows(data.aws || [],   "aws",   os);
    const azList  = filterOutArmForWindows(data.azure || [], "azure", os);
    const gcpList = filterOutArmForWindows(data.gcp || [],   "gcp",   os);

    /* ---------- AWS ---------- */
    let awsCard;
    try {
      const a = findBestAws(awsList, vcpu, ram, os, familyAws);
      awsCard = a ? { instance: a.instance, vcpu: a.vcpu, ram: a.ram, pricePerHourUSD: a.pricePerHourUSD, region: a.region } : null;
    } catch (e) { awsCard = { error: e.message }; }

    /* ---------- Azure ---------- */
    let azCard;
    try {
      const z = findBestAzure(azList, vcpu, ram, os, familyAz);
      azCard = z ? { instance: z.instance, vcpu: z.vcpu ?? vcpu, ram: z.ram ?? ram, pricePerHourUSD: z.pricePerHourUSD, region: z.region, os } : null;
    } catch (e) { azCard = { error: e.message }; }

    /* ---------- GCP ---------- */
    let gcpCard;
    try {
      const g = findBestGcp(gcpList, vcpu, ram, os, familyGcp);
      gcpCard = g ? { instance: g.instance, vcpu: g.vcpu, ram: g.ram, pricePerHourUSD: g.pricePerHourUSD, region: g.region } : null;
    } catch (e) { gcpCard = { error: e.message }; }

    /* ---------- OCI ---------- */
    let ociCard;
    try {
      // Build options for OCI matcher
      const ociCompute = data.oci;
      const linux = (ociCompute && ociCompute.linux) ? ociCompute.linux : {};
      const latestGen = (ociProcessor === "auto") ? null : ociLatestGen(linux, ociProcessor);
      const ociOptions = latestGen
        ? { processor: ociProcessor, generation: latestGen }
        : { processor: ociProcessor };

      const o = findBestOci(ociCompute, vcpu, ram, os, ociOptions);
      ociCard = o ? { instance: o.instance, vcpu: o.vcpu, ram: o.ram, pricePerHourUSD: o.pricePerHourUSD, region: (STORAGE_CFG && STORAGE_CFG.oci && STORAGE_CFG.oci.region) ? STORAGE_CFG.oci.region : "—" } : null;
    } catch (e) { ociCard = { error: e.message }; }

    /* ---------- Storage labels ---------- */
    const selLabel = `${storageAmtGB} GB ${storageType.toUpperCase()}`;
    safeSetText("awsStorageSel", `Storage: ${selLabel}`);
    safeSetText("azStorageSel",  `Storage: ${selLabel}`);
    safeSetText("gcpStorageSel", `Storage: ${selLabel}`);
    safeSetText("ociStorageSel", `Storage: ${selLabel}`);

    /* ---------- Storage costs ---------- */
    const awsStorageMonthly = getAwsStorageMonthly(storageType, storageAmtGB);
    const awsStorageHr      = awsStorageMonthly != null ? awsStorageMonthly / HRS_PER_MONTH : null;

    const { sku: azDiskSku, size: azDiskGB, monthlyUSD: azStorageMonthly } =
      getAzureStorage(storageType, storageAmtGB);
    const azStorageHr = azStorageMonthly != null ? azStorageMonthly / HRS_PER_MONTH : null;

    const gcpStorageMonthly = getGcpStorageMonthly(storageType, storageAmtGB);
    const gcpStorageHr      = gcpStorageMonthly != null ? gcpStorageMonthly / HRS_PER_MONTH : null;

    const ociStorageMonthly = getOciStorageMonthlyFromCfg(storageAmtGB, STORAGE_CFG.oci);
    const ociStorageHr      = ociStorageMonthly != null ? ociStorageMonthly / HRS_PER_MONTH : null;

    /* ============================================================
       RENDER AWS
    ============================================================= */
    if (!awsCard || awsCard.error) {
      const el = document.getElementById("awsInstance");
      if (el) el.innerHTML = `<strong>Recommended Instance:</strong> Error: ${awsCard?.error ?? "No match"}`;
    } else {
      const el = document.getElementById("awsInstance");
      if (el) el.innerHTML = `<strong>Recommended Instance:</strong> ${awsCard.instance} (${awsCard.region})`;
      safeSetText("awsCpu",     `vCPU: ${awsCard.vcpu}`);
      safeSetText("awsRam",     `RAM: ${awsCard.ram} GB`);
      safeSetText("awsPrice",   `Price/hr: ${fmt(awsCard.pricePerHourUSD)}`);
      safeSetText("awsMonthly", `≈ Monthly: ${fmt(monthly(awsCard.pricePerHourUSD))}`);
    }

    /* ============================================================
       RENDER AZURE
    ============================================================= */
    if (!azCard || azCard.error) {
      const el = document.getElementById("azInstance");
      if (el) el.innerHTML = `<strong>Recommended VM Size:</strong> Error: ${azCard?.error ?? "No match"}`;
    } else {
      const el = document.getElementById("azInstance");
      if (el) el.innerHTML = `<strong>Recommended VM Size:</strong> ${azCard.instance} (${azCard.region})`;
      safeSetText("azCpu",     `vCPU: ${azCard.vcpu}`);
      safeSetText("azRam",     `RAM: ${azCard.ram} GB`);
      safeSetText("azPrice",   `Price/hr: ${fmt(azCard.pricePerHourUSD)}`);
      safeSetText("azMonthly", `≈ Monthly: ${fmt(monthly(azCard.pricePerHourUSD))}`);
    }

    /* ============================================================
       RENDER GCP
    ============================================================= */
    if (!gcpCard || gcpCard.error) {
      const el = document.getElementById("gcpInstance");
      if (el) el.innerHTML = `<strong>Recommended Machine:</strong> Error: ${gcpCard?.error ?? "No match"}`;
    } else {
      const el = document.getElementById("gcpInstance");
      if (el) el.innerHTML = `<strong>Recommended Machine:</strong> ${gcpCard.instance} (${gcpCard.region})`;
      safeSetText("gcpCpu",     `vCPU: ${gcpCard.vcpu}`);
      safeSetText("gcpRam",     `RAM: ${gcpCard.ram} GB`);
      safeSetText("gcpPrice",   `Price/hr: ${fmt(gcpCard.pricePerHourUSD)}`);
      safeSetText("gcpMonthly", `≈ Monthly: ${fmt(monthly(gcpCard.pricePerHourUSD))}`);
    }

    /* ============================================================
       RENDER OCI
    ============================================================= */
    if (!ociCard || ociCard.error) {
      const el = document.getElementById("ociInstance");
      if (el) el.innerHTML = `<strong>Recommended Machine:</strong> Error: ${ociCard?.error ?? "No match"}`;
    } else {
      const el = document.getElementById("ociInstance");
      if (el) el.innerHTML = `<strong>Recommended Machine:</strong> ${ociCard.instance} (${ociCard.region})`;
      safeSetText("ociCpu",     `vCPU: ${ociCard.vcpu}`);
      safeSetText("ociRam",     `RAM: ${ociCard.ram} GB`);
      safeSetText("ociPrice",   `Price/hr: ${fmt(ociCard.pricePerHourUSD)}`);
      safeSetText("ociMonthly", `≈ Monthly: ${fmt(monthly(ociCard.pricePerHourUSD))}`);
    }

    /* ============================================================
       STORAGE COST RENDER
    ============================================================= */
    safeSetText("awsStoragePriceHr", fmt(awsStorageHr));
    safeSetText("awsStorageMonthly", fmt(awsStorageMonthly));

    safeSetText("azStoragePriceHr", fmt(azStorageHr));
    safeSetText("azStorageMonthly", fmt(azStorageMonthly));

    safeSetText("gcpStoragePriceHr", fmt(gcpStorageHr));
    safeSetText("gcpStorageMonthly", fmt(gcpStorageMonthly));

    safeSetText("ociStoragePriceHr", fmt(ociStorageHr));
    safeSetText("ociStorageMonthly", fmt(ociStorageMonthly));

    if (azDiskSku) {
      const extra = (azDiskGB && azDiskGB !== storageAmtGB)
        ? ` (billed as ${azDiskGB} GB ${storageType.toUpperCase()}, ${azDiskSku})`
        : ` (${azDiskSku})`;
      appendToText("azStorageSel", extra);
    }

    /* ============================================================
       TOTAL COSTS
    ============================================================= */
    const awsTotalHr  = sumSafe(awsCard?.pricePerHourUSD,  awsStorageHr);
    const awsTotalMon = sumSafe(monthly(awsCard?.pricePerHourUSD), awsStorageMonthly);

    const azTotalHr  = sumSafe(azCard?.pricePerHourUSD,  azStorageHr);
    const azTotalMon = sumSafe(monthly(azCard?.pricePerHourUSD), azStorageMonthly);

    const gcpTotalHr  = sumSafe(gcpCard?.pricePerHourUSD, gcpStorageHr);
    const gcpTotalMon = sumSafe(monthly(gcpCard?.pricePerHourUSD), gcpStorageMonthly);

    const ociTotalHr  = sumSafe(ociCard?.pricePerHourUSD, ociStorageHr);
    const ociTotalMon = sumSafe(monthly(ociCard?.pricePerHourUSD), ociStorageMonthly);

    safeSetText("awsTotalHr",      fmt(awsTotalHr));
    safeSetText("awsTotalMonthly", fmt(awsTotalMon));

    safeSetText("azTotalHr",       fmt(azTotalHr));
    safeSetText("azTotalMonthly",  fmt(azTotalMon));

    safeSetText("gcpTotalHr",      fmt(gcpTotalHr));
    safeSetText("gcpTotalMonthly", fmt(gcpTotalMon));

    safeSetText("ociTotalHr",      fmt(ociTotalHr));
    safeSetText("ociTotalMonthly", fmt(ociTotalMon));

    showFamilyFilters();
    setStatus("Comparison complete ✓");
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`, "error");
    alert("Unable to read local prices. Please try again.");
  } finally {
    if (btn) btn.disabled = false;
  }
}

window.compare = compare;

/* ============================================================
   BOOTSTRAP
   - Populate controls & tooltips only; DO NOT auto-run compare.
============================================================ */
document.addEventListener("DOMContentLoaded", () => {
  fillSelect("os",   [{ value: "Linux", text: "Linux" }, { value: "Windows", text: "Windows" }]);
  fillSelect("cpu",  [1, 2, 4, 8, 16].map(v => ({ value: v, text: v })));
  fillSelect("ram",  [1, 2, 4, 8, 16, 32].map(v => ({ value: v, text: v })));

  setSelectValue("os", "Linux");
  setSelectValue("cpu", "2");
  setSelectValue("ram", "4");

  // Keep behavior consistent: do not auto-compare on OS change,
  // but do sanitize arm families/options instantly in the UI.
  const osEl = document.getElementById("os");
  if (osEl) osEl.addEventListener("change", () => sanitizeFamiliesForWindows(osEl.value));

  // Listen for changes on family/processor filters -> run compare
  ["awsFamily", "azFamily", "gcpFamily", "ociProcessor"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", () => compare(false));
  });

  initStorageTypeTooltip();
  initOsTypeTooltip();
  initOciTooltip();

  // Do NOT auto-compare; wait for explicit user click.
  setStatus("Select inputs and click Compare");
  safeSetText("dataInfo", "Loading…"); // will be replaced after first Compare
});
