// docs/script.js (Clean Slate Version - No URL Persistence)
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

function isArmEntry(provider, entry) {
  const label = String(entry?.instance || entry?.family || entry?.series || "").toLowerCase();
  const patterns = {
    aws: /(t4g|a1|c\d+g|m\d+g|r\d+g)\b|graviton/,
    azure: /\b(dpsv5|dpldsv5|epsv5)\b/,
    gcp: /\b(t2a|c4a|n4a|a4x)\b/,
    oci: /\.a1\b|\.a2\b|ampere|arm/
  };
  return (patterns[provider] && patterns[provider].test(label));
}

function sanitizeFamiliesForWindows(os) {
  const isWin = String(os).toLowerCase() === "windows";
  const selects = ["awsFamily", "azFamily", "gcpFamily"];
  selects.forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    Array.from(sel.options).forEach(o => {
      const isArm = ["t4g","c7g","m7g","r7g","a1","graviton","Dpsv5","t2a","c4a"].some(k => o.value.toLowerCase().includes(k.toLowerCase()));
      o.disabled = isWin && isArm;
    });
    if (isWin && sel.value && isArmEntry(id.replace("Family","").toLowerCase(), { instance: sel.value })) sel.value = "";
  });
  const ociProc = document.getElementById("ociProcessor");
  if (ociProc) {
    Array.from(ociProc.options).forEach(o => { if (o.value.toLowerCase() === "arm") o.disabled = isWin; });
    if (isWin && ociProc.value.toLowerCase() === "arm") ociProc.value = "auto";
  }
}

/* --- UI Component Updater --- */
function updateProviderUI(prefix, providerKey, card, storageHr, storageMonthly) {
  const labels = PROVIDER_LABELS[providerKey];
  const sLabels = STORAGE_LABELS[providerKey];
  
  if (providerKey === 'oci') {
    const panel = document.querySelector(".panel--oci");
    const notice = document.getElementById("ociRhelNotice");
    if (card?.disabled) {
      panel?.classList.add("panel--disabled");
      if (notice) { notice.hidden = false; notice.textContent = card.message; }
    } else {
      panel?.classList.remove("panel--disabled");
      if (notice) notice.hidden = true;
    }
  }

  if (!card || card.error || card.disabled) {
    safeSetText(`${prefix}Instance`, `<strong>Recommended:</strong> —`, { html: true });
    ["Cpu", "Ram", "Price", "Monthly", "TotalHr", "TotalMonthly", "StoragePriceHr", "StorageMonthly"].forEach(id => safeSetText(`${prefix}${id}`, "—"));
  } else {
    const badge = card.seriesName ? ` <span class="badge-series">${card.seriesName}</span>` : "";
    safeSetText(`${prefix}Instance`, `<strong>Recommended:</strong> ${card.displayInstance || card.instance} (${card.region})${badge}`, { html: true });
    ["Cpu", "Ram"].forEach(s => safeSetText(`${prefix}${s}`, `${s}: ${card[s.toLowerCase()]}`));
    safeSetText(`${prefix}Price`, `${labels.price}: ${fmt(card.pricePerHourUSD)}`);
    safeSetText(`${prefix}Monthly`, `≈ ${labels.monthly}: ${fmt(monthly(card.pricePerHourUSD))}`);
    safeSetText(`${prefix}TotalHr`, fmt(sumSafe(card.pricePerHourUSD, storageHr)));
    safeSetText(`${prefix}TotalMonthly`, fmt(sumSafe(monthly(card.pricePerHourUSD), storageMonthly)));
    safeSetText(`${prefix}StoragePriceHr`, fmt(storageHr));
    safeSetText(`${prefix}StorageMonthly`, fmt(storageMonthly));
  }
  safeSetText(`${prefix}StoragePriceHrLabel`, `${sLabels.hr}:`);
  safeSetText(`${prefix}StorageMonthlyLabel`, `≈ ${sLabels.monthly}:`);
}

/* --- Main Logic --- */
export async function compare(resetFamilies = false) {
  const btn = document.getElementById("compareBtn");
  const os = document.getElementById("os")?.value || "Linux";
  if (btn) btn.disabled = true;
  
  if (resetFamilies) {
    ["awsFamily","azFamily","gcpFamily"].forEach(id => { if(document.getElementById(id)) document.getElementById(id).value = ""; });
    if (document.getElementById("ociProcessor")) document.getElementById("ociProcessor").value = "auto";
  }
  
  sanitizeFamiliesForWindows(os);

  try {
    resetCards();
    const data = await loadPricesAndMeta();
    const info = await loadBuildInfo();
    if (info) safeSetText("dataInfo", `Data: ${info.generatedAt} · Row Count: ${data.aws.length + data.azure.length + data.gcp.length}`);

    const cpu = Number(document.getElementById("cpu").value);
    const ram = Number(document.getElementById("ram").value);
    const stT = document.getElementById("storageType").value.toLowerCase();
    const stG = Number(document.getElementById("storageAmt").value);

    // Matching with OS Filters
    const awsM = findBestAws((os === "Windows" ? data.aws.filter(x => !isArmEntry("aws", x)) : data.aws), cpu, ram, os, document.getElementById("awsFamily")?.value);
    const azM  = findBestAzure((os === "Windows" ? data.azure.filter(x => !isArmEntry("azure", x)) : data.azure), cpu, ram, os, document.getElementById("azFamily")?.value);
    const gcpM = findBestGcp((os === "Windows" ? data.gcp.filter(x => !isArmEntry("gcp", x)) : data.gcp), cpu, ram, os, document.getElementById("gcpFamily")?.value);
    
    let ociM = os === "RHEL" ? { disabled: true, message: "OCI RHEL images require BYOL." } : 
               findBestOci(data.oci, cpu, ram, os, { processor: document.getElementById("ociProcessor")?.value || "auto" });

    // Storage logic
    const awsS = getAwsStorageMonthlyFromCfg(stT, stG, STORAGE_CFG.aws);
    const azS  = getAzureStorageSkuAndMonthlyFromCfg(stT, stG, STORAGE_CFG.azure);
    const gcpS = getGcpStorageMonthlyFromCfg(stT, stG, STORAGE_CFG.gcp);
    const ociS = ociM?.disabled ? 0 : getOciStorageMonthlyFromCfg(stG, STORAGE_CFG.oci);

    updateProviderUI("aws", "aws", awsM, awsS/HRS_PER_MONTH, awsS);
    updateProviderUI("az",  "azure", azM, azS.monthlyUSD/HRS_PER_MONTH, azS.monthlyUSD);
    updateProviderUI("gcp", "gcp", gcpM, gcpS/HRS_PER_MONTH, gcpS);
    updateProviderUI("oci", "oci", ociM, ociS/HRS_PER_MONTH, ociS);

    if (azS.sku) appendToText("azStorageSel", ` (${azS.sku})`);
    setStatus("Done ✓");
  } catch (e) { setStatus("Error", "error"); }
  if (btn) btn.disabled = false;
}

async function bootstrap() {
  const { meta } = await loadPricesAndMeta();
  fillSelect("os", (meta?.os || ["Linux", "RHEL", "Windows"]).map(v => ({ value: v, text: v })));
  fillSelect("cpu", (meta?.vcpu || [2,4,8]).map(v => ({ value: v, text: v })));
  fillSelect("ram", (meta?.ram || [4,8,16]).map(v => ({ value: v, text: v })));
  
  setSelectValue("os", "Linux"); // Force default state on refresh
  setSelectValue("cpu", "2");
  setSelectValue("ram", "4");

  document.querySelectorAll("select").forEach(s => s.addEventListener("change", () => compare(false)));
  document.getElementById("compareBtn")?.addEventListener("click", () => compare(true));
  
  initStorageTypeTooltip(); initOsTypeTooltip(); initOciTooltip();
}

bootstrap();
