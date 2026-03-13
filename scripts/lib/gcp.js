// scripts/lib/gcp.js
// Helpers for GCP Retail Prices + ResourceSkus enrichment
"use strict";

const CE_SERVICE_ID = "6F81-5844-456A";

/**
 * Family policy across clouds (The "Super-Series" list)
 * We keep these lists to tell the fetcher which series are eligible for each category.
 */
const GCP_SERIES_ALLOW = {
  general: ["C4D", "C4A", "C4", "N4", "N4D", "N4A", "C3", "C3D", "T2D", "T2A", "N2", "N2D", "N1", "E2"],
  compute: ["C2", "C2D", "H3", "H4D"],
  memory:  ["M1", "M2", "M3", "M4", "X4"]
};

const ARM_SERIES = new Set(["t2a", "c4a", "n4a", "a4x"]);

/* ============================================================
 * 1. DYNAMIC MAPPING LOGIC (The Core Fix)
 * ============================================================ */

/**
 * Maps the internal GCP variant name to your 3 UI Families.
 * Mapping: general -> standard, compute -> highcpu, memory -> highmem
 */
function classifyVariantToFamily(variantToken) {
  const v = String(variantToken).toLowerCase();
  if (v.includes("highcpu")) return "compute";
  if (v.includes("highmem") || v.includes("ultramem") || v.includes("megamem")) return "memory";
  return "general"; // Everything else (standard/micro/small) is General
}

/**
 * Parses machine type string (e.g., "n2-highmem-4") into metadata components.
 */
function parseMachineType(mt) {
  if (!mt) return null;
  const parts = String(mt).toLowerCase().split("-");
  if (parts.length < 2) return null;

  const series = parts[0].toUpperCase();
  const vcpu = parseInt(parts[parts.length - 1]);
  
  let variant = "standard";
  if (mt.includes("highmem")) variant = "highmem";
  else if (mt.includes("highcpu")) variant = "highcpu";
  else if (mt.includes("ultramem")) variant = "ultramem";
  else if (mt.includes("megamem")) variant = "megamem";

  return {
    series,
    variant,
    vcpu: isNaN(vcpu) ? null : vcpu,
    family: classifyVariantToFamily(variant)
  };
}

/* ============================================================
 * 2. RHEL & OS CLASSIFICATION
 * ============================================================ */

/**
 * Exact RHEL 2026 pricing tiers.
 * Logic: $0.06 for 1-4 vCPUs, $0.13 for 5+ vCPUs.
 */
function calculateRhelPrice(baseLinuxPrice, vcpu) {
  if (!baseLinuxPrice || !vcpu) return null;
  const uplift = vcpu <= 4 ? 0.06 : 0.13;
  return Number((baseLinuxPrice + uplift).toFixed(4));
}

function classifyOsFromSku(sku) {
  const name = (sku.description || sku.displayName || "").toLowerCase();
  if (/windows/.test(name)) return "Windows";
  if (/rhel|red\s*hat/.test(name)) {
    // Standard RHEL tiers
    if (/sap|ha|update\s*services|extended\s*life/i.test(name)) return "Linux"; 
    return "RHEL";
  }
  return "Linux"; // Covers Ubuntu, CentOS, etc.
}

/* ============================================================
 * 3. WINDOWS CORE RESOLVER (Original Data Logic)
 * ============================================================ */

const WINDOWS_STANDARD_FALLBACK_RATE = Number(process.env.GCP_WINDOWS_RATE_PER_VCPU || 0.046);

function buildWindowsCoreRate(allSkus, region) {
  const candidates = [];
  const BAD = /(byol|ram|memory|gpu|sole\s*tenan|local ssd|persistent disk|commitment|spot|preemptible|sles|rhel|sql)/i;

  for (const sku of (allSkus || [])) {
    if (!regionMatches(sku.serviceRegions, region)) continue;
    const name = (sku.description || sku.displayName || "").toLowerCase();
    if (!/windows/.test(name) || BAD.test(name)) continue;
    
    const price = extractHourlyPrice(sku.pricingInfo);
    if (price && price > 0) candidates.push({ price, name });
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => a.price - b.price);
    return candidates[0].price;
  }
  return WINDOWS_STANDARD_FALLBACK_RATE;
}

/* ============================================================
 * 4. CATALOG & API INFRASTRUCTURE (Required for Full Data)
 * ============================================================ */

function extractHourlyPrice(pricingInfo) {
  for (const p of (pricingInfo || [])) {
    const unit = p?.pricingExpression?.tieredRates?.[0]?.unitPrice;
    if (!unit) continue;
    const price = Number(unit.units || 0) + Number(unit.nanos || 0) / 1e9;
    if (price > 0) return price;
  }
  return null;
}

function regionMatches(serviceRegions, region) {
  const want = String(region || "").toLowerCase();
  const set = new Set((serviceRegions || []).map(r => String(r).toLowerCase()));
  return set.has(want) || set.has("global") || (want.startsWith("us-") && set.has("us"));
}

function classifyGcpInstance(instanceName) {
  const info = parseMachineType(instanceName);
  if (!info) return null;
  const allowed = GCP_SERIES_ALLOW[info.family] || [];
  return allowed.includes(info.series) ? info.family : null;
}

/* ============================================================
 * 5. COMPUTE API (FOR FULL DYNAMIC SCANNING)
 * ============================================================ */

async function listRegionZones(projectId, region, accessToken) {
  const url = `https://compute.googleapis.com/compute/v1/projects/${projectId}/zones`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const j = await r.json();
  return (j.items || []).filter(z => z.name.startsWith(region.toLowerCase())).map(z => z.name);
}

async function listZoneMachineTypes(projectId, zone, accessToken) {
  const url = `https://compute.googleapis.com/compute/v1/projects/${projectId}/zones/${zone}/machineTypes`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const j = await r.json();
  return (j.items || []).map(mt => ({ name: mt.name, guestCpus: mt.guestCpus, memoryMb: mt.memoryMb }));
}

module.exports = {
  CE_SERVICE_ID,
  GCP_SERIES_ALLOW,
  parseMachineType,
  calculateRhelPrice,
  classifyVariantToFamily,
  classifyGcpInstance,
  classifyOsFromSku,
  extractHourlyPrice,
  buildWindowsCoreRate,
  WINDOWS_STANDARD_FALLBACK_RATE,
  regionMatches,
  listRegionZones,
  listZoneMachineTypes,
  normalizeMachineTypeDisplay: (name) => name ? String(name).replace(/_/g, "-") : ""
};
