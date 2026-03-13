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
 *
 * Notes:
 *  - We only want plain Windows Server (license included), no SQL, no Dev/Test.
 *  - For Linux we only want "free" distros (exclude RHEL/SLES/Ubuntu Pro/Oracle Linux).
 */
function getRetailOsInfo({ productName = "", skuName = "", meterName = "" } = {}) {
  const s = _blob(productName, skuName, meterName);

  const isWindows = /windows/.test(s);

  // SQL signals
  const hasSql = /sql\s*(server|enterprise|standard|web)/.test(s);

  // Dev/Test (non-production) signals
  const isDevTest = /(dev\/?test|msdn)/.test(s);

  // BYOL signals (Azure sometimes marks BYOL or Hybrid Benefit via name)
  const isByol = /(byol|hybrid\s*benefit|ahb)/.test(s);

  // Paid Linux signals (compare only free Linux distros)
  const isPaidLinux = /(rhel|red\s*hat|suse|sles|oracle\s*linux|ubuntu\s*pro)/.test(s);

  // Preinstalled software (we want plain Windows Server only)
  const hasPreinstalled =
    /(sap|sql|mssql|oracle|weblogic|jboss|tomcat|datastax|cloudera|hadoop|mongodb)/.test(s);

  const os = isWindows ? "Windows" : "Linux";
  return { os, isPaidLinux, hasSql, isDevTest, isByol, hasPreinstalled };
}

/** Windows eligibility: license-included, no SQL, no Dev/Test, no BYOL, no preinstalled images. */
function isWindowsRetailEligible(item) {
  const { os, hasSql, isDevTest, isByol, hasPreinstalled } = getRetailOsInfo(item);
  if (os !== "Windows") return false;
  if (hasSql) return false;
  if (isDevTest) return false;
  if (isByol) return false;
  if (hasPreinstalled) return false;
  return true;
}

/** Linux eligibility: free distros only (no RHEL/SLES/Ubuntu Pro/Oracle Linux) and no Dev/Test. */
function isLinuxRetailEligible(item) {
  const { os, isPaidLinux, isDevTest } = getRetailOsInfo(item);
  if (os !== "Linux") return false;
  if (isPaidLinux) return false;
  if (isDevTest) return false;
  return true;
}

/**
 * Extract hourly USD price from Retail item.
 * Defensively ignore entries whose unit isn't hourly (accepts "1 Hour" or "Hour").
 */
function extractRetailHourlyUSD({ retailPrice, unitOfMeasure } = {}) {
  const n = Number(retailPrice);
  if (!Number.isFinite(n) || n <= 0) return null;

  const u = String(unitOfMeasure || "").toLowerCase();
  // Accept "1 hour" or "hour" variants; exclude per-month/100-hours/etc.
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
  // Bpsv2 (Standard_B2pls_v2), Dpsv5, Dpldsv5, Epsv5 are ARM (Ampere)
  return /standard_b.*psv2|standard_dpsv5|standard_dpldsv5|standard_epsv5/.test(n);
}

/** Detect Azure burstable (B-series) instances at source. */
function isBurstableAzure(instance = "") {
  const n = String(instance || "").toLowerCase();
  return /^standard_b/.test(n);
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

/**
 * True if this is a primary, On‑Demand VM compute meter.
 * We double-check here (cheap) even if the fetcher already filters type=Consumption.
 */
function isPrimaryOnDemandRetailItem(it = {}) {
  const typeOk = String(it.type || "").toLowerCase() === "consumption";
  const primary = it?.isPrimaryMeterRegion === true;
  return typeOk && primary;
}

/**
 * Build a name->{vcpu,ram} map from ResourceSkus for a given subscription & region.
 * Requires an ARM token with Microsoft.Compute/skus read permissions.
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
  // Note: We still allow "B" here to keep this utility generic,
  // but you should call isBurstableAzure() in the FETCHER to exclude B-series at source.
  return ["A","B","D","E","F","L","M","N","H"].includes(lead);
}

/* ============================================================
 * UI-friendly naming helpers
 * ============================================================*/

/**
 * Friendly display for UI: "standard_d2s_v5" -> "Standard D2s v5"
 * Preserves sub-series letters (s / as / ads / ls / pls / …).
 */
function azureDisplayNameFromNormalized(instance = "") {
  if (!instance) return "";
  let s = String(instance);
  if (s.startsWith("standard_")) s = s.slice(9);

  // tokens like: ["d2s","v5"] or ["d2as","v6"] or ["f4","v2"]
  const parts = s.split("_").filter(Boolean);
  if (parts.length === 0) return "Standard";

  const capFirst = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);

  if (parts.length === 1) {
    return `Standard ${capFirst(parts[0])}`;
  }
  // Join everything except last part (usually generation) as size token
  const gen = parts[parts.length - 1].toLowerCase();                  // v5, v6
  const size = parts.slice(0, parts.length - 1).join("").toLowerCase(); // d2s, d2as
  return `Standard ${capFirst(size)} ${gen}`;
}

/**
 * Concise grouping label: "standard_d2as_v6" -> "D-as v6", "standard_f4_v2" -> "F v2"
 * Useful for badges/filters.
 */
function azureSeriesFromNormalized(instance = "") {
  if (!instance) return null;
  const s = String(instance).toLowerCase().replace(/^standard_/, "");
  const parts = s.split("_").filter(Boolean);
  const gen = (parts.find(p => /^v\d+/i.test(p)) || "").toLowerCase(); // v5/v6

  const base = parts[0] || "";
  const m = /^([a-z])(\d+)([a-z]+)?/i.exec(base);
  if (!m) return gen || null;

  const fam = m[1].toUpperCase();          // D/E/F/…
  const sub = (m[3] || "").toLowerCase();  // s / as / ads / ls / …
  const subLabel = sub ? `-${sub}` : "";
  return `${fam}${subLabel} ${gen || ""}`.trim();
}

/**
 * Azure-calculator-style series label: "standard_d2als_v6" -> "Dalsv6-series"
 * Matches how Azure lists series in the Pricing Calculator.
 */
function azureSeriesNameFromNormalized(instance = "") {
  if (!instance) return null;

  let s = String(instance).toLowerCase();
  if (s.startsWith("standard_")) s = s.slice(9);

  // Example tokens: ["d2als", "v6"]
  const parts = s.split("_").filter(Boolean);
  if (parts.length === 0) return null;

  const base = parts[0];          // e.g., d2als
  const gen  = parts[1] || "";    // v6

  // Extract family + sub-series (letters after the size digits)
  // Pattern: first letter = family, numbers = size, trailing letters = sub-series
  const m = /^([a-z])(\d+)([a-z]+)?/.exec(base);
  if (!m) return null;

  const fam = m[1].toUpperCase();       // D / E / F / M ...
  const sub = (m[3] || "").toLowerCase();  // s / as / ads / als / ls / ...

  const series = sub ? `${fam}${sub}${gen}` : `${fam}${gen}`;
  return `${series}-series`;
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
  isBurstableAzure,
  normalizeAzureInstanceName,
  fullInstanceFromRetail,

  // Primary On‑Demand helper
  isPrimaryOnDemandRetailItem,

  // ResourceSkus
  getResourceSkusMap,

  // UI naming helpers
  azureDisplayNameFromNormalized,
  azureSeriesFromNormalized,
  azureSeriesNameFromNormalized
};
