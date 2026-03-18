'use strict'; 

// Compute Engine service id
const CE_SERVICE_ID = '6F81-5844-456A';

// ---------------------------
// Helpers
// ---------------------------

const HOUR_UNITS = new Set(['h', 'hour', 'hours']);
const SEC_UNITS = new Set(['s', 'sec', 'second', 'seconds']);
const MIN_UNITS = new Set(['min', 'minute', 'minutes']);

// Normalize to $/hour (time only)
function extractHourlyPrice(pricingInfo) {
  for (const p of (pricingInfo || [])) {
    const pe = p?.pricingExpression;
    if (!pe) continue;

    const rate = pe?.tieredRates?.[0]?.unitPrice;
    if (!rate) continue;

    const money =
      Number(rate.units || 0) +
      Number(rate.nanos || 0) / 1e9;

    if (!(money > 0)) continue;

    const usage = (pe.usageUnit || '').toLowerCase();
    const base = (pe.baseUnit || '').toLowerCase();

    if (HOUR_UNITS.has(usage)) return money;
    if (SEC_UNITS.has(usage)) return money * 3600;
    if (MIN_UNITS.has(usage)) return money * 60;

    // fallback only if usage missing
    if (!usage && SEC_UNITS.has(base)) return money * 3600;

    return money;
  }
  return null;
}

// ---------------------------
// Machine parsing
// ---------------------------

function deriveVcpuRamFromType(mt) {
  if (!mt || /^custom-/.test(mt)) {
    return { vcpu: undefined, ram: undefined };
  }

  const m = mt.match(/^[a-z0-9]+-(standard|highmem|highcpu)-(\d+)$/i);
  if (!m) return { vcpu: undefined, ram: undefined };

  const cls = m[1].toLowerCase();
  const vcpu = Number(m[2]);

  if (!vcpu) return { vcpu: undefined, ram: undefined };

  if (cls === 'standard') return { vcpu, ram: vcpu * 4 };
  if (cls === 'highmem') return { vcpu, ram: vcpu * 8 };
  if (cls === 'highcpu') return { vcpu, ram: vcpu * 1 }; // FIXED

  return { vcpu, ram: undefined };
}

// ---------------------------
// Region matching
// ---------------------------

function regionMatches(serviceRegions, region) {
  const want = (region || '').toLowerCase();
  const set = new Set((serviceRegions || []).map(r => r.toLowerCase()));

  if (set.has(want)) return true;
  if (set.has('global')) return true;
  if (want.startsWith('us-') && set.has('us')) return true;

  return false;
}

// ---------------------------
// SKU Parsing
// ---------------------------

function firstPricingExpressionWithRate(sku) {
  for (const p of (sku.pricingInfo || [])) {
    const pe = p?.pricingExpression;
    if (pe?.tieredRates?.[0]?.unitPrice) return pe;
  }
  return null;
}

function parseSeriesUnitRate(sku) {
  const cat = sku?.category;
  if (!cat) return null;

  if (cat.resourceFamily !== 'Compute') return null;
  if (cat.usageType && !/OnDemand/i.test(cat.usageType)) return null;

  const name = (sku.description || sku.displayName || '').toLowerCase();

  let kind = null;
  if (cat.resourceGroup === 'CPU') kind = 'core';
  else if (cat.resourceGroup === 'RAM') kind = 'ram';
  else {
    if (/\b(vcpu|core)\b/.test(name)) kind = 'core';
    else if (/\b(ram|memory|gib)\b/.test(name)) kind = 'ram';
    else return null;
  }

  const mSeries = name.match(/\b(e2|n1|n2|n2d|n4|n4a|c2|c3|c4|m1|m2|m3|t2a)\b/);
  if (!mSeries) return null;

  const series = mSeries[1];

  const pricePerHour = extractHourlyPrice(sku.pricingInfo);
  if (!(pricePerHour > 0)) return null;

  // ---- displayQuantity normalization ----
  let unitsPerPrice = 1;

  const pe = firstPricingExpressionWithRate(sku);
  if (pe?.displayQuantity > 0 && pe.displayQuantity <= 64) {
    unitsPerPrice = Number(pe.displayQuantity);
  } else {
    const mQ = name.match(/\b(per|for)\s+(\d+)\s*(vcpu|core|gib|gb)\b/);
    if (mQ) {
      const n = Number(mQ[2]);
      if (n > 0 && n <= 64) unitsPerPrice = n;
    }
  }

  const unitPrice = pricePerHour / unitsPerPrice;
  if (!(unitPrice > 0)) return null;

  return { series, kind, price: unitPrice };
}

// ---------------------------
// Build pricing map
// ---------------------------

function buildSeriesUnitRateMaps(allSkus, region) {
  const bySeries = {};
  const want = (region || '').toLowerCase();

  const scopeOf = (sku) => {
    const set = new Set((sku.serviceRegions || []).map(s => s.toLowerCase()));
    if (set.has(want)) return 'exact';
    if (want.startsWith('us-') && set.has('us')) return 'us';
    if (set.has('global')) return 'global';
    return null;
  };

  for (const sku of (allSkus || [])) {
    const scope = scopeOf(sku);
    if (!scope) continue;

    const info = parseSeriesUnitRate(sku);
    if (!info) continue;

    const { series, kind, price } = info;

    if (!bySeries[series]) {
      bySeries[series] = { core: {}, ram: {} };
    }

    const cur = bySeries[series][kind][scope];
    if (cur == null || price < cur) {
      bySeries[series][kind][scope] = price;
    }
  }

  const out = {};

  for (const [series, kinds] of Object.entries(bySeries)) {
    const core = kinds.core.exact ?? kinds.core.us ?? kinds.core.global;
    const ram = kinds.ram.exact ?? kinds.ram.us ?? kinds.ram.global;

    if (core > 0 && ram > 0) {
      out[series] = { core, ram };
    }
  }

  return out;
}

// ---------------------------
// Final pricing
// ---------------------------

function computeBaseHourlyFromUnitMaps(machineType, unitMaps) {
  if (!machineType || !unitMaps) {
    return { price: null };
  }

  const { vcpu, ram } = deriveVcpuRamFromType(machineType);
  if (!vcpu || !ram) return { price: null };

  const series = machineType.split('-')[0].toLowerCase();
  const rates = unitMaps[series];
  if (!rates) return { price: null };

  const total = (vcpu * rates.core) + (ram * rates.ram);

  return { price: total, vcpu, ram };
}

// ---------------------------
// Exports
// ---------------------------

module.exports = {
  CE_SERVICE_ID,
  extractHourlyPrice,
  deriveVcpuRamFromType,
  regionMatches,
  buildSeriesUnitRateMaps,
  computeBaseHourlyFromUnitMaps
};
