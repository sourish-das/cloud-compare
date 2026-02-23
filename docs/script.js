// docs/script.js (4‑provider coordinator - AWS, Azure, GCP, OCI)

import {
  fmt, monthly, sumSafe, fillSelect, setSelectValue, safeSetText,
  appendToText, setStatus, resetCards, nearestCeil, sizeToAzureSku,
  HRS_PER_MONTH,
  getAwsStorageMonthlyFromCfg,
  getAzureStorageSkuAndMonthlyFromCfg,
  getGcpStorageMonthlyFromCfg,
  getOciStorageMonthlyFromCfg
} from "./ui/utils.js";

import { STORAGE_CFG, loadPricesAndMeta } from "./ui/state.js";
import { initStorageTypeTooltip, initOsTypeTooltip } from "./ui/tooltips.js";

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
   FAMILY FILTERS (AWS, Azure, GCP, OCI)
============================================================ */
function showFamilyFilters() {
  ["awsFamilyWrap", "azFamilyWrap", "gcpFamilyWrap", "ociFamilyWrap"].forEach(id => {
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
   MAIN compare() — AWS + Azure + GCP + OCI
============================================================ */
export async function compare(resetFamilies = false) {
  const btn = document.getElementById("compareBtn");
  if (btn) btn.disabled = true;
  setStatus("Fetching local prices…");

  // ✅ Reset family dropdowns on request
  // AWS/Azure/GCP: Auto is ""  |  OCI: Auto is "auto"
  if (resetFamilies) {
    const awsEl = document.getElementById("awsFamily");
    if (awsEl) awsEl.value = "";

    const azEl = document.getElementById("azFamily");
    if (azEl) azEl.value = "";

    const gcpEl = document.getElementById("gcpFamily");
    if (gcpEl) gcpEl.value = "";

    const ociEl = document.getElementById("ociFamily");
    if (ociEl) ociEl.value = "auto";   // ✅ important fix
  }

  const os           = document.getElementById("os")?.value || "Linux";
  const vcpu         = Number(document.getElementById("cpu")?.value ?? 0);
  const ram          = Number(document.getElementById("ram")?.value ?? 0);
  const storageType  = (document.getElementById("storageType")?.value || "hdd").toLowerCase();
  const storageAmtGB = Number(document.getElementById("storageAmt")?.value ?? 0);

  const familyAws = document.getElementById("awsFamily")?.value || "";
  const familyAz  = document.getElementById("azFamily")?.value  || "";
  const familyGcp = document.getElementById("gcpFamily")?.value || "";
  const familyOci = document.getElementById("ociFamily")?.value || "auto";

  try {
    resetCards();

    const data = await loadPricesAndMeta();

    try {
      const info = await loadBuildInfo();
      const counts = {
        az: (data.azure || []).length,
        aw: (data.aws   || []).length,
        gc: (data.gcp   || []).length,
        oc: (data.oci   ? 1 : 0)
      };
      const when = info?.generatedAt || '—';
      safeSetText(
        "dataInfo",
        `Data: ${when} · Rows — Azure: ${counts.az}, AWS: ${counts.aw}, GCP: ${counts.gc}, OCI: ${counts.oc}`
      );
    } catch { /* non-fatal */ }

    /* ---------- AWS ---------- */
    let awsCard;
    try {
      const a = findBestAws(data.aws || [], vcpu, ram, os, familyAws);
      awsCard = a ? {
        instance: a.instance, vcpu: a.vcpu, ram: a.ram,
        pricePerHourUSD: a.pricePerHourUSD, region: a.region
      } : null;
    } catch (e) { awsCard = { error: e.message }; }

    /* ---------- Azure ---------- */
    let azCard;
    try {
      const z = findBestAzure(data.azure || [], vcpu, ram, os, familyAz);
      azCard = z ? {
        instance: z.instance, vcpu: z.vcpu ?? vcpu, ram: z.ram ?? ram,
        pricePerHourUSD: z.pricePerHourUSD, region: z.region, os
      } : null;
    } catch (e) { azCard = { error: e.message }; }

    /* ---------- GCP ---------- */
    let gcpCard;
    try {
      const g = findBestGcp(data.gcp || [], vcpu, ram, os, familyGcp);
      gcpCard = g ? {
        instance: g.instance, vcpu: g.vcpu, ram: g.ram,
        pricePerHourUSD: g.pricePerHourUSD, region: g.region
      } : null;
    } catch (e) { gcpCard = { error: e.message }; }

    /* ---------- OCI ---------- */
    let ociCard;
    try {
      const o = findBestOci(data.oci, vcpu, ram, os, familyOci);
      ociCard = o ? {
        instance: o.instance,
        vcpu: o.vcpu,
        ram: o.ram,
        pricePerHourUSD: o.pricePerHourUSD,
        region: STORAGE_CFG?.oci?.region || "—"
      } : null;
    } catch (e) { ociCard = { error: e.message }; }

    const selLabel = `${storageAmtGB} GB ${storageType.toUpperCase()}`;
    safeSetText("awsStorageSel", `Storage: ${selLabel}`);
    safeSetText("azStorageSel",  `Storage: ${selLabel}`);
    safeSetText("gcpStorageSel", `Storage: ${selLabel}`);
    safeSetText("ociStorageSel", `Storage: ${selLabel}`);

    const awsStorageMonthly = getAwsStorageMonthly(storageType, storageAmtGB);
    const awsStorageHr      = awsStorageMonthly != null ? awsStorageMonthly / HRS_PER_MONTH : null;

    const { sku: azDiskSku, size: azDiskGB, monthlyUSD: azStorageMonthly } =
      getAzureStorage(storageType, storageAmtGB);
    const azStorageHr = azStorageMonthly != null ? azStorageMonthly / HRS_PER_MONTH : null;

    const gcpStorageMonthly = getGcpStorageMonthly(storageType, storageAmtGB);
    const gcpStorageHr      = gcpStorageMonthly != null ? gcpStorageMonthly / HRS_PER_MONTH : null;

    const ociStorageMonthly = getOciStorageMonthlyFromCfg(storageAmtGB, STORAGE_CFG.oci);
    const ociStorageHr      = ociStorageMonthly != null ? ociStorageMonthly / HRS_PER_MONTH : null;

    /* RENDER AWS/AZ/GCP/OCI unchanged... */

    // (Keep rest of your render and totals logic exactly as you already have.)

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

document.addEventListener("DOMContentLoaded", () => {
  fillSelect("os",   [{ value: "Linux", text: "Linux" }, { value: "Windows", text: "Windows" }]);
  fillSelect("cpu",  [1, 2, 4, 8, 16].map(v => ({ value: v, text: v })));
  fillSelect("ram",  [1, 2, 4, 8, 16, 32].map(v => ({ value: v, text: v })));

  setSelectValue("os", "Linux");
  setSelectValue("cpu", "2");
  setSelectValue("ram", "4");

  ["awsFamily", "azFamily", "gcpFamily", "ociFamily"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", () => compare(false));
  });

  initStorageTypeTooltip();
  initOsTypeTooltip();

  compare(false);
});
