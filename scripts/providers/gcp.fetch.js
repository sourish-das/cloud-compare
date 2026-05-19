// scripts/providers/gcp.fetch.js
// Node 18+ (global fetch)
'use strict';

const fs = require('fs');
const path = require('path');

const {
  dedupeCheapestByKey,
  warnAndSkipWriteOnEmpty,
  logStart,
  logDone,
  uniqSortedNums
} = require('../lib/common');

const {
  CE_SERVICE_ID,
  buildSeriesUnitRateMaps,
  getAccessTokenFromADC,
  listRegionZones,
  listZoneMachineTypes,
  inferMachineType,
  isPerInstanceSku,
  extractHourlyPrice,
  deriveVcpuRamFromType,
  classifyGcpInstance,
  regionMatches,
  isGcpArmSeries
} = require('../lib/gcp');

// ---------- env / output ----------
const OUT = process.env.OUTPUT_PATH || path.join('docs', 'data', 'gcp', 'gcp.prices.json');
const REGION = (process.env.GCP_REGION || 'us-east1').toLowerCase();
const CURRENCY = process.env.GCP_CURRENCY || 'USD';
const API_KEY = process.env.GCP_PRICE_API_KEY || '';         // Catalog (only if no bearer)
const PROJECT = process.env.GCP_PROJECT_ID || '';            // Compute discovery project
const MAX_VCPU = Number(process.env.GCP_MAX_VCPU || '128');  // enterprise cap

// Enterprise policy exclusions (names)
// IMPORTANT: do NOT exclude "hypermem" if you want it as memory category.
// Keep only the truly unwanted patterns here.
const EXCLUDE_NAME = /(extreme|-metal|-lssd)/i;

// Suffix-only classifier (matches your required mapping)
function classifyBySuffix(instance) {
  const m = String(instance)
    .toLowerCase()
    .match(/-(standard|highcpu|highmem|ultramem|megamem|hypermem)-\d+$/);

  if (!m) return null;

  const cls = m[1];
  if (cls === 'highcpu') return 'compute';
  if (cls === 'highmem' || cls === 'ultramem' || cls === 'megamem' || cls === 'hypermem') return 'memory';
  return 'general'; // standard
}

function withinPolicy(vcpu) {
  return Number.isFinite(vcpu) && vcpu > 0 && vcpu <= MAX_VCPU;
}

// --------- List SKUs ---------
async function listSkus(serviceId, pageToken = '') {
  const base = `https://cloudbilling.googleapis.com/v1/services/${serviceId}/skus` +
    `?currencyCode=${encodeURIComponent(CURRENCY)}` +
    `&pageSize=5000`;

  const bearer = process.env.GCLOUD_ACCESS_TOKEN || process.env.GOOGLE_OAUTH_ACCESS_TOKEN || '';
  const headers = bearer ? { Authorization: `Bearer ${bearer}` } : {};

  const url = bearer
    ? (pageToken ? `${base}&pageToken=${encodeURIComponent(pageToken)}` : base)
    : (pageToken
      ? `${base}&pageToken=${encodeURIComponent(pageToken)}&key=${API_KEY}`
      : `${base}&key=${API_KEY}`);

  const r = await fetch(url, { headers });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`[GCP] Catalog skus HTTP ${r.status} ${txt}`);
  }
  return r.json();
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

// --------- Per-series self-calibration from real per-instance SKUs ---------
function buildSeriesScaleMap(allSkus, unitRates, region) {
  const bySeries = {}; // series -> [factor...]
  const want = String(region || '').toLowerCase();

  const inRegion = (sku) => {
    const sr = new Set((sku.serviceRegions || []).map(s => String(s).toLowerCase()));
    return sr.has(want) || (want.startsWith('us-') && sr.has('us')) || sr.has('global');
  };

  for (const sku of (allSkus || [])) {
    const cat = (sku && sku.category) || {};
    if (cat.resourceFamily !== 'Compute') continue;
    if (cat.usageType && !/ondemand/i.test(cat.usageType)) continue;
    if (!inRegion(sku)) continue;

    const mt = inferMachineType(sku);
    if (!mt || /^custom-/i.test(mt)) continue;
    if (!isPerInstanceSku(sku, mt)) continue;

    const series = mt.split('-')[0].toLowerCase();
    const rates = unitRates[series];
    if (!rates || !(rates.core > 0) || !(rates.ram > 0)) continue;

    const descTxt = `${sku.description || ''} ${sku.displayName || ''}`;
    if (/windows|sql server|rhel|red hat|suse|sles|sap/i.test(descTxt)) continue;

    const actual = extractHourlyPrice(sku.pricingInfo);
    if (!(actual > 0)) continue;

    const a = sku.attributes || {};
    let vcpu = a.vcpu ? Number(a.vcpu) : undefined;
    let ram = a.memoryGb ? Number(a.memoryGb) : undefined;

    if (!Number.isFinite(vcpu) || !Number.isFinite(ram)) {
      const d = deriveVcpuRamFromType(mt);
      if (!Number.isFinite(vcpu)) vcpu = d.vcpu;
      if (!Number.isFinite(ram)) ram = d.ram;
    }
    if (!Number.isFinite(vcpu) || !Number.isFinite(ram)) continue;

    const pred = (vcpu * Number(rates.core)) + (ram * Number(rates.ram));
    if (!(pred > 0)) continue;

    const f = actual / pred;
    if (f > 0.1 && f < 10) {
      bySeries[series] ??= [];
      bySeries[series].push(f);
    }
  }

  const out = {};
  for (const [series, samples] of Object.entries(bySeries)) {
    samples.sort((a, b) => a - b);
    const mid = samples[Math.floor(samples.length / 2)];
    const factor = clamp(mid, 0.5, 2.0);
    if (Math.abs(factor - 1) > 0.03) out[series] = factor;
  }
  return out;
}

async function main() {
  logStart(`[GCP] Linux hybrid fetch (per-instance first, compose fallback) [region=${REGION}]`);

  // Preconditions
  if (!process.env.GCLOUD_ACCESS_TOKEN && !API_KEY) {
    throw new Error('[GCP] Need GCLOUD_ACCESS_TOKEN (OIDC) or GCP_PRICE_API_KEY to read Catalog.');
  }

  // 1) Pull full Catalog SKUs for Compute Engine
  const allSkus = [];
  let pageToken = '';
  do {
    const { skus = [], nextPageToken } = await listSkus(CE_SERVICE_ID, pageToken);
    allSkus.push(...skus);
    pageToken = nextPageToken || '';
  } while (pageToken);

console.log(`[GCP] fetched catalog SKUs: ${allSkus.length}`);

// ---- DIAG: how many SKUs carry machineType in attributes (helps Phase-1) ----
const mtAttrCount = allSkus.filter(s => s?.attributes?.machineType).length;
console.log('[GCP] SKUs with attributes.machineType:', mtAttrCount);
// ---- END DIAG ----

// 2) Build OnDemand Core/RAM unit-rate map per series for our region ($/hour per 1 unit)
const unitRates = buildSeriesUnitRateMaps(allSkus, REGION);

console.log('[GCP] unitRates keys:', Object.keys(unitRates || {}).sort().join(','));
console.log('[GCP] unitRates series count:', Object.keys(unitRates || {}).length);
console.log('[GCP] unitRates sample:', {
  n4:  unitRates?.n4,
  n4d: unitRates?.n4d,
  c4:  unitRates?.c4,
  c2d: unitRates?.c2d,
  m4:  unitRates?.m4
});

if (Object.keys(unitRates || {}).length < 5) {
  throw new Error('[GCP] unitRates too small; aborting to avoid writing empty/incorrect output');
}
// ---- END DEBUG + FAIL-FAST ----

// 2b) Per-series scale factors from real per-instance rows (Linux)
const seriesScale = buildSeriesScaleMap(allSkus, unitRates, REGION);
console.log('[GCP] series-scale factors:', Object.keys(seriesScale).length ? seriesScale : '(none)');

  // --- ARM series fallback scale from x86 sibling (only if ARM has no ground-truth factor) ---
  (function inheritArmScale() {
    const sib = { n4a: 'n4', c4a: 'c4', t2a: 't2d' };
    for (const [arm, x86] of Object.entries(sib)) {
      if (seriesScale[arm] != null) continue;

      let factor = seriesScale[x86];
      const xr = unitRates[x86], ar = unitRates[arm];

      if (!factor && xr && ar && xr.core > 0 && ar.core > 0 && xr.ram > 0 && ar.ram > 0) {
        const fCore = xr.core / ar.core;
        const fRam = xr.ram / ar.ram;
        const est = (fCore + fRam) / 2;
        if (est > 0.5 && est < 2.0) factor = est;
      }

      if (!factor) continue;
      seriesScale[arm] = clamp(Number(factor), 0.5, 2.0);
    }
  })();

  // 3) Phase-1: Catalog per-instance SKUs (Linux, exact-region)
  const rows = [];
  const have = new Set();

  for (const sku of allSkus) {
    const cat = (sku && sku.category) || {};
    if (cat.resourceFamily !== 'Compute') continue;
    if (cat.usageType && !/ondemand/i.test(cat.usageType)) continue;
    if (!regionMatches(sku.serviceRegions, REGION)) continue;

    const mt = inferMachineType(sku);
    if (!mt) continue;
    if (!isPerInstanceSku(sku, mt)) continue;

    const readable = (sku.description || sku.displayName || '');
    if (/windows|sql server|rhel|red hat|suse|sles|sap/i.test(readable)) continue;

    const price = extractHourlyPrice(sku.pricingInfo);
    if (!(price > 0)) continue;

    const a = sku.attributes || {};
    let vcpu = a.vcpu ? Number(a.vcpu) : undefined;
    let ram = a.memoryGb ? Number(a.memoryGb) : undefined;

    if (!Number.isFinite(vcpu) || !Number.isFinite(ram)) {
      const d = deriveVcpuRamFromType(mt);
      if (!Number.isFinite(vcpu)) vcpu = d.vcpu;
      if (!Number.isFinite(ram)) ram = d.ram;
    }

    // If RAM still unknown (common for M*/X*), skip catalog row because we can't compare/size
    // Those shapes will be handled by discovery+compose where RAM is known.
    if (!Number.isFinite(vcpu) || !Number.isFinite(ram)) continue;

    if (!withinPolicy(vcpu)) continue;

    const category = (typeof classifyGcpInstance === 'function' ? classifyGcpInstance(mt) : null) || classifyBySuffix(mt);
    if (!category) continue;

    const series = mt.split('-')[0].toLowerCase();

    rows.push({
      instance: mt.toLowerCase(),
      category,
      vcpu,
      ram,
      pricePerHourUSD: +Number(price).toFixed(6),
      region: REGION,
      os: 'Linux',
      series,
      arch: isGcpArmSeries(series) ? 'arm' : 'x86',
      source: 'catalog'
    });

    have.add(mt.toLowerCase());
  }

  const catalogCount = rows.filter(r => r.source === 'catalog').length;
  if (catalogCount < 20) {
    console.warn(`[GCP] WARNING: Low catalog per-instance rows (${catalogCount}). If prices look off, check per-instance SKU detection.`);
  } else {
    console.log(`[GCP] catalog per-instance rows: ${catalogCount}`);
  }

  // 4) Phase-2: Compose fallback for shapes missing after Phase-1
  if (!PROJECT) throw new Error('[GCP] GCP_PROJECT_ID is required for Compute discovery.');

  const accessToken = await getAccessTokenFromADC();
  if (!accessToken) throw new Error('[GCP] GCLOUD_ACCESS_TOKEN is empty.');

  const zones = await listRegionZones(PROJECT, REGION, accessToken);

  const mtMap = new Map(); // type -> { vcpu, ramGiB }
  for (const z of zones) {
    const mts = await listZoneMachineTypes(PROJECT, z, accessToken);
    for (const mt of mts) {
      const name = String(mt.name || '').toLowerCase();

      if (name.startsWith('custom-')) continue;
      if (EXCLUDE_NAME.test(name)) continue;

      // Accept the same patterns as listZoneMachineTypes already allows,
      // but keep a lightweight check to avoid odd names.
      const okName =
        /^[a-z0-9]+-[a-z]+[a-z0-9]*-\d+$/i.test(name) ||
        /^[a-z0-9]+-[a-z]+[a-z0-9]*-[a-z]+-\d+$/i.test(name);

      if (!okName) continue;

      if (!mtMap.has(name)) {
        const vcpu = Number(mt.guestCpus || 0);
        const ramGiB = Number(mt.memoryMb || 0) / 1024;
        if (vcpu > 0 && ramGiB > 0) mtMap.set(name, { vcpu, ramGiB });
      }
    }
  }

// ---- DIAG: discovery coverage ----
const discoveredSeries = [...new Set([...mtMap.keys()].map(n => n.split('-')[0]))].sort();
console.log('[GCP] discovery series:', discoveredSeries.join(','));
console.log('[GCP] discovery machineTypes:', mtMap.size);
// ---- END DIAG ----
  
  for (const [type, hw] of mtMap.entries()) {
    if (have.has(type)) continue;
    if (!withinPolicy(hw.vcpu)) continue;

    const category = (typeof classifyGcpInstance === 'function' ? classifyGcpInstance(type) : null) || classifyBySuffix(type);
    if (!category) continue;

    const series = type.split('-')[0].toLowerCase();
    const rates = unitRates[series];
    if (!rates || !(rates.core > 0) || !(rates.ram > 0)) continue;

    const base = hw.vcpu * Number(rates.core) + hw.ramGiB * Number(rates.ram);

    const factor = Number(seriesScale[series] ?? 1);
    const price = base * (factor > 0 ? factor : 1);
    if (!(price > 0)) continue;

    rows.push({
      instance: type,
      category,
      vcpu: hw.vcpu,
      ram: +hw.ramGiB.toFixed(2),
      pricePerHourUSD: +price.toFixed(6),
      region: REGION,
      os: 'Linux',
      series,
      arch: isGcpArmSeries(series) ? 'arm' : 'x86',
      source: 'composed'
    });
  }

  // 5) Deduplicate / finalize (Linux only)
  const cheapest = dedupeCheapestByKey(rows, r => `${r.instance}-${r.region}-${r.os}`);
  const counts = cheapest.reduce((acc, r) => {
    acc[r.category] = (acc[r.category] || 0) + 1;
    return acc;
  }, {});

  console.log('[GCP] category-counts:', counts, 'region:', REGION);
  console.log(`[GCP] collected=${rows.length}, cheapest=${cheapest.length}`);

  if (warnAndSkipWriteOnEmpty('GCP', cheapest)) return;

  // 6) Output
  const meta = {
    os: ['Linux'],
    vcpu: uniqSortedNums(cheapest.map(x => x.vcpu)),
    ram: uniqSortedNums(cheapest.map(x => x.ram))
  };

  const storage = {
    region: REGION,
    ssd_per_gb_month: 0.10,
    hdd_per_gb_month: 0.04,
    hdd_free_gb_per_month: 30
  };

  const out = { meta, compute: cheapest, storage };

  // Atomic write
  const dir = path.dirname(OUT);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = OUT + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8');
  fs.renameSync(tmp, OUT);

  logDone(`✅ Wrote ${OUT}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
