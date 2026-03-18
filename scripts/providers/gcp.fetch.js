// scripts/providers/gcp.fetch.js
// Node 18+ (global fetch)
'use strict';

const fs   = require('fs');
const path = require('path');
const {
  atomicWrite, // kept for other providers; not used below
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
const OUT      = process.env.OUTPUT_PATH || path.join('docs','data','gcp','gcp.prices.json');
const REGION   = (process.env.GCP_REGION   || 'us-east1').toLowerCase();
const CURRENCY = (process.env.GCP_CURRENCY || 'USD');
const API_KEY  = process.env.GCP_PRICE_API_KEY || '';   // Catalog (only if no bearer)
const PROJECT  = process.env.GCP_PROJECT_ID  || '';     // Compute discovery project
const MAX_VCPU = Number(process.env.GCP_MAX_VCPU || '128'); // enterprise cap

// Enterprise policy exclusions (names)
const EXCLUDE_NAME = /(hyper|extreme|-metal|-lssd)/i;

// Suffix-only (Calculator-style) classifier for compose path
function classifyBySuffix(instance) {
  const m = String(instance).toLowerCase().match(/-(standard|highcpu|highmem|ultramem|megamem)-\d+$/);
  if (!m) return null;
  const cls = m[1];
  if (cls === 'highcpu') return 'compute';
  if (cls === 'highmem' || cls === 'ultramem' || cls === 'megamem') return 'memory';
  return 'general';
}

function withinPolicy(vcpu) {
  return Number.isFinite(vcpu) && vcpu > 0 && vcpu <= MAX_VCPU;
}

async function listSkus(serviceId, pageToken = '') {
  // Use literal '&' (no HTML entities) so pagination and API key work correctly
  const base = `https://cloudbilling.googleapis.com/v1/services/${serviceId}/skus?currencyCode=${encodeURIComponent(CURRENCY)}&pageSize=5000`;
  const bearer = process.env.GCLOUD_ACCESS_TOKEN || process.env.GOOGLE_OAUTH_ACCESS_TOKEN || '';
  const headers = bearer ? { Authorization: `Bearer ${bearer}` } : {};
  const url = bearer
    ? (pageToken ? `${base}&pageToken=${encodeURIComponent(pageToken)}` : base)
    : (pageToken ? `${base}&pageToken=${encodeURIComponent(pageToken)}&key=${API_KEY}` : `${base}&key=${API_KEY}`);
  const r = await fetch(url, { headers });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`[GCP] Catalog skus HTTP ${r.status} ${txt}`);
  }
  return r.json();
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

  // 2) Build OnDemand Core/RAM unit-rate map per series for our region ($/hour per unit)
  const unitRates = buildSeriesUnitRateMaps(allSkus, REGION);

  // 3) Phase-1: Catalog per-instance SKUs (Linux, exact-region)
  const rows = [];
  const have = new Set(); // machineType names captured in Phase-1 (lowercase)
  for (const sku of allSkus) {
    const cat = (sku && sku.category) || {};
    if (cat.resourceFamily !== 'Compute') continue;
    if (cat.usageType && !/OnDemand/i.test(cat.usageType)) continue; // on-demand only
    if (!regionMatches(sku.serviceRegions, REGION)) continue;

    const mt = inferMachineType(sku); // hyphenated predefined type or null
    if (!mt) continue; // excludes custom-*
    if (!isPerInstanceSku(sku, mt)) continue; // only true per-instance rows

    // Treat as Linux unless description explicitly mentions Windows
    const readable = (sku.description || sku.displayName || '');
    if (/windows/i.test(readable)) continue; // Linux-only scope here

    // Price normalized to $/hour by lib/gcp.js
    const price = extractHourlyPrice(sku.pricingInfo);
    if (!(price > 0)) continue;

    // vCPU/RAM from attributes or derive from type token
    const a = sku.attributes || {};
    let vcpu = a.vcpu ? Number(a.vcpu) : undefined;
    let ram  = a.memoryGb ? Number(a.memoryGb) : undefined;
    if (!Number.isFinite(vcpu) || !Number.isFinite(ram)) {
      const d = deriveVcpuRamFromType(mt);
      if (!Number.isFinite(vcpu)) vcpu = d.vcpu;
      if (!Number.isFinite(ram))  ram  = d.ram;
    }
    if (!Number.isFinite(vcpu) || !Number.isFinite(ram)) continue;
    if (!withinPolicy(vcpu)) continue; // enterprise policy: cap very large shapes

    const category = classifyGcpInstance(mt) || classifyBySuffix(mt);
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
      if (!/^[a-z0-9]+-[a-z]+[a-z0-9]*-\d+$/.test(name)) continue; // predefined, hyphen-native
      if (EXCLUDE_NAME.test(name)) continue;
      if (!mtMap.has(name)) {
        const vcpu  = Number(mt.guestCpus || 0);
        const ramGiB = Number(mt.memoryMb || 0) / 1024;
        if (vcpu > 0 && ramGiB > 0) mtMap.set(name, { vcpu, ramGiB });
      }
    }
  }

  for (const [type, hw] of mtMap.entries()) {
    if (have.has(type)) continue; // already got a catalog per-instance row
    if (!withinPolicy(hw.vcpu)) continue; // cap very large shapes
    const category = classifyBySuffix(type);
    if (!category) continue;
    const series = type.split('-')[0];
    const rates = unitRates[series];
    if (!rates || !(rates.core > 0) || !(rates.ram > 0)) continue;
    const price = hw.vcpu * Number(rates.core) + hw.ramGiB * Number(rates.ram);
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
  const counts = cheapest.reduce((acc, r) => { acc[r.category] = (acc[r.category] || 0) + 1; return acc; }, {});
  console.log('[GCP] category-counts:', counts, 'region:', REGION);
  console.log(`[GCP] collected=${rows.length}, cheapest=${cheapest.length}`);
  if (warnAndSkipWriteOnEmpty('GCP', cheapest)) return;

  // 6) Output
  const meta = {
    os: ['Linux'],
    vcpu: uniqSortedNums(cheapest.map(x => x.vcpu)),
    ram:  uniqSortedNums(cheapest.map(x => x.ram))
  };
  const storage = {
    region: REGION,
    ssd_per_gb_month: 0.10, // Balanced PD (zonal)
    hdd_per_gb_month: 0.04, // Standard PD (zonal)
    hdd_free_gb_per_month: 30
  };
  const out = { meta, compute: cheapest, storage };

  // atomic write (temp -> rename) to avoid partial files
  const dir = path.dirname(OUT);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = OUT + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8');
  fs.renameSync(tmp, OUT);

  logDone(`✅ Wrote ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
