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

/* ============================================================
 * ResourceSkus enrichment
 *  - Adds a cross-walk so "ECasv6-2" also maps to "standard_ec2as_v6"
 *    fixing vCPU/RAM enrichment for multi-letter families.
 * ============================================================*/

/**
 * Try to convert an Azure ResourceSkus size name (e.g., "ECasv6-2")
 * into your normalized instance key (e.g., "standard_ec2as_v6").
 *
 * Pattern: <lettersFull><vX>-<size>
 *   lettersFull = family + (optional) sub-suffix (s|as|ads|als|ls|pls|ps)
 *   vX          = generation (v2|v3|v5|v6...)
 *   size        = numeric size
 *
 * Examples:
 *   ECasv6-2  -> standard_ec2as_v6
 *   Dsv5-4    -> standard_d4s_v5
 *   Lsv3-8    -> standard_ls8_v3
 *   Fv2-4     -> standard_f4_v2
 */
function _normalizedFromSkuName(skuName = "") {
  const m = /^([a-z]+)(v\d+)\-(\d+)$/i.exec(String(skuName).trim());
  if (!m) return null;

  const lettersFull = m[1].toLowerCase(); // e.g., 'ecas', 'ds', 'ls', 'f'
  const gen         = m[2].toLowerCase(); // 'v6', 'v5', 'v3', 'v2'
  const sizeNum     = m[3];               // '2', '4', '8', ...

  // Known Azure sub-suffixes frequently used
  const KNOWN_SUBS = ["ads", "als", "pls", "ls", "as", "s"]; // order matters (longer first)

  let sub = "";
  let family = lettersFull;
  for (const suf of KNOWN_SUBS) {
    if (lettersFull.endsWith(suf)) {
      sub = suf;                                 // e.g., 'as'
      family = lettersFull.slice(0, -suf.length); // e.g., 'ec'
      break;
    }
  }

  // Build "ec2as" or "d4s" or "ls8"
  const base = `${family}${sizeNum}${sub}`;       // family + size + sub
  return `standard_${base}_${gen}`.toLowerCase(); // standard_ec2as_v6
}

/**
 * Build a name->{vcpu,ram} map from ResourceSkus for a given subscription & region.
 * Requires an ARM token with Microsoft.Compute/skus read permissions.
 *
 * NOTE: We now set TWO keys for each entry:
 *   1) raw sku.name (lowercased), e.g., "ecasv6-2"
 *   2) normalized key, e.g., "standard_ec2as_v6"
 * so that later lookups by vm.instance (normalized) succeed.
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
      const v = caps.vCPUs    ? Number(caps.vCPUs)    : null;
      const mGB = caps.MemoryGB ? Number(caps.MemoryGB) : null;

      if (v || mGB) {
        const rawKey  = String(sku.name || "").toLowerCase();     // e.g., "ecasv6-2"
        const normKey = _normalizedFromSkuName(sku.name || "");   // e.g., "standard_ec2as_v6" or null

        const entry = { vcpu: v, ram: mGB };
        if (rawKey)  map.set(rawKey, entry);
        if (normKey) map.set(normKey, entry);
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
 * UI-friendly naming helpers (robust for multi-letter families)
 * ============================================================*/

/**
 * Internal: split normalized instance into {family, sizeNum, sub, gen}
 * Examples:
 *   "d2s_v5"    -> { family:"d",  sizeNum:"2", sub:"s",   gen:"v5" }
 *   "ec2as_v6"  -> { family:"ec", sizeNum:"2", sub:"as",  gen:"v6" }
 *   "e4ads_v6"  -> { family:"e",  sizeNum:"4", sub:"ads", gen:"v6" }
 *   "ls8_v3"    -> { family:"ls", sizeNum:"8", sub:"",    gen:"v3" }
 */
function _parseAzureInstanceParts(instance = "") {
  const s = String(instance).toLowerCase().replace(/^standard_/, "");
  const parts = s.split("_").filter(Boolean);
  const base = parts[0] || "";
  const gen  = (parts.find(p => /^v\d+$/i.test(p)) || "").toLowerCase();

  // family = 1+ letters, size = digits, sub = 0+ letters
  const m = /^([a-z]+?)(\d+)([a-z]+)?$/.exec(base);
  if (!m) return { family: "", sizeNum: "", sub: "", gen };
  return { family: m[1] || "", sizeNum: m[2] || "", sub: m[3] || "", gen };
}

/** Friendly display for UI: "standard_ec2as_v6" -> "Standard EC2as v6" */
function azureDisplayNameFromNormalized(instance = "") {
  if (!instance) return "";
  let s = String(instance);
  if (s.startsWith("standard_")) s = s.slice(9);

  const { family, sizeNum, sub, gen } = _parseAzureInstanceParts(instance);
  if (!family || !sizeNum) {
    // Fallback (old behavior) if parse fails
    const parts = s.split("_").filter(Boolean);
    const capFirst = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);
    if (parts.length === 0) return "Standard";
    if (parts.length === 1) return `Standard ${capFirst(parts[0])}`;
    const last = parts[parts.length - 1].toLowerCase();
    const size = parts.slice(0, parts.length - 1).join("").toLowerCase();
    return `Standard ${capFirst(size)} ${last}`;
  }

  const familyUC = family.toUpperCase(); // EC / DC / LS / D / E / F ...
  const sizeStr  = `${familyUC}${sizeNum}${sub || ""}`;
  return gen ? `Standard ${sizeStr} ${gen}` : `Standard ${sizeStr}`;
}

/**
 * Concise grouping label (badge):
 *   "standard_ec2as_v6" -> "EC-as v6"
 *   "standard_d2s_v5"   -> "D-s v5"
 */
function azureSeriesFromNormalized(instance = "") {
  const { family, sub, gen } = _parseAzureInstanceParts(instance);
  if (!family) return gen || null;
  const famUC = family.toUpperCase();
  const subLabel = sub ? `-${sub.toLowerCase()}` : "";
  return `${famUC}${subLabel} ${gen || ""}`.trim();
}

/**
 * Azure-calculator-style series label:
 *   "standard_ec2as_v6" -> "ECasv6-series"
 *   "standard_d2s_v5"   -> "Dsv5-series"
 */
function azureSeriesNameFromNormalized(instance = "") {
  const { family, sub, gen } = _parseAzureInstanceParts(instance);
  if (!family) return gen ? `${gen}-series` : null;
  const famUC = family.toUpperCase();
  const seriesCore = `${famUC}${(sub || "").toLowerCase()}${gen || ""}`;
  return `${seriesCore}-series`;
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
