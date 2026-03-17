// scripts/lib/gcp.js
// Helpers for GCP Retail Prices + Compute discovery (Linux-first)
// CommonJS (Node 18+, global fetch)
// Version: 2.2.1 - Includes latest C4/N4/X4 series, 10x pack fix, and modern RAM ratios.

"use strict";

/**
 * Compute Engine service id for Catalog Retail Prices API (public SKUs).
 * This service ID is universal for Google Cloud Compute Engine.
 * Example: services/6F81-5844-456A
 */
const CE_SERVICE_ID = "6F81-5844-456A";

/* ============================================================
 * (Optional) Series lists for UI display only (not used to classify)
 * ============================================================ */
const GCP_SERIES_ALLOW = {
  general: ["E2", "N1", "N2", "N2D", "N4", "N4A", "N4D", "T2A", "T2D"],
  compute: ["C2", "C2D", "C3", "C3D", "C4", "C4D", "C4A", "H3", "H4", "H4D"],
  memory:  ["M1", "M2", "M3", "M4", "X4"]
};

// Arm-identifying series (used only for arch tag)
// t2a: Ampere Altra, c4a: Axion, n4a: Axion
const ARM_SERIES = new Set(["t2a", "c4a", "n4a", "a4x"]);

// Example instances (handy for probes/docs; not used by logic)
const GCP_EXAMPLE_INSTANCES = {
  general: ["e2-standard-2", "n2-standard-4", "t2a-standard-4", "n4-standard-4"],
  compute: ["c2-standard-4", "c3-standard-4", "c4-standard-4", "n2-highcpu-4", "e2-highcpu-8"],
  memory:  ["m1-ultramem-40", "m2-ultramem-208", "m3-megamem-64", "n2-highmem-8", "e2-highmem-4"]
};

/* ---------------------------
 * Instance parsing helpers
 * --------------------------- */

/**
 * Try to infer a predefined machine type token from a Catalog SKU row.
 * Checks attributes first, then falls back to regex on description.
 */
function inferMachineType(sku) {
  const attrs = sku?.attributes || {};
  if (attrs.machineType) {
    const mt = String(attrs.machineType).toLowerCase();
    if (/^custom-/.test(mt)) return null; // exclude custom
    return mt;
  }
  const s = String(sku?.description || sku?.displayName || "").toLowerCase();
  
  // Comprehensive regex for all current GCP families including 2024nd/2025 releases.
  // Patterns: {series}-{class}-{vcpu}
  const re =
    /\b(m1|m2|m3|m4|x4|h4d|h4|h3|c2d|c2|c3d|c3|c4d|c4a|c4|n4d|n4a|n4|n2d|n2|n1|e2|t2a|t2d)-(standard|highmem|highcpu|ultramem|megamem)-(\d+)\b/;
  const m = s.match(re);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/**
 * Normalize Catalog prices to $/hour.
 * This version is conversion-aware, handling per-second and per-minute units.
 * FIXED: Handles "display packs" (e.g. 10x vCPU-hours) to prevent 10x undercount.
 */
function extractHourlyPrice(pricingInfo) {
  for (const p of (pricingInfo || [])) {
    const pe = p?.pricingExpression;
    if (!pe) continue;
    const rate = pe?.tieredRates?.[0]?.unitPrice;
    if (!rate) continue;

    // Raw money amount (in the unit described by usage/base below)
    let money = Number(rate.units || 0) + Number(rate.nanos || 0) / 1e9;
    if (!(money > 0)) continue;

    const usage = String(pe.usageUnit || "").toLowerCase();   // e.g., 'h', 's', 'min'
    const base  = String(pe.baseUnit   || "").toLowerCase();  // e.g., 's'
    const k     = Number(pe.baseUnitConversionFactor || 1);   // e.g., 3600 when mapping base->usage

    // If the usage unit explicitly says hours, treat 'money' as already $/hour.
    let hourly;
    if (usage === "h" || usage === "hour" || usage === "hours") {
      hourly = money;
    } else if (usage === "s" || usage === "sec" || usage === "second" || usage === "seconds") {
      hourly = money * 3600; // seconds -> hours
    } else if (usage === "min" || usage === "minute" || usage === "minutes") {
      hourly = money * 60;   // minutes -> hours
    } else if (base === "s" || base === "sec" || base === "second" || base === "seconds") {
      // If usageUnit is empty but baseUnit is seconds, multiply once by factor to reach hours.
      hourly = money * (k > 0 ? k : 3600);
    } else {
      // Default: assume already per hour.
      hourly = money;
    }

    // --- NEW: handle "display packs" (e.g., price is for 10 vCPU-hrs or 10 GiB-hrs) ---
    const dq = Number(pe.displayQuantity || 1);
    const ud = String(pe.usageUnitDescription || "").toLowerCase();
    const mentionsTenPack = dq >= 10 && (/\b10\b/.test(ud) && /\b(vcpu|core|gb|gib|memory|ram)\b/.test(ud));

    // Heuristic: if displayQuantity >= 10 and description implies a 10-pack,
    // or the computed hourly looks implausibly small for core/ram SKUs (<~0.05),
    // scale by displayQuantity to get the true per-hour, per-VM unit rate.
    if (dq >= 10 && (mentionsTenPack || hourly < 0.05)) {
      hourly *= dq;
    }
    // -------------------------------------------------------------------------------

    return hourly;
  }
  return null;
}

/**
 * Derive vCPU/RAM for predefined machine types.
 * Standard ratios used for unit-rate pricing composition.
 * FIXED: Sets 2 GiB/vCPU for modern HIGHCPU (N4/N4A/C4/C4D etc.).
 */
function deriveVcpuRamFromType(mt) {
  if (!mt) return { vcpu: undefined, ram: undefined };
  if (/^custom-/.test(mt)) return { vcpu: undefined, ram: undefined };
  
  const m = String(mt).match(
    /^(m1|m2|m3|m4|x4|h4d|h4|h3|c2d|c2|c3d|c3|c4d|c4a|c4|n4d|n4a|n4|n2d|n2|n1|e2|t2a|t2d)-(standard|highmem|highcpu|ultramem|megamem)-(\d+)$/i
  );
  if (!m) return { vcpu: undefined, ram: undefined };

  const series = m[1].toLowerCase();
  const cls    = m[2].toLowerCase();
  const vcpu   = Number(m[3]);
  if (!vcpu) return { vcpu: undefined, ram: undefined };

  // Avoid RAM guess for memory-optimized (M/X) series as they don't follow a simple linear ratio.
  if (series.startsWith("m") || series.startsWith("x")) return { vcpu, ram: undefined };

  if (cls.startsWith("standard")) return { vcpu, ram: vcpu * 4 };
  if (cls.startsWith("highmem"))  return { vcpu, ram: vcpu * 8 };
  
  if (cls.startsWith("highcpu")) {
    if (series.startsWith("n1")) return { vcpu, ram: vcpu * 0.9 }; // legacy N1
    return { vcpu, ram: vcpu * 2 }; // modern families: 2 GiB per vCPU
  }

  return { vcpu, ram: undefined };
}

/* ---------------------------
 * Region helpers
 * --------------------------- */

/** * Matches a SKU's service regions against a desired target.
 * Logic: Exact Match > 'Global' catch-all > 'US' multi-region for us-* zones.
 */
function regionMatches(serviceRegions, region) {
  const want = String(region || "").toLowerCase();
  const set = new Set((serviceRegions || []).map(r => String(r).toLowerCase()));
  if (set.has(want)) return true;
  if (set.has("global")) return true;
  if (want.startsWith("us-") && set.has("us")) return true;
  return false;
}

/** * Detects if a SKU represents a specific instance type rather than a resource unit.
 */
function isPerInstanceSku(sku, machineType) {
  const name = String(sku?.description || sku?.displayName || "");
  if (!machineType) return false;
  if (/^custom-/.test(machineType)) return false;
  
  // If it mentions specific units like "Core" or "RAM", it's likely a resource-based SKU.
  if (/\b(Core|vCPU|Ram|Memory|Sole\s*Tenancy|Sole\s*Tenant)\b/i.test(name)) return false; 
  
  const hasInstanceNoun = /\b(Instance|VM)\b/i.test(name);
  const includesType = name.toLowerCase().includes(String(machineType).toLowerCase());
  return hasInstanceNoun && includesType;
}

/* ============================================================
 * Linux unit-rate map builder (Core/RAM) from Catalog SKUs
 * ============================================================ */

/**
 * Filter and parse SKUs for base Linux unit rates.
 */
function parseSeriesUnitRate(sku) {
  const name = (sku.description || sku.displayName || "").toLowerCase();

  // Exclude OS licenses, GPUs, Local SSD, and specialized tenancy models.
  if (/(windows|sles|rhel).*license|license.*(windows|sles|rhel)/i.test(name)) return null;
  if (/(local\s*ssd|gpu|sole\s*tenant|commitment|cud|preemptible|spot)/i.test(name)) return null;

  // Extract series (e.g., n2, c3) and resource kind (core vs ram).
  const m = name.match(
    /\b(m1|m2|m3|m4|x4|h4d|h4|h3|n1|n2d|n2|n4|n4a|n4d|e2|t2a|t2d|c2d|c3d|c3|c4d|c4|c4a|c2)\b.*\b(core|vcpu|ram|memory|ultramem|megamem)\b/i
  );
  if (!m) return null;

  const series = m[1].toLowerCase();
  const kindRaw = m[2].toLowerCase();
  const kind = /(ram|memory|ultramem|megamem)/.test(kindRaw) ? "ram" : "core";

  const price = extractHourlyPrice(sku.pricingInfo);
  if (!(price > 0)) return null;
  return { series, kind, price };
}

/**
 * Constructs a lookup map { [series]: { core: price, ram: price } }.
 * Uses regional precedence to ensure the most specific price is used.
 */
function buildSeriesUnitRateMaps(allSkus, region) {
  const bySeriesKind = {};
  const want = String(region || "").toLowerCase();
  const normSet = (arr) => new Set((arr || []).map(s => String(s).toLowerCase()));

  const scopeOf = (sku) => {
    const set = normSet(sku.serviceRegions);
    if (set.has(want)) return "exact";
    if (want.startsWith("us-") && set.has("us")) return "us";
    if (set.has("global")) return "global";
    return null;
  };

  for (const sku of (allSkus || [])) {
    const cat = sku?.category || {};
    if (cat.resourceFamily !== "Compute") continue;
    if (cat.usageType && !/OnDemand/i.test(cat.usageType)) continue;

    const scope = scopeOf(sku);
    if (!scope) continue;

    const info = parseSeriesUnitRate(sku);
    if (!info) continue;

    const { series, kind, price } = info;
    if (!bySeriesKind[series]) bySeriesKind[series] = { core: {}, ram: {} };
    
    const cur = bySeriesKind[series][kind][scope];
    if (!(cur > 0) || price < cur) {
      bySeriesKind[series][kind][scope] = price;
    }
  }

  // Flatten the scopes into a single rate per series/kind.
  const out = {};
  for (const [series, kinds] of Object.entries(bySeriesKind)) {
    const core = kinds.core.exact ?? kinds.core.us ?? kinds.core.global;
    const ram  = kinds.ram.exact  ?? kinds.ram.us  ?? kinds.ram.global;
    if (core > 0 && ram > 0) out[series] = { core, ram };
  }
  return out;
}

/* ============================================================
 * Category classification (Calculator-style)
 * ============================================================ */

/**
 * Classifies an instance into General, Compute, or Memory optimized.
 * Based on machine type naming conventions.
 */
function classifyGcpInstance(instance) {
  if (!instance) return null;
  const raw = String(instance).trim();
  if (!raw || /^custom-/i.test(raw)) return null;

  const T = raw.toUpperCase();
  const m = T.match(/^([A-Z0-9]+)-(STANDARD|HIGHCPU|HIGHMEM|ULTRAMEM|MEGAMEM)-(\d+)$/);
  if (!m) return null;

  const cls = m[2];
  if (cls === "STANDARD") return "general";
  if (cls === "HIGHCPU")  return "compute";
  return "memory";
}

function getGcpAllowedPrefixes(category) {
  return (GCP_SERIES_ALLOW[category] || []).map(s => s.toUpperCase());
}

/* ============================================================
 * Base price computation
 * ============================================================ */

/**
 * Computes the base hourly Linux price for a machine type using the unit map.
 * Calculation: (vCPUs * CoreRate) + (RAM_GiB * RamRate)
 */
function computeBaseHourlyFromUnitMaps(machineType, unitMaps, opts = {}) {
  if (!machineType || !unitMaps) return { price: null, vcpu: undefined, ram: undefined };

  let { vcpu, ram } = deriveVcpuRamFromType(machineType);
  
  // For M/X series, we rely on external discovery for RAM.
  if (!Number.isFinite(ram) && Number.isFinite(opts.discoveredRamGiB)) {
    ram = Number(opts.discoveredRamGiB);
  }
  
  if (!Number.isFinite(vcpu) || !Number.isFinite(ram)) {
    return { price: null, vcpu, ram };
  }

  const series = String(machineType).toLowerCase().split("-")[0];
  const rates = unitMaps[series];
  if (!rates) return { price: null, vcpu, ram };

  const corePrice = Number(rates.core);
  const ramPrice  = Number(rates.ram);
  
  if (!Number.isFinite(corePrice) || !Number.isFinite(ramPrice)) {
    return { price: null, vcpu, ram };
  }

  const totalPrice = (vcpu * corePrice) + (ram * ramPrice);
  return { price: totalPrice, vcpu, ram };
}

/* ============================================================
 * FULL-mode discovery helpers (Compute API via OIDC)
 * ============================================================ */

async function getAccessTokenFromADC() {
  const token =
    process.env.GCLOUD_ACCESS_TOKEN ||
    process.env.GOOGLE_OAUTH_ACCESS_TOKEN || "";
  if (!token) {
    throw new Error("[GCP] No access token found in environment. Provide GCLOUD_ACCESS_TOKEN.");
  }
  return token;
}

/**
 * Fetches zones for a specific region to scope machine type discovery.
 */
async function listRegionZones(projectId, region, accessToken) {
  const url = `https://compute.googleapis.com/compute/v1/projects/${projectId}/zones`;
  const zones = [];
  let pageToken = "";
  
  while (true) {
    const pageUrl = pageToken ? `${url}?pageToken=${encodeURIComponent(pageToken)}` : url;
    const r = await fetch(pageUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`[GCP] zones.list HTTP ${r.status}: ${txt}`);
    }
    const j = await r.json();
    for (const z of j.items || []) {
      const name = String(z.name || "").toLowerCase();
      if (name.startsWith(`${region.toLowerCase()}-`)) zones.push(z.name);
    }
    if (!j.nextPageToken) break;
    pageToken = j.nextPageToken;
  }
  return zones;
}

/**
 * Lists predefined machine types available in a zone.
 */
async function listZoneMachineTypes(projectId, zone, accessToken) {
  const url = `https://compute.googleapis.com/compute/v1/projects/${projectId}/zones/${zone}/machineTypes`;
  const mts = [];
  let pageToken = "";
  
  while (true) {
    const pageUrl = pageToken ? `${url}?pageToken=${encodeURIComponent(pageToken)}` : url;
    const r = await fetch(pageUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`[GCP] machineTypes.list HTTP ${r.status}: ${txt}`);
    }
    const j = await r.json();
    for (const mt of j.items || []) {
      const name = String(mt.name || "");
      if (/^custom-/i.test(name)) continue; 
      if (!/^[a-z0-9]+-[a-z]+[a-z0-9]*-\d+$/i.test(name)) continue; 
      mts.push({ name, guestCpus: mt.guestCpus, memoryMb: mt.memoryMb });
    }
    if (!j.nextPageToken) break;
    pageToken = j.nextPageToken;
  }
  return mts;
}

/* ============================================================
 * Windows / Premium OS Helpers
 * ============================================================ */

const WINDOWS_STANDARD_FALLBACK_RATE =
  Number(process.env.GCP_WINDOWS_RATE_PER_VCPU || 0) || 0.046;

/**
 * Attempts to find the lowest hourly Windows licensing rate per vCPU for a region.
 */
function buildWindowsCoreRate(allSkus, region) {
  const inRegion = (sku) => {
    const cat = sku?.category || {};
    if (cat.resourceFamily !== "Compute") return false;
    if (cat.usageType && !/OnDemand/i.test(cat.usageType)) return false;
    return regionMatches(sku.serviceRegions, region);
  };

  const BAD = /(byol|ram|memory|gpu|local\s*ssd|commitment|spot|preemptible|sles|rhel|sql|windows\s*(7|8|10|11))/i;
  const candidates = [];

  for (const sku of (allSkus || [])) {
    if (!inRegion(sku)) continue;
    const name = (sku.description || sku.displayName || "").toLowerCase();
    if (!/windows/.test(name)) continue;
    if (!/(license|licensing|core|vcpu)/.test(name)) continue;
    if (BAD.test(name)) continue;
    
    const price = extractHourlyPrice(sku.pricingInfo);
    if (price && price > 0) candidates.push({ price, name });
  }

  // If no core-specific SKUs found, look for general paid server license SKUs.
  if (candidates.length === 0) {
    for (const sku of (allSkus || [])) {
      if (!inRegion(sku)) continue;
      const name = (sku.description || sku.displayName || "").toLowerCase();
      if (!/windows/.test(name) || BAD.test(name)) continue;
      if (!/(paid|on-?demand|windows\s*server)/.test(name)) continue;
      
      const price = extractHourlyPrice(sku.pricingInfo);
      if (price && price > 0) candidates.push({ price, name });
    }
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => a.price - b.price);
    return candidates[0].price;
  }
  return WINDOWS_STANDARD_FALLBACK_RATE;
}

/* ============================================================
 * Arm Helpers
 * ============================================================ */

function isGcpArmSeries(series) {
  if (!series) return false;
  return ARM_SERIES.has(String(series).toLowerCase());
}

function isGcpArmMachineType(machineType) {
  if (!machineType) return false;
  const m = String(machineType).toLowerCase().match(/^([a-z0-9]+)-[a-z]+[a-z0-9]*-\d+$/);
  if (!m) return false;
  return isGcpArmSeries(m[1]);
}

/* ============================================================
 * Module Exports
 * ============================================================ */

module.exports = {
  CE_SERVICE_ID,
  
  // Classification & Metadata
  classifyGcpInstance,
  getGcpAllowedPrefixes,
  GCP_EXAMPLE_INSTANCES,
  GCP_SERIES_ALLOW,
  
  // Parsing & Pricing
  extractHourlyPrice,
  inferMachineType,
  deriveVcpuRamFromType,
  regionMatches,
  isPerInstanceSku,
  
  // Discovery (Cloud API)
  getAccessTokenFromADC,
  listRegionZones,
  listZoneMachineTypes,
  
  // Unit-Rate Composition
  buildSeriesUnitRateMaps,
  computeBaseHourlyFromUnitMaps,
  
  // OS Add-ons
  buildWindowsCoreRate,
  WINDOWS_STANDARD_FALLBACK_RATE,
  
  // Architecture
  isGcpArmSeries,
  isGcpArmMachineType
};
