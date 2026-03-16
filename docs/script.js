// docs/script.js (Optimized 4‑provider coordinator)
import {
  fmt, monthly, sumSafe, fillSelect, setSelectValue, safeSetText,
  appendToText, setStatus, resetCards,
  HRS_PER_MONTH,
  getAwsStorageMonthlyFromCfg,
  getAzureStorageSkuAndMonthlyFromCfg,
  getGcpStorageMonthlyFromCfg,
  getOciStorageMonthlyFromCfg,
  ensureSelectOption
} from "./ui/utils.js";
import { STORAGE_CFG, loadPricesAndMeta } from "./ui/state.js";
import { initStorageTypeTooltip, initOsTypeTooltip, initOciTooltip } from "./ui/tooltips.js";
import { findBestAws, findBestAzure, findBestGcp, findBestOci } from "./ui/matchers.js";

/* --- Configuration Maps --- */
const PROVIDER_LABELS = {
  aws:   { price: 'EC2 Price/hr',             monthly: 'EC2 Monthly' },
  azure: { price: 'VM Price/hr',              monthly: 'VM Monthly' },
  gcp:   { price: 'Compute Engine Price/hr', monthly: 'Compute Engine Monthly' },
  oci:   { price: 'Compute Price/hr',         monthly: 'Compute Monthly' }
};

const STORAGE_LABELS = {
  aws:   { hr: 'EBS Price/hr',                monthly: 'EBS Monthly' },
  azure: { hr: 'Azure Disk Price/hr',       monthly: 'Azure Disk Monthly' },
  gcp:   { hr: 'Persistent Disk Price/hr',  monthly: 'Persistent Disk Monthly' },
  oci:   { hr: 'Block Volume Price/hr',     monthly: 'Block Volume Monthly' },
};

/* --- Helpers --- */
async function loadBuildInfo() {
  try {
    const r = await fetch('./data/buildInfo.json?v=' + Date.now(), { cache: 'no-store' });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

function showFamilyFilters() {
  ["awsFamilyWrap", "azFamilyWrap", "gcpFamilyWrap", "ociProcessorWrap"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = "flex";
  });
}

function isArmEntry(provider, entry) {
  const arch = String(entry?.arch || entry?.cpuArch || entry?.architecture || "").toLowerCase();
  const isArmArch = arch.includes("arm") || arch.includes("aarch64") || arch.includes("ampere");
  
  const label = String(entry?.instance || entry?.family || entry?.series || entry?.size || "").toLowerCase();
  const patterns = {
    aws: /(t4g|a1|c\d+g|m\d+g|r\d+g)\b|graviton/,
    azure: /\b(dpsv5|dpldsv5|epsv5)\b/,
    gcp: /\b(t2a|c4a|n4a|a4x)\b/,
    oci: /\.a1\b|\.a2\b|ampere|arm/
  };
  
  return isArmArch || (patterns[provider] && patterns[provider].test(label));
}

function filterOutArmForWindows(list, provider, os) {
  if (String(os).toLowerCase() !== "windows") return list ?? [];
  const filtered = (list ?? []).filter(x => !isArmEntry(provider, x));
  return filtered.length > 0 ? filtered : list;
}

function sanitizeFamiliesForWindows(os) {
  const isWin = String(os).toLowerCase() === "windows";
  const configs = [
    { id: "awsFamily", keys: ["t4g","c7g","m7g","r7g","a1","graviton"], prov: "aws" },
    { id: "azFamily",  keys: ["Dpsv5","Dpldsv5","Epsv5"], prov: "azure" },
    { id: "gcpFamily", keys: ["t2a","c4a","n4a","a4x"], prov: "gcp" }
  ];

  configs.forEach(({id, keys, prov}) => {
    const sel = document.getElementById(id);
    if (!sel) return;
    if (isWin && isArmEntry(prov, { family: sel.value })) sel.value = "";
    Array.from(sel.options).forEach(o => {
      if (keys.some(k => o.value.toLowerCase().includes(k.toLowerCase()))) o.disabled = isWin;
    });
  });

  const ociProc = document.getElementById("ociProcessor");
  if (ociProc) {
    Array.from(ociProc.options).forEach(o => { if (o.value === "arm") o.disabled = isWin; });
    if (isWin && ociProc.value === "arm") ociProc.value = "auto";
  }
}

function ociLatestGen(linux, processor) {
  if (!linux || !processor || processor === "auto") return null;
  const ORDER = { amd: ["E6","E5","E4","E3"], arm: ["A4","A2","A1"], intel:["Optimized3","Standard3"] };
  const arr = linux[processor] ?? [];
  const gens = new Set(arr.map(e => String(e.gen ?? "").toLowerCase()));
  for (const g of ORDER[processor] ?? []) { if (gens.has(g.toLowerCase())) return g; }
  return arr.map(e => String(e.gen ?? "")).filter(Boolean).sort().pop() ?? null;
}

/* --- UI Component Updater --- */
function updateProviderUI(prefix, providerKey, card, storageHr, storageMonthly) {
  const labels = PROVIDER_LABELS[providerKey];
  const sLabels = STORAGE_LABELS[providerKey];

  if (!card || card.error || card.disabled) {
    const msg = card?.disabled ? "—" : `Error: ${card?.error ?? "No match"}`;
    safeSetText(`${prefix}Instance`, `<strong>Recommended:</strong> ${msg}`, { html: true });
    safeSetText(`${prefix}Cpu`, `vCPU: —`);
    safeSetText(`${prefix}Ram`, `RAM: —`);
    safeSetText(`${prefix}Price`, `${labels.price}: —`);
    safeSetText(`${prefix}Monthly`, `≈ ${labels.monthly}: —`);
    safeSetText(`${prefix}TotalHr`, fmt(null));
    safeSetText(`${prefix}TotalMonthly`, fmt(null));
  } else {
    const instanceLabel = card.displayInstance ?? card.instance;
    const badge = card.seriesName ? ` <span class="badge-series">${card.seriesName}</span>` : "";
    safeSetText(`${prefix}Instance`, `<strong>Recommended:</strong> ${instanceLabel} (${card.region})${badge}`, { html: true });
    safeSetText(`${prefix}Cpu`, `vCPU: ${card.vcpu}`);
    safeSetText(`${prefix}Ram`, `RAM: ${card.ram} GB`);
    safeSetText(`${prefix}Price`, `${labels.price}: ${fmt(card.pricePerHourUSD)}`);
    safeSetText(`${prefix}Monthly`, `≈ ${labels.monthly}: ${fmt(monthly(card.pricePerHourUSD))}`);
    
    safeSetText(`${prefix}TotalHr`, fmt(sumSafe(card.pricePerHourUSD, storageHr)));
    safeSetText(`${prefix}TotalMonthly`, fmt(sumSafe(monthly(card.pricePerHourUSD), storageMonthly)));
  }

  // Update Storage Labels
  safeSetText(`${prefix}StoragePriceHrLabel`, `${sLabels.hr}:`);
  safeSetText(`${prefix}StorageMonthlyLabel`, `≈ ${sLabels.monthly}:`);
  safeSetText(`${prefix}StoragePriceHr`, fmt(storageHr));
  safeSetText(`${prefix}StorageMonthly`, fmt(storageMonthly));
}

async function hydrateControlsFromMeta() {
  try {
    const { meta } = await loadPricesAndMeta();
    const osData = (meta?.os ?? ["Linux", "RHEL", "Windows"]).map(v => {
      const s = typeof v === "string" ? v : v?.value;
      const textMap = { "Linux": "Linux (Open‑source)", "RHEL": "RHEL (Enterprise)", "Windows": "Windows" };
      return { value: s, text: textMap[s] || s };
    });
    fillSelect("os", osData);
    ensureSelectOption("os", "RHEL", "RHEL (Enterprise)");
    
    const vcpus = meta?.vcpu ?? [1,2,4,8,16];
    const rams  = meta?.ram ?? [1,2,4,8,16,32];
    fillSelect("cpu", vcpus.map(v => ({ value: v, text: v })));
    fillSelect("ram", rams.map(v => ({ value: v, text: v })));
    setSelectValue("os", "Linux");
    setSelectValue("cpu", "2");
    setSelectValue("ram", "4");
  } catch (e) { console.error("Hydration failed", e); }
}

/* --- PDF Export --- */
async function downloadResultsAsPdf() {
  const { jsPDF } = window.jspdf || {};
  if (typeof window.html2canvas !== "function" || !jsPDF) return alert("PDF libraries not loaded.");

  const grid = document.querySelector(".results");
  if (!grid) return alert("Run compare first.");

  const wrapper = document.createElement("div");
  Object.assign(wrapper.style, { padding: "16px", background: "#fff", position: "fixed", left: "-10000px", width: `${grid.offsetWidth}px` });

  const title = document.querySelector("h2.app-title")?.textContent || "Cloud Cost Comparison";
  const header = document.createElement("h2");
  header.textContent = title;
  Object.assign(header.style, { margin: "0 0 12px", fontFamily: "sans-serif", color: "#111" });
  wrapper.appendChild(header);

  const clone = grid.cloneNode(true);
  
  // Snapshot Selects
  clone.querySelectorAll("select").forEach(sel => {
    const span = document.createElement("span");
    span.className = "cc-select-snapshot";
    span.textContent = sel.options[sel.selectedIndex]?.text || sel.value;
    Object.assign(span.style, {
      display: "inline-block", minWidth: "120px", height: "30px", lineHeight: "28px",
      padding: "0 8px", border: "1px solid #999", borderRadius: "4px", fontSize: "12px"
    });
    sel.replaceWith(span);
  });

  wrapper.appendChild(clone);
  
  const style = document.createElement("style");
  style.textContent = `
    .results, .results * { background: transparent !important; box-shadow: none !important; }
    .family-filter, .panel .label-with-info { display: flex !important; align-items: center !important; gap: 8px !important; margin: 6px 0 !important; }
    .family-filter label, .panel .label-with-info label { flex: 0 0 80px !important; font-weight: 700 !important; }
  `;
  wrapper.appendChild(style);
  document.body.appendChild(wrapper);

  const canvas = await html2canvas(wrapper, { scale: 2, useCORS: true });
  const imgData = canvas.toDataURL("image/png");
  const pdf = new jsPDF("p", "pt", "a4");
  const imgW = pdf.internal.pageSize.getWidth() - 48;
  const imgH = (canvas.height * imgW) / canvas.width;

  pdf.addImage(imgData, "PNG", 24, 24, imgW, imgH);
  pdf.save(`cloud-compare-${new Date().getTime()}.pdf`);
  document.body.removeChild(wrapper);
}

/* --- Main Logic --- */
export async function compare(resetFamilies = false) {
  const elements = {
    btn: document.getElementById("compareBtn"),
    dlBtn: document.getElementById("downloadPdfBtn"),
    os: document.getElementById("os")?.value || "Linux",
    cpu: Number(document.getElementById("cpu")?.value || 0),
    ram: Number(document.getElementById("ram")?.value || 0),
    stType: (document.getElementById("storageType")?.value || "hdd").toLowerCase(),
    stAmt: Number(document.getElementById("storageAmt")?.value || 0)
  };

  if (elements.btn) elements.btn.disabled = true;
  if (elements.dlBtn) elements.dlBtn.disabled = true;
  setStatus("Fetching prices...");

  if (resetFamilies) {
    ["awsFamily","azFamily","gcpFamily"].forEach(id => { if(document.getElementById(id)) document.getElementById(id).value = ""; });
    if (document.getElementById("ociProcessor")) document.getElementById("ociProcessor").value = "auto";
  }

  sanitizeFamiliesForWindows(elements.os);

  try {
    resetCards();
    const { aws, azure, gcp, oci } = await loadPricesAndMeta();

    // Matching
    const awsMatch = findBestAws(filterOutArmForWindows(aws, "aws", elements.os), elements.cpu, elements.ram, elements.os, document.getElementById("awsFamily")?.value);
    const azMatch  = findBestAzure(filterOutArmForWindows(azure, "azure", elements.os), elements.cpu, elements.ram, elements.os, document.getElementById("azFamily")?.value);
    const gcpMatch = findBestGcp(filterOutArmForWindows(gcp, "gcp", elements.os), elements.cpu, elements.ram, elements.os, document.getElementById("gcpFamily")?.value);
    
    let ociMatch;
    if (elements.os.toLowerCase() === "rhel") {
      ociMatch = { disabled: true, message: "OCI: Use BYOL for RHEL." };
    } else {
      const proc = document.getElementById("ociProcessor")?.value || "auto";
      const gen = ociLatestGen(oci?.linux, proc);
      ociMatch = findBestOci(oci, elements.cpu, elements.ram, elements.os, { processor: proc, generation: gen });
    }

    // Storage Calculations
    const stLabel = `Storage: ${elements.stAmt} GB ${elements.stType.toUpperCase()}`;
    ["aws","az","gcp","oci"].forEach(p => safeSetText(`${p}StorageSel`, stLabel));

    const awsStM = getAwsStorageMonthly(elements.stType, elements.stAmt);
    const azSt = getAzureStorage(elements.stType, elements.stAmt);
    const gcpStM = getGcpStorageMonthly(elements.stType, elements.stAmt);
    const ociStM = ociMatch?.disabled ? 0 : getOciStorageMonthlyFromCfg(elements.stAmt, STORAGE_CFG.oci);

    // UI Updates
    updateProviderUI("aws", "aws", awsMatch, awsStM/HRS_PER_MONTH, awsStM);
    updateProviderUI("az",  "azure", azMatch, azSt.monthlyUSD/HRS_PER_MONTH, azSt.monthlyUSD);
    updateProviderUI("gcp", "gcp", gcpMatch, gcpStM/HRS_PER_MONTH, gcpStM);
    updateProviderUI("oci", "oci", ociMatch, ociStM/HRS_PER_MONTH, ociStM);

    if (azSt.sku) appendToText("azStorageSel", ` (${azSt.sku})`);
    
    showFamilyFilters();
    setStatus("Comparison complete ✓");
    if (elements.dlBtn) elements.dlBtn.disabled = false;
  } catch (err) {
    console.error(err);
    setStatus("Error loading data", "error");
  } finally {
    if (elements.btn) elements.btn.disabled = false;
  }
}

// OCI specific storage helper used in compare
function getAwsStorageMonthly(t, g) { return getAwsStorageMonthlyFromCfg(t, g, STORAGE_CFG.aws); }
function getAzureStorage(t, g) { return getAzureStorageSkuAndMonthlyFromCfg(t, g, STORAGE_CFG.azure); }
function getGcpStorageMonthly(t, g) { return getGcpStorageMonthlyFromCfg(t, g, STORAGE_CFG.gcp); }

/* --- Bootstrap --- */
async function bootstrap() {
  await hydrateControlsFromMeta();
  const inputs = ["os", "cpu", "ram", "storageType", "storageAmt", "awsFamily", "azFamily", "gcpFamily", "ociProcessor"];
  inputs.forEach(id => document.getElementById(id)?.addEventListener("change", () => {
    if (["awsFamily", "azFamily", "gcpFamily", "ociProcessor"].includes(id)) compare(false);
    else if (document.getElementById("downloadPdfBtn")) document.getElementById("downloadPdfBtn").disabled = true;
  }));

  document.getElementById("compareBtn")?.addEventListener("click", () => compare(true));
  document.getElementById("downloadPdfBtn")?.addEventListener("click", downloadResultsAsPdf);
  
  initStorageTypeTooltip();
  initOsTypeTooltip();
  initOciTooltip();
  setStatus("Ready");
}

document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", bootstrap) : bootstrap();
