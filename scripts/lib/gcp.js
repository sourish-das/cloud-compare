// Helpers for GCP Retail Prices + Compute discovery (Linux-first)
// CommonJS (Node 18+, global fetch)

"use strict";

/**
 * Compute Engine service id for Catalog Retail Prices API (public SKUs).
 * Example: services/6F81-5844-456A
 */
const CE_SERVICE_ID = "6F81-5844-456A";

/* ============================================================
 * Series policy (apples-to-apples with AWS/Azure categories)
 * ------------------------------------------------------------
 * GENERAL → E/N/T (STANDARD only)
 * COMPUTE → C/H + any *-HIGHCPU-*
 * MEMORY  → M + X + any *-HIGHMEM-*
 * ============================================================ */

const GCP_SERIES_ALLOW = {
  general: ["E2", "N1", "N2", "N2D", "N4", "N4A", "N4D", "T2A", "T2D"],
  compute: ["C2", "C2D", "C3", "C3D", "C4", "C4D", "C4A", "H3", "H4", "H4D"],
  memory:  ["M1", "M2", "M3", "M4", "X4"]
};

// Arm-identifying series
const ARM_SERIES = new Set(["t2a", "c4a", "n4a", "a4x"]);

// Classification by non-STANDARD suffix
const CLASS_TO_CATEGORY = {
  HIGHCPU:  "compute",
  HIGHMEM:  "memory",
  ULTRAMEM: "memory",
  MEGAMEM:  "memory"
};

// Example instances (handy for probes or docs)
const GCP_EXAMPLE_INSTANCES = {
  general: ["e2-standard-2", "n2-standard-4", "t2a-standard-4", "n4-standard-4"],
  compute: ["c2-standard-4", "c3-standard-4", "c4-standard-4", "n2-highcpu-4", "e2-highcpu-8"],
  memory:  ["m1-ultramem-40", "m2-ultramem-208", "m3-megamem-64", "n2-highmem-8", "e2-highmem-4"]
};

/* ---------------------------
 * Instance parsing helpers
 * --------------------------- */

/** Try to infer a predefined machine type token from a Catalog SKU row. */
function inferMachineType(sku) {
  const attrs = sku?.attributes || {};
  if (attrs.machineType) {
    const mt = String(attrs.machineType).toLowerCase();
    if (/^custom-/.test(mt)) return null; // exclude custom
    return mt;
  }
  const s = String(sku?.description || sku?.displayName || "").toLowerCase();
  // Include latest families (x4, h3/h4/h4d, c4/c4a/c4d, n4/n4a/n4d)
  const re =
    /\b(m1|m2|m3|m4|x4|h4d|h4|h3|c2d|c2|c3d|c3|c4d|c4a|c4|n4d|n4a|n4|n2d|n2|n1|e2|t2a|t2d)-(standard|highmem|highcpu|ultramem|megamem)-(\d+)\b/;
  const m = s.match(re);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** Extract the first positive hourly price from a Catalog pricingInfo block. */
function extractHourlyPrice(pricingInfo) {
  for (const p of (pricingInfo || [])) {
    const unit = p?.pricingExpression?.tieredRates?.[0]?.unitPrice;
    if (!unit) continue;
    const price = Number(unit.units || 0) + Number(unit.nanos || 0) / 1e9;
    if (price > 0) return price;
  }
  return null;
}

/**
 * Derive vCPU/RAM for predefined machine types only.
 * - STANDARD: 4 GiB / vCPU
 * - HIGHMEM:  8 GiB / vCPU
 * - HIGHCPU:  1 GiB / vCPU (N1 HIGHCPU is 0.9 GiB/vCPU)
 * - M*/X*: do NOT guess RAM (leave undefined)
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

  // Avoid RAM guess for memory-optimized series
  if (series.startsWith("m") || series.startsWith("x")) return { vcpu, ram: undefined };

  if (cls.startsWith("standard")) return { vcpu, ram: vcpu * 4 };
  if (cls.startsWith("highmem"))  return { vcpu, ram: vcpu * 8 };
  if (cls.startsWith("highcpu"))  return { vcpu, ram: series.startsWith("n1") ? vcpu * 0.9 : vcpu * 1.0 };

  return { vcpu, ram: undefined };
}

/* ---------------------------
 * Region helpers
 * --------------------------- */

/** Region/geo matching for Catalog SKUs. Accepts exact region, 'global', and 'us'. */
function regionMatches(serviceRegions, region) {
  const want = String(region || "").toLowerCase();
  const set = new Set((serviceRegions || []).map(r => String(r).toLowerCase()));
  if (set.has(want)) return true;
  if (set.has("global")) return true;
  if (want.startsWith("us-") && set.has("us")) return true;
  return false;
}

/** Per-instance SKU detection (not used in Linux composition but kept for completeness). */
function isPerInstanceSku(sku, machineType) {
  const name = String(sku?.description || sku?.displayName || "");
  if (!machineType) return false;
  if (/^custom-/.test(machineType)) return false;
  if (/\b(Core|vCPU|Ram|Memory|Sole\s*Tenancy|Sole\s*Tenant)\b/i.test(name)) return false; // unit or ST
  const hasInstanceNoun = /\b(Instance|VM)\b/i.test(name);
  const includesType = name.toLowerCase().includes(String(machineType).toLowerCase());
  return hasInstanceNoun && includesType;
}

/* ============================================================
 * Linux unit-rate map builder (Core/RAM) from Catalog SKUs
 * ============================================================ */

/**
 * Parse eligible Catalog SKUs into { series: { core, ram } } map (Linux base).
 * - Compute family + On‑Demand usage only
 * - Region‑matched
 * - Exclude Windows/SLES/RHEL licenses, GPUs, Local SSD, commitments, spot/preemptible, BYOL
 */
function parseSeriesUnitRate(sku) {
  const name = (sku.description || sku.displayName || "").toLowerCase();

  // Exclude OS license or non-compute items
  if (/(windows|sles|rhel).*license|license.*(windows|sles|rhel)/i.test(name)) return null;
  if (/(local\s*ssd|gpu|sole\s*tenant|commitment|cud|preemptible|spot)/i.test(name)) return null;

  // Detect series & kind words (core/vcpu/ram/memory, plus memory-optimized hints)
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

/** Build a per-series { core, ram } unit-rate map for a given region (On‑Demand only). */
function buildSeriesUnitRateMaps(allSkus, region) {
  const maps = {};
  for (const sku of (allSkus || [])) {
    const cat = sku?.category || {};
    if (cat.resourceFamily !== "Compute") continue;
    if (cat.usageType && !/OnDemand/i.test(cat.usageType)) continue; // on-demand only
    if (!regionMatches(sku.serviceRegions, region)) continue;

    const info = parseSeriesUnitRate(sku);
    if (!info) continue;

    // Keep the lowest positive price seen for each kind (defensive)
    if (!maps[info.series]) maps[info.series] = {};
    const cur = Number(maps[info.series][info.kind] || 0);
    if (!(cur > 0) || info.price < cur) {
      maps[info.series][info.kind] = info.price;
    }
  }
  return maps;
}

/* ============================================================
 * Category classification (hyphen-native)
 * ============================================================ */

/**
 * Classify a predefined machine type to {general|compute|memory}.
 * Accepts tokens like: c4-standard-4, n2-highcpu-8, m2-ultramem-208
 * (We standardize on hyphens across providers; exclude custom-*.)
 */
function classifyGcpInstance(instance) {
  if (!instance) return null;
  const raw = String(instance).trim();
  if (!raw || /^custom-/i.test(raw)) return null;

  const T = raw.toUpperCase();
  const m = T.match(/^([A-Z0-9]+)-(STANDARD|HIGHCPU|HIGHMEM|ULTRAMEM|MEGAMEM)-(\d+)$/);
  if (!m) return null;

  const series = m[1];
  const cls    = m[2];

  // Non-Standard classes have priority
  if (cls === "HIGHCPU") return "compute";
  if (cls === "HIGHMEM" || cls === "ULTRAMEM" || cls === "MEGAMEM") return "memory";

  // STANDARD → decide by series family
  if (GCP_SERIES_ALLOW.compute.includes(series)) return "compute";
  if (GCP_SERIES_ALLOW.memory.includes(series))  return "memory";
  if (GCP_SERIES_ALLOW.general.includes(series)) return "general";
  return null;
}

function getGcpAllowedPrefixes(category) {
  return (GCP_SERIES_ALLOW[category] || []).map(s => s.toUpperCase());
}

/* ============================================================
 * Arm helpers
 * ============================================================ */

/** Returns true if the series is Arm (T2A/C4A/N4A/A4X). */
function isGcpArmSeries(series) {
  if (!series) return false;
  return ARM_SERIES.has(String(series).toLowerCase());
}

/** Returns true if a predefined machine type (e.g., t2a-standard-4) is Arm. */
function isGcpArmMachineType(machineType) {
  if (!machineType) return false;
  const m = String(machineType).toLowerCase().match(/^([a-z0-9]+)-[a-z]+[a-z0-9]*-\d+$/);
  if (!m) return false;
  return isGcpArmSeries(m[1]);
}

/* ============================================================
 * Base price computation (Linux) from unit maps
 * ============================================================ */

/**
 * Given a machine type and a per-series unit map ({ series: {core,ram} }),
 * compute Linux base hourly price:
 *   price = vcpu * core_rate + ramGiB * ram_rate
 *
 * Returns { price, vcpu, ram } (price may be null if incomplete).
 * Optionally accept discoveredRamGiB for M/X families where RAM isn’t guessed.
 */
function computeBaseHourlyFromUnitMaps(machineType, unitMaps, opts = {}) {
  if (!machineType || !unitMaps) return { price: null, vcpu: undefined, ram: undefined };

  let { vcpu, ram } = deriveVcpuRamFromType(machineType);
  if (!Number.isFinite(ram) && Number.isFinite(opts.discoveredRamGiB)) {
    ram = Number(opts.discoveredRamGiB);
  }
  if (!Number.isFinite(vcpu) || !Number.isFinite(ram)) {
    return { price: null, vcpu, ram };
  }

  const series = String(machineType).toLowerCase().split("-")[0];
  const rates = unitMaps[series];
  if (!rates) return { price: null, vcpu, ram };

  const core = Number(rates.core);
  const mem  = Number(rates.ram);
  if (!Number.isFinite(core) || !Number.isFinite(mem)) {
    return { price: null, vcpu, ram };
  }

  const price = (vcpu * core) + (ram * mem);
  return { price, vcpu, ram };
}

/* ============================================================
 * FULL-mode discovery helpers (Compute API via OIDC)
 * ============================================================ */

async function getAccessTokenFromADC() {
  const token =
    process.env.GCLOUD_ACCESS_TOKEN ||
    process.env.GOOGLE_OAUTH_ACCESS_TOKEN || "";
  if (!token) {
    throw new Error("[GCP] No access token found in env. Ensure your workflow passes steps.auth.outputs.access_token to GCLOUD_ACCESS_TOKEN.");
  }
  return token;
}

async function listRegionZones(projectId, region, accessToken) {
  const url = `https://compute.googleapis.com/compute/v1/projects/${projectId}/zones`;
  const zones = [];
  let pageToken = "";
  while (true) {
    const pageUrl = pageToken ? `${url}?pageToken=${encodeURIComponent(pageToken)}` : url;
    const r = await fetch(pageUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`[GCP] zones.list HTTP ${r.status} ${txt}`);
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

async function listZoneMachineTypes(projectId, zone, accessToken) {
  const url = `https://compute.googleapis.com/compute/v1/projects/${projectId}/zones/${zone}/machineTypes`;
  const mts = [];
  let pageToken = "";
  while (true) {
    const pageUrl = pageToken ? `${url}?pageToken=${encodeURIComponent(pageToken)}` : url;
    const r = await fetch(pageUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`[GCP] machineTypes.list HTTP ${r.status} ${txt}`);
    }
    const j = await r.json();
    for (const mt of j.items || []) {
      const name = String(mt.name || "");
      if (/^custom-/i.test(name)) continue; // exclude custom
      if (!/^[a-z0-9]+-[a-z]+[a-z0-9]*-\d+$/i.test(name)) continue; // predefined only
      mts.push({ name, guestCpus: mt.guestCpus, memoryMb: mt.memoryMb });
    }
    if (!j.nextPageToken) break;
    pageToken = j.nextPageToken;
  }
  return mts;
}

/* ============================================================
 * Windows/RHEL hooks (not used for Linux-only run, kept for later)
 * ============================================================ */

const WINDOWS_STANDARD_FALLBACK_RATE =
  Number(process.env.GCP_WINDOWS_RATE_PER_VCPU || 0) || 0.046;

/**
 * Attempt to resolve Windows Server per‑vCPU license rate from Catalog for region.
 * Falls back to env/public rate when not present in tenant.
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

  // Strict
  for (const sku of (allSkus || [])) {
    if (!inRegion(sku)) continue;
    const name = (sku.description || sku.displayName || "").toLowerCase();
    if (!/windows/.test(name)) continue;
    if (!/(license|licensing|core|vcpu)/.test(name)) continue;
    if (BAD.test(name)) continue;
    const price = extractHourlyPrice(sku.pricingInfo);
    if (price && price > 0) candidates.push({ price, name });
  }

  // Relaxed
  if (candidates.length === 0) {
    for (const sku of (allSkus || [])) {
      if (!inRegion(sku)) continue;
      const name = (sku.description || sku.displayName || "").toLowerCase();
      if (!/windows/.test(name)) continue;
      if (BAD.test(name)) continue;
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

// Placeholder for later (RHEL price uplift resolver)
// function buildRhelCoreRate(allSkus, region) { ... }

module.exports = {
  CE_SERVICE_ID,

  // classification & parsing
  classifyGcpInstance,
  extractHourlyPrice,
  inferMachineType,
  deriveVcpuRamFromType,
  regionMatches,
  isPerInstanceSku,
  getGcpAllowedPrefixes,
  GCP_EXAMPLE_INSTANCES,

  // discovery + unit-rate composition
  getAccessTokenFromADC,
  listRegionZones,
  listZoneMachineTypes,
  buildSeriesUnitRateMaps,
  computeBaseHourlyFromUnitMaps,

  // future OS adders
  buildWindowsCoreRate,
  WINDOWS_STANDARD_FALLBACK_RATE,

  // arch helpers
  isGcpArmSeries,
  isGcpArmMachineType
};
