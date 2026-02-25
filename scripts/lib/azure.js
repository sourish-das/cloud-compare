// scripts/lib/azure.js
// Helpers for Azure Retail Prices + ResourceSkus enrichment

/**
 * Build a unified lowercase blob from the main retail fields for string tests.
 */
function _blob(productName = "", skuName = "", meterName = "") {
  return `${productName} ${skuName} ${meterName}`.toLowerCase().trim();
}

/**
 * Classify the OS and flags from an Azure Retail Prices item.
 * The retail API typically exposes: productName, skuName, meterName, retailPrice, unitOfMeasure, armRegionName, armSkuName, etc.
 *
 * Returns:
 *   {
 *     os: "Windows" | "Linux",
 *     isPaidLinux: boolean,        // RHEL / SUSE / SLES / Oracle Linux / Ubuntu Pro, etc.
 *     hasSql: boolean,             // Windows with SQL Server editions (exclude for plain Windows Server comparison)
 *     isDevTest: boolean           // Dev/Test labels (exclude for pay-as-you-go comparison)
 *   }
 */
function getRetailOsInfo({ productName = "", skuName = "", meterName = "" } = {}) {
  const s = _blob(productName, skuName, meterName);

  const isWindows = /windows/.test(s);
  const hasSql = /sql\s*(server|enterprise|standard|web)/.test(s);
  const isDevTest = /(dev\/?test|msdn)/.test(s);

  // Paid Linux signals (we compare only free Linux distros like Ubuntu/CentOS)
  const isPaidLinux =
    /(rhel|red\s*hat|suse|sles|oracle\s*linux|ubuntu\s*pro)/.test(s);

  const os = isWindows ? "Windows" : "Linux";
  return { os, isPaidLinux, hasSql, isDevTest };
}

/**
 * True if the retail item is acceptable for Windows Server (license-included, no SQL, no Dev/Test).
 * Use this when you are collecting Windows rows.
 */
function isWindowsRetailEligible(item) {
  const { os, hasSql, isDevTest } = getRetailOsInfo(item);
  if (os !== "Windows") return false;
  if (hasSql) return false;       // exclude SQL bundles
  if (isDevTest) return false;    // exclude Dev/Test
  return true;
}

/**
 * True if the retail item is acceptable for "Linux (free distro only)" pricing.
 * Excludes paid Linux offerings like RHEL/SLES/Ubuntu Pro.
 */
function isLinuxRetailEligible(item) {
  const { os, isPaidLinux, isDevTest } = getRetailOsInfo(item);
  if (os !== "Linux") return false;
  if (isPaidLinux) return false;
  if (isDevTest) return false;
  return true;
}

/**
 * Extract the retail USD hourly price.
 * Accepts either:
 *   - retailPrice (already per hour), or
 *   - retailPrice with unitOfMeasure == "1 Hour" (or starts with "1 Hour"/"Hours")
 *
 * Returns Number|null (null if not usable).
 */
function extractRetailHourlyUSD({ retailPrice, unitOfMeasure } = {}) {
  const n = Number(retailPrice);
  if (!Number.isFinite(n) || n <= 0) return null;

  const u = String(unitOfMeasure || "").toLowerCase();
  // Most VM lines are "1 Hour". Some tools display "Hours" variants.
  if (u && !(u.startsWith("1 hour") || u.startsWith("hour"))) {
    // If an unexpected unit appears, be defensive and ignore (prevents GB/Month etc. from sneaking in)
    return null;
  }
  return n;
}

/**
 * Detect OS from a retail product label (legacy helper; kept for compatibility).
 * Uses only the productName; prefer getRetailOsInfo(...) for new code.
 */
function detectOsFromProductName(productName = "") {
  return /windows/i.test(productName) ? "Windows" : "Linux";
}

/**
 * Simple family tag by first letter (D=general, E=memory, F=compute, else other)
 * Works on names like "Standard_D2s_v5" or already-normalized "d2s_v5".
 */
function categorizeByInstanceName(instance = "") {
  const n = String(instance).toLowerCase();
  const body = n.startsWith("standard_") ? n.slice(9) : n;
  const lead = body[0];
  return lead === "d" ? "general" :
         lead === "e" ? "memory"  :
         lead === "f" ? "compute" : "other";
}

/**
 * Azure ARM instance detector (to block when OS=Windows).
 * Bpsv2 (e.g., Standard_B2pls_v2), Dpsv5, Epsv5 are based on Ampere Altra (ARM).
 */
function isAzureArmInstance(instance = "") {
  const n = String(instance || "").toLowerCase();
  return /standard_b.*psv2|standard_dpsv5|standard_epsv5/.test(n);
}

/**
 * Normalize an instance string from various SKU fields to a consistent "standard_..." shape.
 * E.g., "D2s v5" --> "standard_d2s_v5"
 */
function normalizeAzureInstanceName(name = "") {
  const raw = String(name || "").trim();
  if (!raw) return "";
  let s = raw.toLowerCase().replace(/\s+/g, "_");
  if (!/^standard_/.test(s)) s = `standard_${s}`;
  return s;
}

/**
 * Build a name->({vcpu,ram}) map from ResourceSkus for a given subscription & region.
 * ARM token must be an access token for https://management.azure.com/
 */
async function getResourceSkusMap({ subscriptionId, region, armToken }) {
  const map = new Map();
  let next =
    `https://management.azure.com/subscriptions/${subscriptionId}` +
    `/providers/Microsoft.Compute/skus?api-version=2021-07-01&$filter=location eq '${region}'`;

  let pages = 0, MAX = 80;

  while (next && pages < MAX) {
    const res = await fetch(next, {
      headers: { Authorization: `Bearer ${armToken}` }
    });

    if (!res.ok) {
      console.warn(`[Azure] ResourceSkus HTTP ${res.status}`);
      break;
    }

    const j = await res.json();

    for (const sku of (j.value || [])) {
      if (sku.resourceType !== "virtualMachines") continue;

      const caps = Object.fromEntries(
        (sku.capabilities || []).map(x => [x.name, x.value])
      );

      const v = caps.vCPUs ? Number(caps.vCPUs) : null;
      const m = caps.MemoryGB ? Number(caps.MemoryGB) : null;

      if (v || m) {
        // sku.name is already something like "Standard_D2s_v5"
        map.set(String(sku.name).toLowerCase(), { vcpu: v, ram: m });
      }
    }

    next = j.nextLink || null;
    pages++;
  }

  console.log(`[Azure] ResourceSkus entries: ${map.size}`);
  return map;
}

/**
 * Widen series filter: allow major VM families we care about.
 */
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

  // legacy + family helpers
  detectOsFromProductName,
  categorizeByInstanceName,
  widenAzureSeries,

  // ARM & names
  isAzureArmInstance,
  normalizeAzureInstanceName,

  // ResourceSkus
  getResourceSkusMap
};
