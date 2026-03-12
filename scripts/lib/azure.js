// scripts/lib/azure.js
// Helpers for Azure Retail Prices + ResourceSkus enrichment

/**
 * Build a unified lowercase blob from the main retail fields for string tests.
 */
function _blob(productName = "", skuName = "", meterName = "") {
  return `${productName} ${skuName} ${meterName}`.toLowerCase().trim();
}

/**
 * Classify the OS and flags from a Retail Prices item.
 * Returns { os: "Windows"|"Linux", isPaidLinux, hasSql, isDevTest, isByol, hasPreinstalled }
 */
function getRetailOsInfo({ productName = "", skuName = "", meterName = "" } = {}) {
  const s = _blob(productName, skuName, meterName);

  const isWindows = /windows/.test(s);
  const hasSql = /sql\s*(server|enterprise|standard|web)/.test(s);
  const isDevTest = /(dev\/?test|msdn)/.test(s);
  const isByol = /(byol|hybrid\s*benefit|ahb)/.test(s);
  const isPaidLinux = /(rhel|red\s*hat|suse|sles|oracle\s*linux|ubuntu\s*pro)/.test(s);
  const hasPreinstalled =
    /(sap|sql|mssql|oracle|weblogic|jboss|tomcat|datastax|cloudera|hadoop|mongodb)/.test(s);

  const os = isWindows ? "Windows" : "Linux";
  return { os, isPaidLinux, hasSql, isDevTest, isByol, hasPreinstalled };
}

/** Windows eligibility */
function isWindowsRetailEligible(item) {
  const { os, hasSql, isDevTest, isByol, hasPreinstalled } = getRetailOsInfo(item);
  return os === "Windows" && !hasSql && !isDevTest && !isByol && !hasPreinstalled;
}

/** Linux eligibility */
function isLinuxRetailEligible(item) {
  const { os, isPaidLinux, isDevTest } = getRetailOsInfo(item);
  return os === "Linux" && !isPaidLinux && !isDevTest;
}

/** Plain RHEL PAYG compute detector */
function isPlainAzureRhel(item = {}) {
  const meter = String(item.meterName || "").toLowerCase();
  if (meter !== "rhel") return false;

  const sku  = String(item.skuName || "").toLowerCase();
  const prod = String(item.productName || "").toLowerCase();
  const blob = `${prod} ${sku}`;

  if (/(sap|sql|ha|byos|ahub|hybrid\s*benefit)/.test(blob)) return false;
  if (!/virtual machines?/.test(prod)) return false;

  return true;
}

/** Extract hourly USD price */
function extractRetailHourlyUSD({ retailPrice, unitOfMeasure } = {}) {
  const n = Number(retailPrice);
  if (!Number.isFinite(n) || n <= 0) return null;
  const u = String(unitOfMeasure || "").toLowerCase();
  if (u && !(u.startsWith("1 hour") || u.startsWith("hour"))) return null;
  return n;
}

/** Legacy OS detection */
function detectOsFromProductName(productName = "") {
  return /windows/i.test(productName) ? "Windows" : "Linux";
}

/** Categorize instance family */
function categorizeByInstanceName(instance = "") {
  const n = String(instance).toLowerCase();
  const body = n.startsWith("standard_") ? n.slice(9) : n;
  const lead = body[0];
  return lead === "d" ? "general"
       : lead === "e" ? "memory"
       : lead === "f" ? "compute"
       : "other";
}

/** Azure ARM instance detector (Ampere families) */
function isAzureArmInstance(instance = "") {
  const n = String(instance || "").toLowerCase();
  return /standard_b.*psv2|standard_dpsv5|standard_dpldsv5|standard_epsv5/.test(n);
}

/** Detect burstable B-series */
function isBurstableAzure(instance = "") {
  const n = String(instance || "").toLowerCase();
  return /^standard_b/.test(n);
}

/** Normalize instance names */
function normalizeAzureInstanceName(name = "") {
  const raw = String(name || "").trim();
  if (!raw) return "";
  let s = raw.toLowerCase().replace(/\s+/g, "_");
  if (!/^standard_/.test(s)) s = `standard_${s}`;
  return s;
}

/** Prefer armSkuName else skuName */
function fullInstanceFromRetail(it = {}) {
  const instRaw = it.armSkuName || it.skuName || "";
  return normalizeAzureInstanceName(instRaw);
}

/** Primary On‑Demand VM compute meter */
function isPrimaryOnDemandRetailItem(it = {}) {
  const typeOk = String(it.type || "").toLowerCase() === "consumption";
  const primary = it?.isPrimaryMeterRegion === true;
  return typeOk && primary;
}

/** Build ResourceSkus map */
async function getResourceSkusMap({ subscriptionId, region, armToken }) {
  const map = new Map();
  let next =
    `https://management.azure.com/subscriptions/${subscriptionId}` +
    `/providers/Microsoft.Compute/skus?api-version=2021-07-01&$filter=location eq '${region}'`;

  let pages = 0, MAX = 80;
  while (next && pages < MAX) {
    const res = await fetch(next, { headers: { Authorization: `Bearer ${armToken}` } });
    if (!res.ok) {
      console.warn(`[Azure] ResourceSkus HTTP ${res.status}`);
      break;
    }
    const j = await res.json();
    for (const sku of (j.value || [])) {
      if (sku.resourceType !== "virtualMachines") continue;
      const caps = Object.fromEntries((sku.capabilities || []).map(x => [x.name, x.value]));
      const v = caps.vCPUs ? Number(caps.vCPUs) : null;
      const m = caps.MemoryGB ? Number(caps.MemoryGB) : null;
      if (v || m) {
        map.set(String(sku.name).toLowerCase(), { vcpu: v, ram: m });
      }
    }
    next = j.nextLink || null;
    pages++;
  }
  console.log(`[Azure] ResourceSkus entries: ${map.size}`);
  return map;
}

/** Widen series */
function widenAzureSeries(instance = "") {
  const n = String(instance).toLowerCase();
  const body = n.startsWith("standard_") ? n.slice(9) : n;
  const lead = (body[0] || "").toUpperCase();
  return ["A","B","D","E","F","L","M","N","H"].includes(lead);
}

module.exports = {
  // OS & retail classifiers
  getRetailOsInfo,
  isWindowsRetailEligible,
  isLinuxRetailEligible,
  extractRetailHourlyUSD,
  isPlainAzureRhel,

  // Legacy + family helpers
  detectOsFromProductName,
  categorizeByInstanceName,
  widenAzureSeries,

  // ARM & names
  isAzureArmInstance,
  isBurstableAzure,
  normalizeAzureInstanceName,
  fullInstanceFromRetail,

  // Primary On‑Demand helper
  isPrimaryOnDemandRetailItem,

  // ResourceSkus
  getResourceSkusMap
};
