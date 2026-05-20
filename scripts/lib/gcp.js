// scripts/lib/gcp.js
// Helpers for GCP Retail Prices + RHEL/Windows synthesis

'use strict';

// Compute Engine service id for Catalog Retail Prices API
const CE_SERVICE_ID = '6F81-5844-456A';

// UI allow-lists (exported for completeness; not used by pricing logic)
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

// Accept ANY series token, but only known class suffixes.
const MT_RE_IN_TEXT = /\b([a-z0-9]+)-(standard|highcpu|highmem|ultramem|megamem|hypermem)-(\d+)\b/i;

function inferMachineType(sku) {
  const attrs = (sku && sku.attributes) || {};
  if (attrs.machineType) {
    const mt = String(attrs.machineType).toLowerCase();
    if (/^custom-/.test(mt)) return null;
    return mt;
  }

  const s = String((sku && (sku.description || sku.displayName)) || '').toLowerCase();
  const m = s.match(MT_RE_IN_TEXT);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`.toLowerCase();
}

// ---------------------------
// Time normalization to $/hour
// ---------------------------
function extractHourlyPrice(pricingInfo) {
  for (const p of (pricingInfo || [])) {
    const pe = p && p.pricingExpression;
    if (!pe) continue;

    let tr = null;
    if (Array.isArray(pe.tieredRates) && pe.tieredRates.length) {
      tr = pe.tieredRates.find(t => Number(t.startUsageAmount || 0) === 0) || pe.tieredRates[0];
    }
    const rate = tr && tr.unitPrice;
    if (!rate) continue;

    const money = Number(rate.units || 0) + Number(rate.nanos || 0) / 1e9;
    if (!(money > 0)) continue;

    const usage = String(pe.usageUnit || '').toLowerCase();
    const base  = String(pe.baseUnit  || '').toLowerCase();
    const k     = Number(pe.baseUnitConversionFactor || 1);

    if (usage === 'h' || usage === 'hour' || usage === 'hours') return money;
    if (usage === 's' || usage === 'sec' || usage === 'second' || usage === 'seconds') return money * 3600;
    if (usage === 'min' || usage === 'minute' || usage === 'minutes') return money * 60;
    if (base  === 's' || base  === 'sec' || base  === 'second' || base  === 'seconds') return money * (k > 0 ? k : 3600);

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

  const m = String(mt).toLowerCase().match(/^([a-z0-9]+)-(standard|highcpu|highmem|ultramem|megamem|hypermem)-(\d+)$/i);
  if (!m) return { vcpu: undefined, ram: undefined };

  const series = m[1].toLowerCase();
  const cls    = m[2].toLowerCase();
  const vcpu   = Number(m[3]);
  if (!vcpu) return { vcpu: undefined, ram: undefined };

  // For M*/X* families leave RAM undefined; discovery provides exact RAM.
  if (series.startsWith('m') || series.startsWith('x')) return { vcpu, ram: undefined };

  if (cls === 'standard') return { vcpu, ram: vcpu * 4 };
  if (cls === 'highmem')  return { vcpu, ram: vcpu * 8 };
  if (cls === 'hypermem') return { vcpu, ram: vcpu * 8 };
  if (cls === 'highcpu')  return { vcpu, ram: series.startsWith('n1') ? vcpu * 0.9 : vcpu * 2 };

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
// Detect per-instance SKUs (kept, even if some feeds have mtAttrCount=0)
// ---------------------------
function isPerInstanceSku(sku, machineType) {
  if (!machineType || /^custom-/i.test(machineType)) return false;

  const rg = sku?.category?.resourceGroup;
  if (rg === 'CPU' || rg === 'RAM' || rg === 'GPU') return false;

  const mtAttr = sku?.attributes?.machineType;
  if (mtAttr && String(mtAttr).toLowerCase() === String(machineType).toLowerCase()) return true;

  const txt = String(sku?.description || sku?.displayName || '').toLowerCase();
  const mt = String(machineType).toLowerCase();
  if (txt.includes(mt)) return true;

  const parts = mt.split('-');
  if (parts.length >= 3) {
    const [series, cls, size] = parts;
    if (txt.includes(series) && txt.includes(size)) {
      if (cls === 'standard' && txt.includes('standard')) return true;
      if (cls === 'highcpu'  && txt.includes('highcpu'))  return true;
      if (cls === 'highmem'  && txt.includes('highmem'))  return true;
      if (cls === 'megamem'  && txt.includes('megamem'))  return true;
      if (cls === 'ultramem' && txt.includes('ultramem')) return true;
      if (cls === 'hypermem' && txt.includes('hypermem')) return true;
    }
  }
  return false;
}

// ---------------------------
// SKU parsing helpers (optional)
// ---------------------------
function firstPricingExpressionWithRate(sku) {
  for (const p of (sku.pricingInfo || [])) {
    const pe = p && p.pricingExpression;
    if (!pe) continue;
    const tr0 = Array.isArray(pe.tieredRates) && pe.tieredRates[0];
    if (tr0 && tr0.unitPrice) return pe;
  }
  return null;
}

// ---------------------------
// Unit-rate extraction: per 1 vCPU-hour and per 1 GiB-hour (Linux base)
// ---------------------------
function buildSeriesUnitRateMaps(allSkus, region) {
  const out = {};
  const want = String(region || '').toLowerCase();

  const inRegion = (sku) => {
    const sr = new Set((sku.serviceRegions || []).map(s => String(s).toLowerCase()));
    return sr.has(want) || (want.startsWith('us-') && sr.has('us')) || sr.has('global');
  };

  const median = (arr) => {
    const a = (arr || []).filter(Number.isFinite).sort((x, y) => x - y);
    if (!a.length) return null;
    const mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  };

  const hourlyFromExpr = (pricingInfo) => {
    const expr = pricingInfo?.[0]?.pricingExpression;
    if (!expr?.tieredRates?.length) return { hr: 0, expr: null };

    const base = expr.tieredRates.find(t => Number(t.startUsageAmount || 0) === 0) || expr.tieredRates[0];
    const units = Number(base?.unitPrice?.units || 0);
    const nanos = Number(base?.unitPrice?.nanos || 0);
    const money = units + nanos / 1e9;

    const usage = String(expr.usageUnit || '').toLowerCase();
    const baseU = String(expr.baseUnit || '').toLowerCase();
    const k = Number(expr.baseUnitConversionFactor || 1);

    if (usage === 'h' || usage === 'hour' || usage === 'hours') return { hr: money, expr };
    if (usage === 's' || usage === 'sec' || usage === 'second' || usage === 'seconds') return { hr: money * 3600, expr };
    if (usage === 'min' || usage === 'minute' || usage === 'minutes') return { hr: money * 60, expr };
    if (baseU === 's' || baseU === 'sec' || baseU === 'second' || baseU === 'seconds') return { hr: money * (k > 0 ? k : 3600), expr };
    return { hr: money, expr };
  };

  const inferSeriesFromText = (text) => {
    const s = String(text || '').toLowerCase();
    const toks = [...s.matchAll(/\b([a-z][0-9][a-z0-9]{0,2})\b/g)].map(m => m[1]);
    if (!toks.length) return null;
    toks.sort((a, b) => b.length - a.length);
    const BAD = new Set(['v1', 'v2', 'g1', 's1']);
    for (const t of toks) if (!BAD.has(t)) return t;
    return null;
  };

  const detectUnitsPerPrice = (sku, expr, rg) => {
    const txt = `${sku.description || ''} ${sku.displayName || ''} ${sku.summary || ''}`.toLowerCase();

    // explicit "per 10 vcpu" etc.
    const m = txt.match(/\b(?:per|for)(?:\s*block\s*of)?\s*-?\s*(\d+)\s*(vcpu|core|cores|gb|gib|ram|memory)\b/);
    if (m) {
      const n = Number(m[1]);
      if (n > 0 && n <= 1024) {
        if (rg === 'CPU' && /\b(vcpu|core|cores)\b/.test(m[2])) return n;
        if (rg === 'RAM' && /\b(gb|gib|ram|memory)\b/.test(m[2])) return n;
      }
    }

    // displayQuantity only if supported by text (prevents 10× underpricing)
    const dq = Number(expr?.displayQuantity || 0);
    if (dq > 1) {
      const ok =
        txt.includes(`per ${dq}`) ||
        new RegExp(`\\b${dq}\\s*(vcpu|core|cores|gb|gib|ram|memory)\\b`).test(txt);
      if (ok) return dq;
    }

    return 1;
  };

  const buckets = {}; // { series: { cpu: [], ram: [] } }

  for (const sku of (allSkus || [])) {
    try {
      if (!sku || !inRegion(sku)) continue;

      const usageType = String(sku.category?.usageType || '');
      if (!/ondemand/i.test(usageType)) continue;

      const rg = sku.category?.resourceGroup;
      if (rg !== 'CPU' && rg !== 'RAM') continue;

      // Linux base only (exclude OS uplift SKUs)
      const plain = `${sku.description || ''} ${sku.summary || ''}`.toLowerCase();
      if (/windows|sql server|rhel|red hat|suse|sles|sap/i.test(plain)) continue;

      // Exclude noisy variants from unit-rate base
      const blob = `${sku.description || ''} ${sku.displayName || ''} ${sku.summary || ''}`.toLowerCase();
      if (/spot|preemptible|commit|commitment|reserved|cud|sole\s*tenant|sole\s*tenancy/i.test(blob)) continue;

      // Series
      let series = null;
      const mt = inferMachineType(sku);
      if (mt) series = mt.split('-')[0].toLowerCase();
      if (!series) series = inferSeriesFromText(blob);

      // Short-token fallback (fixes missing n1/c2/m1/m2)
      if (!series) {
        const m2 = blob.match(/\b(n1|c2|m1|m2)\b/i);
        if (m2) series = m2[1].toLowerCase();
      }

      if (!series) continue;

      const { hr, expr } = hourlyFromExpr(sku.pricingInfo);
      if (!(hr > 0)) continue;

      const block = detectUnitsPerPrice(sku, expr, rg);
      const perUnit = hr / (block > 0 ? block : 1);
      if (!(perUnit > 0)) continue;

      buckets[series] ??= { cpu: [], ram: [] };
      if (rg === 'CPU') buckets[series].cpu.push(perUnit);
      else buckets[series].ram.push(perUnit);
    } catch {
      // ignore bad SKU
    }
  }

  for (const [series, b] of Object.entries(buckets)) {
    const core = median(b.cpu);
    const ram = median(b.ram);
    if (core > 0 && ram > 0) out[series] = { core, ram };
  }

  return out;
}

// ---------------------------
// Classification helpers (suffix only)
// ---------------------------
function classifyGcpInstance(instance) {
  if (!instance) return null;
  const raw = String(instance).trim();
  if (!raw || /^custom-/i.test(raw)) return null;

  const m = raw.toLowerCase().match(/^([a-z0-9]+)-(standard|highcpu|highmem|ultramem|megamem|hypermem)-(\d+)$/);
  if (!m) return null;

  const cls = m[2];
  if (cls === 'standard') return 'general';
  if (cls === 'highcpu') return 'compute';
  return 'memory';
}

function getGcpAllowedPrefixes(category) {
  return (GCP_SERIES_ALLOW[category] || []).map(s => s.toUpperCase());
}

// ---------------------------
// Compose base price from unit maps (Linux base)
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
// Windows uplift discovery (per vCPU-hour)
// ---------------------------
// Your examples show ~0.048 $/vCPU-hr for Windows; keep env override.
const WINDOWS_STANDARD_FALLBACK_RATE =
  Number(process.env.GCP_WINDOWS_RATE_PER_VCPU || 0) || 0.048;

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
// RHEL uplift discovery (per vCPU-hour) (NEW)
// ---------------------------
// Your examples show ~0.026 $/vCPU-hr for RHEL; keep env override.
const RHEL_STANDARD_FALLBACK_RATE =
  Number(process.env.GCP_RHEL_RATE_PER_VCPU || 0) || 0.026;

function buildRhelCoreRate(allSkus, region) {
  const inRegion = (sku) => {
    const cat = (sku && sku.category) || {};
    if (cat.resourceFamily !== 'Compute') return false;
    if (cat.usageType && !/OnDemand/i.test(cat.usageType)) return false;
    return regionMatches(sku.serviceRegions, region);
  };

  const BAD = /(byol|gpu|local\s*ssd|commitment|spot|preemptible|sles|suse|sql|windows)/i;
  const candidates = [];

  // Prefer explicit license/core/vcpu SKUs
  for (const sku of (allSkus || [])) {
    if (!inRegion(sku)) continue;
    const name = String((sku.description || sku.displayName) || '').toLowerCase();
    if (!/(rhel|red hat)/.test(name)) continue;
    if (!/(license|licensing|core|vcpu)/.test(name)) continue;
    if (BAD.test(name)) continue;

    const price = extractHourlyPrice(sku.pricingInfo);
    if (price && price > 0) candidates.push({ price, name });
  }

  // Looser fallback (still filtered)
  if (!candidates.length) {
    for (const sku of (allSkus || [])) {
      if (!inRegion(sku)) continue;
      const name = String((sku.description || sku.displayName) || '').toLowerCase();
      if (!/(rhel|red hat)/.test(name) || BAD.test(name)) continue;

      const price = extractHourlyPrice(sku.pricingInfo);
      if (price && price > 0) candidates.push({ price, name });
    }
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => a.price - b.price);
    return candidates[0].price;
  }

  return RHEL_STANDARD_FALLBACK_RATE;
}

// ---------------------------
// Arch helpers
// ---------------------------
function isGcpArmSeries(series) {
  return series ? ARM_SERIES.has(String(series).toLowerCase()) : false;
}

function isGcpArmMachineType(machineType) {
  if (!machineType) return false;
  const m = String(machineType).toLowerCase().match(/^([a-z0-9]+)-/);
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
  firstPricingExpressionWithRate,
  buildSeriesUnitRateMaps,
  computeBaseHourlyFromUnitMaps,
  getAccessTokenFromADC,
  listRegionZones,
  listZoneMachineTypes,
  buildWindowsCoreRate,
  WINDOWS_STANDARD_FALLBACK_RATE,
  buildRhelCoreRate,
  RHEL_STANDARD_FALLBACK_RATE,
  isGcpArmSeries,
  isGcpArmMachineType
};
