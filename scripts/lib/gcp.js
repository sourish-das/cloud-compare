// scripts/lib/gcp.js
// Helpers for GCP Retail Prices + Compute discovery (Linux-first)
// CommonJS (Node 18+, global fetch)
// Version: 2.3.0
//  - extractHourlyPrice: TIME-ONLY normalization (no quantity handling)
//  - parseSeriesUnitRate: CPU/RAM unit SKUs normalized to *per 1 unit* using displayQuantity
'use strict';

// Compute Engine service id for Catalog Retail Prices API
const CE_SERVICE_ID = '6F81-5844-456A';

// UI helpers (exported for completeness; not used for pricing logic)
const GCP_SERIES_ALLOW = {
  general: ['E2', 'N1', 'N2', 'N2D', 'N4', 'N4A', 'N4D', 'T2A', 'T2D'],
  compute: ['C2', 'C2D', 'C3', 'C3D', 'C4', 'C4D', 'C4A', 'H3', 'H4', 'H4D'],
  memory:  ['M1', 'M2', 'M3', 'M4', 'X4']
};

const ARM_SERIES = new Set(['t2a', 'c4a', 'n4a']);

const GCP_EXAMPLE_INSTANCES = {
  general: ['e2-standard-2', 'n2-standard-4', 't2a-standard-4', 'n4-standard-4'],
  compute: ['c2-standard-4', 'c3-standard-4', 'c4-standard-4', 'n2-highcpu-4', 'e2-highcpu-8'],
  memory:  ['m1-ultramem-40', 'm2-ultramem-208', 'm3-megamem-64', 'n2-highmem-8', 'e2-highmem-4']
};

// ---------------------------
// Instance parsing helpers
// ---------------------------
function inferMachineType(sku) {
  const attrs = (sku && sku.attributes) || {};
  if (attrs.machineType) {
    const mt = String(attrs.machineType).toLowerCase();
    if (/^custom-/.test(mt)) return null;
    return mt;
  }
  const s = String((sku && (sku.description || sku.displayName)) || '').toLowerCase();
  // {series}-{class}-{vcpu}
  const re = /\b(m1|m2|m3|m4|x4|h4d|h4|h3|c2d|c2|c3d|c3|c4d|c4a|c4|n4d|n4a|n4|n2d|n2|n1|e2|t2a|t2d)-(standard|highmem|highcpu|ultramem|megamem)-(\d+)\b/;
  const m = s.match(re);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

// ---------------------------
// Time-only normalization to $/hour
// ---------------------------
function extractHourlyPrice(pricingInfo) {
  for (const p of (pricingInfo || [])) {
    const pe = p && p.pricingExpression;
    if (!pe) continue;

    const tr0 = pe.tieredRates && pe.tieredRates[0];
    const rate = tr0 && tr0.unitPrice;
    if (!rate) continue;

    let money = Number(rate.units || 0) + Number(rate.nanos || 0) / 1e9;
    if (!(money > 0)) continue;

    const usage = String(pe.usageUnit || '').toLowerCase();
    const base  = String(pe.baseUnit  || '').toLowerCase();
    const k     = Number(pe.baseUnitConversionFactor || 1);

    // Convert to hourly
    if (usage === 'h' || usage === 'hour' || usage === 'hours') return money;
    if (usage === 's' || usage === 'sec' || usage === 'second' || usage === 'seconds') return money * 3600;
    if (usage === 'min' || usage === 'minute' || usage === 'minutes') return money * 60;
    if (base  === 's'  || base  === 'sec'  || base  === 'second'  || base  === 'seconds') return money * (k > 0 ? k : 3600);

    // Fallback: assume hourly already
    return money;
  }
  return null;
}

// ---------------------------
// vCPU/RAM derivation from machineType token
// ---------------------------
function deriveVcpuRamFromType(mt) {
  if (!mt) return { vcpu: undefined, ram: undefined };
  if (/^custom-/.test(mt)) return { vcpu: undefined, ram: undefined };

  const m = String(mt).match(/^(m1|m2|m3|m4|x4|h4d|h4|h3|c2d|c2|c3d|c3|c4d|c4a|c4|n4d|n4a|n4|n2d|n2|n1|e2|t2a|t2d)-(standard|highmem|highcpu|ultramem|megamem)-(\d+)$/i);
  if (!m) return { vcpu: undefined, ram: undefined };

  const series = m[1].toLowerCase();
  const cls    = m[2].toLowerCase();
  const vcpu   = Number(m[3]);
  if (!vcpu) return { vcpu: undefined, ram: undefined };

  // For M*/X* families leave RAM undefined; we’ll feed discovered RAM if available.
  if (series.startsWith('m') || series.startsWith('x')) return { vcpu, ram: undefined };

  if (cls.startsWith('standard')) return { vcpu, ram: vcpu * 4 };
  if (cls.startsWith('highmem'))  return { vcpu, ram: vcpu * 8 };
  if (cls.startsWith('highcpu'))  return { vcpu, ram: series.startsWith('n1') ? vcpu * 0.9 : vcpu * 2 };

  return { vcpu, ram: undefined };
}

// ---------------------------
// Region matching
// ---------------------------
function regionMatches(serviceRegions, region) {
  const want = String(region || '').toLowerCase();
  const set = new Set((serviceRegions || []).map(r => String(r).toLowerCase()));
  if (set.has(want)) return true;
  if (set.has('global')) return true;
  if (want.startsWith('us-') && set.has('us')) return true;
  return false;
}

// ---------------------------
// Detect true per-instance SKUs
// ---------------------------
function isPerInstanceSku(sku, machineType) {
  const name = String((sku && (sku.description || sku.displayName)) || '');
  if (!machineType) return false;
  if (/^custom-/.test(machineType)) return false;
  if (/(\bCore\b|\bvCPU\b|\bRam\b|\bMemory\b|Sole\s*Tenancy|Sole\s*Tenant)/i.test(name)) return false;
  const hasInstanceNoun = /(\bInstance\b|\bVM\b)/i.test(name);
  const includesType = name.toLowerCase().includes(String(machineType).toLowerCase());
  return hasInstanceNoun && includesType;
}

// ---------------------------
// SKU parsing for CPU/RAM unit rates
// ---------------------------

// Helper: pick the first pricingExpression that actually has a rate
function firstPricingExpressionWithRate(sku) {
  for (const p of (sku.pricingInfo || [])) {
    const pe = p && p.pricingExpression;
    const tr0 = pe && pe.tieredRates && pe.tieredRates[0];
    if (tr0 && tr0.unitPrice) return pe;
  }
  return null;
}

function parseSeriesUnitRate(sku) {
  const cat = (sku && sku.category) || {};
  // Only Compute, OnDemand, and CPU/RAM or descriptions that clearly imply core/ram
  if (cat.resourceFamily !== 'Compute') return null;
  if (cat.usageType && !/OnDemand/i.test(cat.usageType)) return null;

  const name = String((sku.description || sku.displayName) || '').toLowerCase();

  // Decide 'kind' using resourceGroup first (case-insensitive), then fallback to description
  let kind = null;
  const rg = String(cat.resourceGroup || '').toLowerCase();
  if (rg === 'cpu') kind = 'core';
  else if (rg === 'ram') kind = 'ram';
  else {
    if (/\b(vcpu|core)\b/.test(name)) kind = 'core';
    else if (/\b(ram|memory|gib)\b/.test(name)) kind = 'ram';
    else return null;
  }

  // Extract series token (covers c4d/c4a/n4d/c3d/c2d/t2d etc.)
  const mSeries = name.match(/\b(m1|m2|m3|m4|x4|h4d|h4|h3|n1|n2d|n2|n4|n4a|n4d|e2|t2a|t2d|c2d|c3d|c3|c4d|c4|c4a|c2)\b/i);
  if (!mSeries) return null;
  const series = mSeries[1].toLowerCase();

  // Hourly price from Catalog (time-normalized only)
  const pricePerHour = extractHourlyPrice(sku.pricingInfo);
  if (!(pricePerHour > 0)) return null;

  // ---- per-unit quantity normalization ----
  // Certain CPU/RAM unit SKUs are priced for a block of units (e.g., "per 10 vCPU").
  // The block size is encoded in pricingExpression.displayQuantity for those SKUs.
  // Convert to price per *single* unit by dividing by that quantity.
  let unitsPerPrice = 1;
  const pe = firstPricingExpressionWithRate(sku);
  if (pe && Number(pe.displayQuantity || 0) > 0) {
    unitsPerPrice = Number(pe.displayQuantity);
  } else {
    // Conservative fallback: look for "per 10 vcpu"/"per 10 gib" in description
    const mQ = name.match(/\b(per|for)\s+(\d+)\s*(vcpu|core|cores|gib|gb|ram|memory)\b/);
    if (mQ) {
      const n = Number(mQ[2]);
      if (n > 0 && n <= 512) unitsPerPrice = n;
    }
  }

  const unitPrice = pricePerHour / (unitsPerPrice > 0 ? unitsPerPrice : 1);
  if (!(unitPrice > 0)) return null;

  return { series, kind, price: unitPrice };
}

function buildSeriesUnitRateMaps(allSkus, region) {
  const bySeriesKind = {};
  const want = String(region || '').toLowerCase();
  const scopeOf = (sku) => {
    const set = new Set((sku.serviceRegions || []).map(s => String(s).toLowerCase()));
    if (set.has(want)) return 'exact';
    if (want.startsWith('us-') && set.has('us')) return 'us';
    if (set.has('global')) return 'global';
    return null;
  };

  for (const sku of (allSkus || [])) {
    const cat = (sku && sku.category) || {};
    if (cat.resourceFamily !== 'Compute') continue;
    if (cat.usageType && !/OnDemand/i.test(cat.usageType)) continue;

    const scope = scopeOf(sku);
    if (!scope) continue;

    const info = parseSeriesUnitRate(sku);
    if (!info) continue;

    const { series, kind, price } = info;
    if (!bySeriesKind[series]) bySeriesKind[series] = { core: {}, ram: {} };

    const cur = bySeriesKind[series][kind][scope];
    if (!(cur > 0) || price < cur) bySeriesKind[series][kind][scope] = price;
  }

  const out = {};
  for (const [series, kinds] of Object.entries(bySeriesKind)) {
    const core = kinds.core.exact ?? kinds.core.us ?? kinds.core.global;
    const ram  = kinds.ram.exact  ?? kinds.ram.us  ?? kinds.ram.global;
    if (core > 0 && ram > 0) out[series] = { core, ram };
  }
  return out;
}

// ---------------------------
// Classification helpers
// ---------------------------
function classifyGcpInstance(instance) {
  if (!instance) return null;
  const raw = String(instance).trim();
  if (!raw || /^custom-/i.test(raw)) return null;
  const T = raw.toUpperCase();
  const m = T.match(/^[A-Z0-9]+-(STANDARD|HIGHCPU|HIGHMEM|ULTRAMEM|MEGAMEM)-(\d+)$/);
  if (!m) return null;
  const cls = m[1];
  if (cls === 'STANDARD') return 'general';
  if (cls === 'HIGHCPU')  return 'compute';
  return 'memory';
}

function getGcpAllowedPrefixes(category) {
  return (GCP_SERIES_ALLOW[category] || []).map(s => s.toUpperCase());
}

// ---------------------------
// Compose base price from unit maps
// ---------------------------
function computeBaseHourlyFromUnitMaps(machineType, unitMaps, opts = {}) {
  if (!machineType || !unitMaps) return { price: null, vcpu: undefined, ram: undefined };
  let { vcpu, ram } = deriveVcpuRamFromType(machineType);
  if (!Number.isFinite(ram) && Number.isFinite(opts.discoveredRamGiB)) {
    ram = Number(opts.discoveredRamGiB);
  }
  if (!Number.isFinite(vcpu) || !Number.isFinite(ram)) return { price: null, vcpu, ram };
  const series = String(machineType).toLowerCase().split('-')[0];
  const rates = unitMaps[series];
  if (!rates) return { price: null, vcpu, ram };
  const corePrice = Number(rates.core);
  const ramPrice  = Number(rates.ram);
  if (!Number.isFinite(corePrice) || !Number.isFinite(ramPrice)) return { price: null, vcpu, ram };
  const totalPrice = (vcpu * corePrice) + (ram * ramPrice);
  return { price: totalPrice, vcpu, ram };
}

// ---------------------------
// ADC helpers for discovery
// ---------------------------
async function getAccessTokenFromADC() {
  const token = process.env.GCLOUD_ACCESS_TOKEN || process.env.GOOGLE_OAUTH_ACCESS_TOKEN || '';
  if (!token) throw new Error('[GCP] No access token found in environment. Provide GCLOUD_ACCESS_TOKEN.');
  return token;
}

async function listRegionZones(projectId, region, accessToken) {
  const url = `https://compute.googleapis.com/compute/v1/projects/${projectId}/zones`;
  const zones = [];
  let pageToken = '';
  while (true) {
    const pageUrl = pageToken ? `${url}?pageToken=${encodeURIComponent(pageToken)}` : url;
    const r = await fetch(pageUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`[GCP] zones.list HTTP ${r.status}: ${txt}`);
    }
    const j = await r.json();
    for (const z of (j.items || [])) {
      const name = String(z.name || '').toLowerCase();
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
  let pageToken = '';
  while (true) {
    const pageUrl = pageToken ? `${url}?pageToken=${encodeURIComponent(pageToken)}` : url;
    const r = await fetch(pageUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`[GCP] machineTypes.list HTTP ${r.status}: ${txt}`);
    }
    const j = await r.json();
    for (const mt of (j.items || [])) {
      const name = String(mt.name || '');
      if (/^custom-/i.test(name)) continue;
      const okName =
        /^[a-z0-9]+-[a-z]+[a-z0-9]*-\d+$/i.test(name) ||
        /^[a-z0-9]+-[a-z]+[a-z0-9]*-[a-z]+-\d+$/i.test(name);
      if (!okName) continue;
      mts.push({ name, guestCpus: mt.guestCpus, memoryMb: mt.memoryMb });
    }
    if (!j.nextPageToken) break;
    pageToken = j.nextPageToken;
  }
  return mts;
}

// ---------------------------
// Windows uplift discovery (unchanged)
// ---------------------------
const WINDOWS_STANDARD_FALLBACK_RATE = Number(process.env.GCP_WINDOWS_RATE_PER_VCPU || 0) || 0.046;

function buildWindowsCoreRate(allSkus, region) {
  const inRegion = (sku) => {
    const cat = (sku && sku.category) || {};
    if (cat.resourceFamily !== 'Compute') return false;
    if (cat.usageType && !/OnDemand/i.test(cat.usageType)) return false;
    return regionMatches(sku.serviceRegions, region);
  };
  const BAD = /(byol|ram|memory|gpu|local\s*ssd|commitment|spot|preemptible|sles|rhel|sql|windows\s*(7|8|10|11))/i;
  const candidates = [];
  for (const sku of (allSkus || [])) {
    if (!inRegion(sku)) continue;
    const name = String((sku.description || sku.displayName) || '').toLowerCase();
    if (!/windows/.test(name)) continue;
    if (!/(license|licensing|core|vcpu)/.test(name)) continue;
    if (BAD.test(name)) continue;
    const price = extractHourlyPrice(sku.pricingInfo);
    if (price && price > 0) candidates.push({ price, name });
  }
  if (candidates.length === 0) {
    for (const sku of (allSkus || [])) {
      if (!inRegion(sku)) continue;
      const name = String((sku.description || sku.displayName) || '').toLowerCase();
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

// ---------------------------
// Arch helpers
// ---------------------------
function isGcpArmSeries(series) { return series ? ARM_SERIES.has(String(series).toLowerCase()) : false; }
function isGcpArmMachineType(machineType) {
  if (!machineType) return false;
  const m = String(machineType).toLowerCase().match(/^([a-z0-9]+)-[a-z]+[a-z0-9]*-\d+$/);
  if (!m) return false;
  return isGcpArmSeries(m[1]);
}

// ---------------------------
// Exports
// ---------------------------
module.exports = {
  CE_SERVICE_ID,
  classifyGcpInstance,
  getGcpAllowedPrefixes,
  GCP_EXAMPLE_INSTANCES,
  GCP_SERIES_ALLOW,
  extractHourlyPrice,
  inferMachineType,
  deriveVcpuRamFromType,
  regionMatches,
  isPerInstanceSku,
  getAccessTokenFromADC,
  listRegionZones,
  listZoneMachineTypes,
  buildSeriesUnitRateMaps,
  computeBaseHourlyFromUnitMaps,
  buildWindowsCoreRate,
  WINDOWS_STANDARD_FALLBACK_RATE,
  isGcpArmSeries,
  isGcpArmMachineType
};
