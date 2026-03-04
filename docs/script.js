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
  findBestGcp,        // centralized in matchers.js (Option B)
  findBestOci
} from "./ui/matchers.js";

/* ============================================================
   Provider label maps (centralized)
============================================================ */
// === Provider-specific UI labels (centralized) ===
const PROVIDER_LABELS = {
  aws:   { price: 'EC2 Price/hr',               monthly: 'EC2 Monthly' },
  azure: { price: 'VM Price/hr',                monthly: 'VM Monthly' },
  gcp:   { price: 'Compute Engine Price/hr',    monthly: 'Compute Engine Monthly' },
  oci:   { price: 'Compute Price/hr',           monthly: 'Compute Monthly' }
};

// === Storage labels per provider (short to fit cards) ===
const STORAGE_LABELS = {
  aws:   { hr: 'EBS Price/hr',             monthly: 'EBS Monthly' },
  azure: { hr: 'Azure Disk Price/hr',      monthly: 'Azure Disk Monthly' },
  gcp:   { hr: 'Persistent Disk Price/hr', monthly: 'Persistent Disk Monthly' },
  oci:   { hr: 'Block Volume Price/hr',    monthly: 'Block Volume Monthly' },
};

/* ============================================================
   Freshness loader: docs/data/buildInfo.json
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
  ["awsFamilyWrap", "azFamilyWrap", "gcpFamilyWrap", "ociProcessorWrap"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = "flex";
  });
}

/* ============================================================
   STORAGE HELPERS
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
   Windows ↔ Arm guardrails (UI-side)
============================================================ */

function isArmArchField(obj) {
  const a = String(obj?.arch || obj?.cpuArch || obj?.architecture || "").toLowerCase();
  return a.includes("arm") || a.includes("aarch64") || a.includes("ampere");
}
function isArmSkuPattern(provider, skuString) {
  const s = String(skuString || "").toLowerCase();

  if (provider === "aws")  return /(t4g|a1|c\d+g|m\d+g|r\d+g)\b/.test(s) || s.includes("graviton");
  if (provider === "azure") return /\b(dpsv5|dpldsv5|epsv5)\b/.test(s);
  if (provider === "gcp")  return /\b(t2a|c4a|n4a|a4x)\b/.test(s);
  if (provider === "oci")  return /\.a1\b|\.a2\b/.test(s) || s.includes("ampere") || s.includes("arm");

  return false;
}
function isArmEntry(provider, entry) {
  const byArch = isArmArchField(entry);
  const label  = entry?.instance || entry?.family || entry?.series || entry?.size || "";
  return byArch || isArmSkuPattern(provider, label);
}
function filterOutArmForWindows(list, provider, os) {
  if (String(os).toLowerCase() !== "windows") return list || [];
  if (!Array.isArray(list)) return [];
  const f = list.filter(x => !isArmEntry(provider, x));
  return f.length > 0 ? f : list;
}
function sanitizeFamilyForWindows(provider, family, os) {
  if (String(os).toLowerCase() !== "windows") return family || "";
  return isArmSkuPattern(provider, family) ? "" : family || "";
}

function disableOptionsIfPresent(selectEl, values, disabled) {
  if (!selectEl) return;
  const targets = values.map(v => v.toLowerCase());
  Array.from(selectEl.options || []).forEach(o => {
    if (targets.includes(o.value.toLowerCase())) {
      o.disabled = !!disabled;
    }
  });
}

function sanitizeFamiliesForWindows(os) {
  const isWin = String(os).toLowerCase() === "windows";

  const awsSel = document.getElementById("awsFamily");
  if (awsSel) {
    if (isWin && isArmSkuPattern("aws", awsSel.value)) awsSel.value = "";
    disableOptionsIfPresent(awsSel, ["t4g","c7g","m7g","r7g","a1","graviton"], isWin);
  }

  const azSel = document.getElementById("azFamily");
  if (azSel) {
    if (isWin && isArmSkuPattern("azure", azSel.value)) azSel.value = "";
    disableOptionsIfPresent(azSel, ["Dpsv5","Dpldsv5","Epsv5"], isWin);
  }

  const gcpSel = document.getElementById("gcpFamily");
  if (gcpSel) {
    if (isWin && isArmSkuPattern("gcp", gcpSel.value)) gcpSel.value = "";
    disableOptionsIfPresent(gcpSel, ["t2a","c4a","n4a","a4x"], isWin);
  }

  const ociProcEl = document.getElementById("ociProcessor");
  if (ociProcEl) {
    Array.from(ociProcEl.options).forEach(o => {
      if (o.value.toLowerCase() === "arm") o.disabled = isWin;
    });
    if (isWin && ociProcEl.value.toLowerCase() === "arm") {
      ociProcEl.value = "auto";
    }
  }
}

/* ============================================================
   OCI helpers
============================================================ */
function ociLatestGen(linux, processor) {
  if (!linux || !processor || processor === "auto") return null;
  const ORDER = {
    amd: ["E6","E5","E4","E3"],
    arm: ["A4","A2","A1"],
    intel:["Optimized3","Standard3"]
  };
  const arr = linux[processor] || [];
  if (!Array.isArray(arr) || arr.length === 0) return null;

  const gens = new Set(arr.map(e => String(e.gen||"").toLowerCase()));
  for (const g of ORDER[processor] || []) {
    if (gens.has(g.toLowerCase())) return g;
  }
  return arr
    .map(e => String(e.gen||""))
    .filter(Boolean)
    .sort((a,b)=>a.localeCompare(b))
    .pop() || null;
}

/* ============================================================
   MAIN compare()
============================================================ */
export async function compare(resetFamilies = false) {
  const btn = document.getElementById("compareBtn");
  if (btn) btn.disabled = true;

  setStatus("Fetching local prices…");

  if (resetFamilies) {
    ["awsFamily","azFamily","gcpFamily"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = "";
    });
    const ocip = document.getElementById("ociProcessor");
    if (ocip) ocip.value = "auto";
  }

  const os           = document.getElementById("os")?.value || "Linux";
  const vcpu         = Number(document.getElementById("cpu")?.value ?? 0);
  const ram          = Number(document.getElementById("ram")?.value ?? 0);
  const storageType  = (document.getElementById("storageType")?.value || "hdd").toLowerCase();
  const storageAmtGB = Number(document.getElementById("storageAmt")?.value ?? 0);

  const familyAws  = sanitizeFamilyForWindows("aws",   document.getElementById("awsFamily")?.value || "", os);
  const familyAz   = sanitizeFamilyForWindows("azure", document.getElementById("azFamily")?.value  || "", os);
  const familyGcp  = sanitizeFamilyForWindows("gcp",   document.getElementById("gcpFamily")?.value || "", os);

  const ociProcEl  = document.getElementById("ociProcessor");
  let ociProcessor = (ociProcEl?.value || "auto").toLowerCase();

  if (String(os).toLowerCase() === "windows") {
    const armOpt = ociProcEl?.querySelector('option[value="arm"]');
    if (armOpt) armOpt.disabled = true;
    if (ociProcessor === "arm") {
      ociProcessor = "auto";
      if (ociProcEl) ociProcEl.value = "auto";
    }
  }

  sanitizeFamiliesForWindows(os);

  try {
    resetCards();
    const data = await loadPricesAndMeta();

    /* ---------- Footer ---------- */
    try {
      const info = await loadBuildInfo();
      const counts = {
        az: Array.isArray(data.azure)?data.azure.length:0,
        aw: Array.isArray(data.aws)?data.aws.length:0,
        gc: Array.isArray(data.gcp)?data.gcp.length:0,
        oc: (() => {
          const l = data.oci?.linux || {};
          return (l.amd?.length||0)+(l.arm?.length||0)+(l.intel?.length||0);
        })()
      };
      const when = info?.generatedAt || "—";
      safeSetText("dataInfo", `Data: ${when} · Rows — Azure: ${counts.az}, AWS: ${counts.aw}, GCP: ${counts.gc}, OCI: ${counts.oc}`);
    } catch {
      safeSetText("dataInfo","Data: — · Rows — Azure: —, AWS: —, GCP: —, OCI: —");
    }

    /* ---------- Pre-filter Arm ---------- */
    const awsList = filterOutArmForWindows(data.aws   || [], "aws",   os);
    const azList  = filterOutArmForWindows(data.azure || [], "azure", os);
    const gcpList = filterOutArmForWindows(data.gcp   || [], "gcp",   os);

    /* ---------- AWS ---------- */
    let awsCard;
    try {
      const a = findBestAws(awsList, vcpu, ram, os, familyAws);
      awsCard = a ? { instance:a.instance, vcpu:a.vcpu, ram:a.ram, pricePerHourUSD:a.pricePerHourUSD, region:a.region } : null;
    } catch (e) { awsCard = { error:e.message }; }

    /* ---------- Azure ---------- */
    let azCard;
    try {
      const z = findBestAzure(azList, vcpu, ram, os, familyAz);
      azCard = z ? {
        instance:z.instance, vcpu:z.vcpu ?? vcpu, ram:z.ram ?? ram,
        pricePerHourUSD:z.pricePerHourUSD, region:z.region, os
      } : null;
    } catch (e) { azCard = { error:e.message }; }

    /* ---------- GCP ---------- */
    let gcpCard;
    try {
      const g = findBestGcp(gcpList, vcpu, ram, os, familyGcp);
      gcpCard = g ? { instance:g.instance, vcpu:g.vcpu, ram:g.ram, pricePerHourUSD:g.pricePerHourUSD, region:g.region } : null;
    } catch (e) { gcpCard = { error:e.message }; }

    /* ---------- OCI ---------- */
    let ociCard;
    try {
      const comp   = data.oci;
      const linux  = comp?.linux || {};
      const latest = (ociProcessor==="auto") ? null : ociLatestGen(linux, ociProcessor);
      const opts   = latest ? { processor:ociProcessor, generation:latest } : { processor:ociProcessor };
      const o      = findBestOci(comp, vcpu, ram, os, opts);
      ociCard      = o ? {
        instance:o.instance, vcpu:o.vcpu, ram:o.ram,
        pricePerHourUSD:o.pricePerHourUSD,
        region: STORAGE_CFG?.oci?.region || "—"
      } : null;
    } catch (e) { ociCard = { error:e.message }; }

    /* ---------- Storage labels ---------- */
    const sLabel = `${storageAmtGB} GB ${storageType.toUpperCase()}`;
    safeSetText("awsStorageSel", `Storage: ${sLabel}`);
    safeSetText("azStorageSel",  `Storage: ${sLabel}`);
    safeSetText("gcpStorageSel", `Storage: ${sLabel}`);
    safeSetText("ociStorageSel", `Storage: ${sLabel}`);

    /* ---------- Storage costs ---------- */
    const awsStorageMonthly = getAwsStorageMonthly(storageType, storageAmtGB);
    const awsStorageHr      = awsStorageMonthly / HRS_PER_MONTH;

    const { sku:azDiskSku, size:azDiskGB, monthlyUSD:azStorageMonthly } = getAzureStorage(storageType, storageAmtGB);
    const azStorageHr = azStorageMonthly / HRS_PER_MONTH;

    const gcpStorageMonthly = getGcpStorageMonthly(storageType, storageAmtGB);
    const gcpStorageHr      = gcpStorageMonthly / HRS_PER_MONTH;

    const ociStorageMonthly = getOciStorageMonthlyFromCfg(storageAmtGB, STORAGE_CFG.oci);
    const ociStorageHr      = ociStorageMonthly / HRS_PER_MONTH;

    /* ---------- Branded Storage Labels (set after costs computed) ---------- */
    safeSetText("awsStoragePriceHrLabel", `${STORAGE_LABELS.aws.hr}:`);
    safeSetText("awsStorageMonthlyLabel", `≈ ${STORAGE_LABELS.aws.monthly}:`);
    safeSetText("azStoragePriceHrLabel",  `${STORAGE_LABELS.azure.hr}:`);
    safeSetText("azStorageMonthlyLabel",  `≈ ${STORAGE_LABELS.azure.monthly}:`);
    safeSetText("gcpStoragePriceHrLabel", `${STORAGE_LABELS.gcp.hr}:`);
    safeSetText("gcpStorageMonthlyLabel", `≈ ${STORAGE_LABELS.gcp.monthly}:`);
    safeSetText("ociStoragePriceHrLabel", `${STORAGE_LABELS.oci.hr}:`);
    safeSetText("ociStorageMonthlyLabel", `≈ ${STORAGE_LABELS.oci.monthly}:`);

    /* ---------- Render AWS ---------- */
    if (!awsCard || awsCard.error) {
      safeSetText("awsInstance", `<strong>Recommended Instance:</strong> Error: ${awsCard?.error ?? "No match"}`, { html: true });
    } else {
      safeSetText("awsInstance", `<strong>Recommended Instance:</strong> ${awsCard.instance} (${awsCard.region})`, { html: true });
      safeSetText("awsCpu",     `vCPU: ${awsCard.vcpu}`);
      safeSetText("awsRam",     `RAM: ${awsCard.ram} GB`);
      safeSetText("awsPrice",   `${PROVIDER_LABELS.aws.price}: ${fmt(awsCard.pricePerHourUSD)}`);
      safeSetText("awsMonthly", `≈ ${PROVIDER_LABELS.aws.monthly}: ${fmt(monthly(awsCard.pricePerHourUSD))}`);
    }

    /* ---------- Render Azure ---------- */
    if (!azCard || azCard.error) {
      safeSetText("azInstance", `<strong>Recommended VM Size:</strong> Error: ${azCard?.error ?? "No match"}`, { html: true });
    } else {
      safeSetText("azInstance", `<strong>Recommended VM Size:</strong> ${azCard.instance} (${azCard.region})`, { html: true });
      safeSetText("azCpu",     `vCPU: ${azCard.vcpu}`);
      safeSetText("azRam",     `RAM: ${azCard.ram} GB`);
      safeSetText("azPrice",   `${PROVIDER_LABELS.azure.price}: ${fmt(azCard.pricePerHourUSD)}`);
      safeSetText("azMonthly", `≈ ${PROVIDER_LABELS.azure.monthly}: ${fmt(monthly(azCard.pricePerHourUSD))}`);
    }

    /* ---------- Render GCP ---------- */
    if (!gcpCard || gcpCard.error) {
      safeSetText("gcpInstance", `<strong>Recommended Machine:</strong> Error: ${gcpCard?.error ?? "No match"}`, { html: true });
    } else {
      safeSetText("gcpInstance", `<strong>Recommended Machine:</strong> ${gcpCard.instance} (${gcpCard.region})`, { html: true });
      safeSetText("gcpCpu",     `vCPU: ${gcpCard.vcpu}`);
      safeSetText("gcpRam",     `RAM: ${gcpCard.ram} GB`);
      safeSetText("gcpPrice",   `${PROVIDER_LABELS.gcp.price}: ${fmt(gcpCard.pricePerHourUSD)}`);
      safeSetText("gcpMonthly", `≈ ${PROVIDER_LABELS.gcp.monthly}: ${fmt(monthly(gcpCard.pricePerHourUSD))}`);
    }

    /* ---------- Render OCI ---------- */
    if (!ociCard || ociCard.error) {
      safeSetText("ociInstance", `<strong>Recommended Machine:</strong> Error: ${ociCard?.error ?? "No match"}`, { html: true });
    } else {
      safeSetText("ociInstance", `<strong>Recommended Machine:</strong> ${ociCard.instance} (${ociCard.region})`, { html: true });
      safeSetText("ociCpu",     `vCPU: ${ociCard.vcpu}`);
      safeSetText("ociRam",     `RAM: ${ociCard.ram} GB`);
      safeSetText("ociPrice",   `${PROVIDER_LABELS.oci.price}: ${fmt(ociCard.pricePerHourUSD)}`);
      safeSetText("ociMonthly", `≈ ${PROVIDER_LABELS.oci.monthly}: ${fmt(monthly(ociCard.pricePerHourUSD))}`);
    }

    /* ---------- Storage Cost Render ---------- */
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

    /* ---------- TOTAL COSTS ---------- */
    const awsTotalHr = sumSafe(awsCard?.pricePerHourUSD, awsStorageHr);
    const azTotalHr  = sumSafe(azCard?.pricePerHourUSD,  azStorageHr);
    const gcpTotalHr = sumSafe(gcpCard?.pricePerHourUSD, gcpStorageHr);
    const ociTotalHr = sumSafe(ociCard?.pricePerHourUSD, ociStorageHr);

    safeSetText("awsTotalHr",      fmt(awsTotalHr));
    safeSetText("awsTotalMonthly", fmt(sumSafe(monthly(awsCard?.pricePerHourUSD), awsStorageMonthly)));

    safeSetText("azTotalHr",       fmt(azTotalHr));
    safeSetText("azTotalMonthly",  fmt(sumSafe(monthly(azCard?.pricePerHourUSD), azStorageMonthly)));

    safeSetText("gcpTotalHr",      fmt(gcpTotalHr));
    safeSetText("gcpTotalMonthly", fmt(sumSafe(monthly(gcpCard?.pricePerHourUSD), gcpStorageMonthly)));

    safeSetText("ociTotalHr",      fmt(ociTotalHr));
    safeSetText("ociTotalMonthly", fmt(sumSafe(monthly(ociCard?.pricePerHourUSD), ociStorageMonthly)));

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
  // OS dropdown: visible label changed; value remains "Linux"
  fillSelect("os",   [
    { value: "Linux",   text: "Linux (Open‑source)" },
    { value: "Windows", text: "Windows" }
  ]);
  fillSelect("cpu",  [1,2,4,8,16].map(v => ({value:v, text:v})));
  fillSelect("ram",  [1,2,4,8,16,32].map(v => ({value:v, text:v})));

  setSelectValue("os","Linux");
  setSelectValue("cpu","2");
  setSelectValue("ram","4");

  const osEl = document.getElementById("os");
  if (osEl) osEl.addEventListener("change", () => sanitizeFamiliesForWindows(osEl.value));

  ["awsFamily","azFamily","gcpFamily","ociProcessor"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", () => compare(false));
  });

  initStorageTypeTooltip();
  initOsTypeTooltip();
  initOciTooltip();

  setStatus("Select inputs and click Compare");
  safeSetText("dataInfo","Loading…");
});
