// docs/script.js (4‑provider coordinator - AWS, Azure, GCP, OCI)

import {
  fmt, monthly, sumSafe, fillSelect, setSelectValue, safeSetText,
  appendToText, setStatus, resetCards, nearestCeil, sizeToAzureSku,
  HRS_PER_MONTH,
  getAwsStorageMonthlyFromCfg,
  getAzureStorageSkuAndMonthlyFromCfg,
  getGcpStorageMonthlyFromCfg
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
   - will only show wrappers if they exist in index.html
============================================================ */
function showFamilyFilters() {
  ["awsFamilyWrap", "azFamilyWrap", "gcpFamilyWrap", "ociFamilyWrap"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = "flex";
  });
}

/* ============================================================
   STORAGE HELPERS (delegate to utils.js + OCI simple model)
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

// OCI: single Block Volume price (same for HDD/SSD UI)
function getOciStorageMonthly(_type, gb) {
  if (!isFinite(gb) || gb <= 0) return null;
  const rate = Number(STORAGE_CFG?.oci?.block_volume_gb_month ?? 0);
  return gb * rate;
}

/* ============================================================
   findBestGcp() — same logic as AWS/Azure logic
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

  // Reset family dropdowns on request
  if (resetFamilies) {
    ["awsFamily", "azFamily", "gcpFamily", "ociFamily"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = "";
    });
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

    // ✅ Load FLAT data + updated storage cfg (now includes OCI)
    const data = await loadPricesAndMeta();

    // Footer: freshness + row counts
    try {
      const info = await loadBuildInfo();
      const counts = {
        az: (data.azure || []).length,
        aw: (data.aws   || []).length,
        gc: (data.gcp   || []).length,
        oc: (data.oci   ? 1 : 0) // OCI is a rates object, not an array
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
    } catch (e) {
      awsCard = { error: e.message };
    }

    /* ---------- Azure ---------- */
    let azCard;
    try {
      const z = findBestAzure(data.azure || [], vcpu, ram, os, familyAz);
      azCard = z ? {
        instance: z.instance, vcpu: z.vcpu ?? vcpu, ram: z.ram ?? ram,
        pricePerHourUSD: z.pricePerHourUSD, region: z.region, os
      } : null;
    } catch (e) {
      azCard = { error: e.message };
    }

    /* ---------- GCP ---------- */
    let gcpCard;
    try {
      const g = findBestGcp(data.gcp || [], vcpu, ram, os, familyGcp);
      gcpCard = g ? {
        instance: g.instance, vcpu: g.vcpu, ram: g.ram,
        pricePerHourUSD: g.pricePerHourUSD, region: g.region
      } : null;
    } catch (e) {
      gcpCard = { error: e.message };
    }

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
    } catch (e) {
      ociCard = { error: e.message };
    }

    /* ============================================================
       STORAGE LABEL RENDER
    ============================================================= */
    const selLabel = `${storageAmtGB} GB ${storageType.toUpperCase()}`;
    safeSetText("awsStorageSel", `Storage: ${selLabel}`);
    safeSetText("azStorageSel",  `Storage: ${selLabel}`);
    safeSetText("gcpStorageSel", `Storage: ${selLabel}`);
    safeSetText("ociStorageSel", `Storage: ${selLabel}`); // OCI (if element exists)

    /* AWS Storage */
    const awsStorageMonthly = getAwsStorageMonthly(storageType, storageAmtGB);
    const awsStorageHr      = awsStorageMonthly != null ? awsStorageMonthly / HRS_PER_MONTH : null;

    /* Azure Storage */
    const { sku: azDiskSku, size: azDiskGB, monthlyUSD: azStorageMonthly } =
      getAzureStorage(storageType, storageAmtGB);
    const azStorageHr = azStorageMonthly != null ? azStorageMonthly / HRS_PER_MONTH : null;

    /* GCP Storage */
    const gcpStorageMonthly = getGcpStorageMonthly(storageType, storageAmtGB);
    const gcpStorageHr      = gcpStorageMonthly != null ? gcpStorageMonthly / HRS_PER_MONTH : null;

    /* OCI Storage (single block volume price) */
    const ociStorageMonthly = getOciStorageMonthly(storageType, storageAmtGB);
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
       RENDER OCI (only if IDs exist in HTML)
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
============================================================ */
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
