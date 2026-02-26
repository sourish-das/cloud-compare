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
 * Returns { os: "Windows"|"Linux", isPaidLinux, hasSql, isDevTest }
 */
function getRetailOsInfo({ productName = "", skuName = "", meterName = "" } = {}) {
  const s = _blob(productName, skuName, meterName);

  const isWindows = /windows/.test(s);
  const hasSql = /sql\s*(server|enterprise|standard|web)/.test(s);
  const isDevTest = /(dev\/?test|msdn)/.test(s);

  // Paid Linux signals (we compare only free Linux distros)
  const isPaidLinux = /(rhel|red\s*hat|suse|sles|oracle\s*linux|ubuntu\s*pro)/.test(s);

  const os = isWindows ? "Windows" : "Linux";
  return { os, isPaidLinux, hasSql, isDevTest };
}

/** Windows eligibility: license-included, no SQL, no Dev/Test. */
function isWindowsRetailEligible(item) {
  const { os, hasSql, isDevTest } = getRetailOsInfo(item);
  if (os !== "Windows") return false;
  if (hasSql) return false;
  if (isDevTest) return false;
  return true;
}

/** Linux eligibility: free distros only (no RHEL/SLES/Ubuntu Pro) and no Dev/Test. */
function isLinuxRetailEligible(item) {
  const { os, isPaidLinux, isDevTest } = getRetailOsInfo(item);
  if (os !== "Linux") return false;
  if (isPaidLinux) return false;
  if (isDevTest) return false;
  return true;
}

/**
 * Extract hourly USD price from Retail item.
 * Defensively ignore entries whose unit isn't hourly.
 */
function extractRetailHourlyUSD({ retailPrice, unitOfMeasure } = {}) {
  const n = Number(retailPrice);
  if (!Number.isFinite(n) || n <= 0) return null;

  const u = String(unitOfMeasure || "").toLowerCase();
  if (u && !(u.startsWith("1 hour") || u.startsWith("hour"))) return null;
  return n;
}

/** (Legacy) detect OS from product name. Prefer getRetailOsInfo for new code. */
function detectOsFromProductName(productName = "") {
  return /windows/i.test(productName) ? "Windows" : "Linux";
}

/** Simple family tag by first letter (D=general, E=memory, F=compute, else other). */
function categorizeByInstanceName(instance = "") {
  const n = String(instance).toLowerCase();
  const body = n.startsWith("standard_") ? n.slice(9) : n;
  const lead = body[0];
  return lead === "d" ? "general"
       : lead === "e" ? "memory"
       : lead === "f" ? "compute"
       : "other";
}

/** Azure ARM instance detector (block when OS=Windows). */
function isAzureArmInstance(instance = "") {
  const n = String(instance || "").toLowerCase();
  // Bpsv2 (Standard_B2pls_v2), Dpsv5, Epsv5 are ARM (Ampere)
  return /standard_b.*psv2|standard_dpsv5|standard_epsv5/.test(n);
}

/** Normalize instance names: "D2s v5" -> "standard_d2s_v5". */
function normalizeAzureInstanceName(name = "") {
  const raw = String(name || "").trim();
  if (!raw) return "";
  let s = raw.toLowerCase().replace(/\s+/g, "_");
  if (!/^standard_/.test(s)) s = `standard_${s}`;
  return s;
}

/** Convenience: prefer armSkuName; else the full skuName (do NOT split). */
function fullInstanceFromRetail(it = {}) {
  const instRaw = it.armSkuName || it.skuName || "";
  return normalizeAzureInstanceName(instRaw);
}

/** Convenience: true if this is a primary, On‑Demand VM compute meter. */
function isPrimaryOnDemandRetailItem(it = {}) {
  // type === "Consumption" is already enforced in the fetcher's $filter,
  // but checking again is cheap and safe.
  const typeOk = String(it.type || "").toLowerCase() === "consumption";
  const primary = it?.isPrimaryMeterRegion === true;
  return typeOk && primary;
}

/**
 * Build a name->{vcpu,ram} map from ResourceSkus for a given subscription & region.
 */
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

/** Widen series: allow major VM families we care about. */
function widenAzureSeries(instance) {
  const n = String(instance).toLowerCase();
  const body = n.startsWith("standard_") ? n.slice(9) : n;
  const lead = (body[0] || "").toUpperCase();
  return ["A","B","D","E","F","L","M","N"].includes(lead);
}

module.exports = {
  // OS & retail classifiers
  getRetailOsInfo,
  isWindowsRetailEligible,
  isLinuxRetailEligible,
  extractRetailHourlyUSD,

  // Legacy + family helpers
  detectOsFromProductName,
  categorizeByInstanceName,
  widenAzureSeries,

  // ARM & names
  isAzureArmInstance,
  normalizeAzureInstanceName,
  fullInstanceFromRetail,

  // Primary On‑Demand helper
  isPrimaryOnDemandRetailItem,

  // ResourceSkus
  getResourceSkusMap
};
