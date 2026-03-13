// scripts/providers/gcp.fetch.js
// Node 18+ (global fetch)
"use strict";

const path = require("path");
const {
  atomicWrite,
  dedupeCheapestByKey,
  warnAndSkipWriteOnEmpty,
  logStart,
  logDone,
  uniqSortedNums
} = require("../lib/common");

const {
  CE_SERVICE_ID,
  classifyGcpInstance,
  extractHourlyPrice,
  inferMachineType,
  deriveVcpuRamFromType,
  regionMatches,
  isPerInstanceSku,
  // FULL-mode helpers
  getAccessTokenFromADC,
  listRegionZones,
  listZoneMachineTypes,
  buildSeriesUnitRateMaps,
  buildWindowsCoreRate,
  // RHEL per-instance adders (preferred) + fallback constant
  buildRhelPerInstanceAdders,
  RHEL_FALLBACK_RATE_PER_VCPU,
  calculateRhelPrice, // Using the new tiered logic from lib
  isGcpArmMachineType
} = require("../lib/gcp");

// Output & env
const OUT      = process.env.OUTPUT_PATH || path.join("docs", "data", "gcp", "gcp.prices.json");
const REGION   = process.env.GCP_REGION   || "us-east1";
const CURRENCY = process.env.GCP_CURRENCY || "USD";
const API_KEY  = process.env.GCP_PRICE_API_KEY;   // Catalog API (public)
const PROJECT  = process.env.GCP_PROJECT_ID;      // for Compute API fallback

async function listSkus(serviceId, pageToken = "") {
  const base = `https://cloudbilling.googleapis.com/v1/services/${serviceId}/skus?currencyCode=${encodeURIComponent(CURRENCY)}&pageSize=5000`;
  const url = pageToken ? `${base}&pageToken=${encodeURIComponent(pageToken)}` : base;

  const bearer = process.env.GCLOUD_ACCESS_TOKEN || process.env.GOOGLE_OAUTH_ACCESS_TOKEN || "";
  const headers = bearer ? { Authorization: `Bearer ${bearer}` } : {};
  const finalUrl = bearer ? url : `${url}&key=${API_KEY}`;

  const r = await fetch(finalUrl, { headers });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`[GCP] skus HTTP ${r.status} ${txt}`);
  }
  return await r.json();
}

async function fetchGcpPrices() {
  logStart("[GCP] Fetching PAYG pricing with Dynamic Mapping and Tiered RHEL...");

  if (!process.env.GCLOUD_ACCESS_TOKEN && !process.env.GCP_PRICE_API_KEY) {
    throw new Error("[GCP] No Catalog credentials found.");
  }

  const allSkus = [];
  let pageToken = "";
  do {
    const { skus = [], nextPageToken } = await listSkus(CE_SERVICE_ID, pageToken);
    allSkus.push(...skus);
    pageToken = nextPageToken || "";
  } while (pageToken);

  const linuxSeriesRates = buildSeriesUnitRateMaps(allSkus, REGION);
  const windowsCoreRate = buildWindowsCoreRate(allSkus, REGION);
  const rhelAdders = buildRhelPerInstanceAdders(allSkus, REGION) || {};

  const gcp_price_list = {};
  let counter = 0;

  // 1) Catalog Pass (Per-instance Linux/Win/RHEL)
  for (const sku of allSkus) {
    if (!regionMatches(sku.serviceRegions, REGION)) continue;
    const mt = inferMachineType(sku);
    if (!mt || !isPerInstanceSku(sku, mt)) continue;

    // Use our dynamic mapping check
    const instTok = mt.replace(/-/g, "_").toUpperCase();
    if (!classifyGcpInstance(instTok)) continue;

    const readable = (sku.description || sku.displayName || "").toLowerCase();
    let os = "Linux";
    if (/windows/.test(readable)) os = "Windows";
    else if (/(rhel|red\s*hat)/.test(readable)) os = "RHEL";

    const price = extractHourlyPrice(sku.pricingInfo);
    const { vcpu, ram } = deriveVcpuRamFromType(mt);
    if (!(price > 0) || !vcpu || !ram) continue;

    const key = `sku_${++counter}`;
    gcp_price_list[key] = {
      region: REGION, machine_type: mt, os, price_per_hour: price,
      vcpu, memory_gb: ram, __src: "catalog"
    };
  }

  // 2) Composition Pass (Missing shapes via Compute API)
  if (PROJECT) {
    const token = await getAccessTokenFromADC().catch(() => null);
    if (token) {
      const zones = await listRegionZones(PROJECT, REGION, token);
      const mtMap = new Map();

      for (const z of zones) {
        const mts = await listZoneMachineTypes(PROJECT, z, token);
        for (const mtObj of mts) {
          if (!mtMap.has(mtObj.name)) {
            mtMap.set(mtObj.name, { vcpu: mtObj.guestCpus, ram: mtObj.memoryMb / 1024 });
          }
        }
      }

      for (const [mt, hw] of mtMap.entries()) {
        const instTok = mt.replace(/-/g, "_").toUpperCase();
        if (!classifyGcpInstance(instTok)) continue;

        const series = mt.split("-")[0];
        const rates = linuxSeriesRates[series];
        if (!rates || !rates.core || !rates.ram) continue;

        const baseLinuxPrice = (hw.vcpu * rates.core) + (hw.ram * rates.ram);
        const lKey = `sku_c_${++counter}`;
        gcp_price_list[lKey] = {
          region: REGION, machine_type: mt, os: "Linux",
          price_per_hour: baseLinuxPrice, vcpu: hw.vcpu, memory_gb: hw.ram, __src: "composed"
        };

        // RHEL Synthesis: Priority 1: Per-instance adder, Priority 2: Tiered 2026 logic
        const mtKey = mt.toLowerCase().replace(/_/g, "-");
        const adder = rhelAdders[mtKey];
        let rhelPrice;
        
        if (Number.isFinite(adder) && adder > 0) {
          rhelPrice = baseLinuxPrice + adder;
        } else {
          rhelPrice = calculateRhelPrice(baseLinuxPrice, hw.vcpu);
        }

        const rKey = `sku_r_${++counter}`;
        gcp_price_list[rKey] = {
          region: REGION, machine_type: mt, os: "RHEL",
          price_per_hour: rhelPrice, vcpu: hw.vcpu, memory_gb: hw.ram, __src: "composed+rhel"
        };

        // Windows Synthesis
        if (windowsCoreRate && !isGcpArmMachineType(mt)) {
          const wKey = `sku_w_${++counter}`;
          gcp_price_list[wKey] = {
            region: REGION, machine_type: mt, os: "Windows",
            price_per_hour: baseLinuxPrice + (hw.vcpu * windowsCoreRate),
            vcpu: hw.vcpu, memory_gb: hw.ram, __src: "composed+win"
          };
        }
      }
    }
  }

  logDone("[GCP] Pricing data collected.");
  return { gcp_price_list };
}

async function main() {
  const json = await fetchGcpPrices();
  const rows = [];

  for (const key in json.gcp_price_list) {
    const item = json.gcp_price_list[key];
    const instTok = item.machine_type.replace(/-/g, "_").toUpperCase();
    const category = classifyGcpInstance(instTok);
    if (!category) continue;

    rows.push({
      instance: item.machine_type,
      category,
      vcpu: item.vcpu,
      ram: item.memory_gb,
      pricePerHourUSD: item.price_per_hour,
      region: REGION,
      os: item.os,
      series: item.machine_type.split("-")[0].toLowerCase(),
      arch: isGcpArmMachineType(item.machine_type) ? "arm" : "x86",
      source: item.__src
    });
  }

  const cheapest = dedupeCheapestByKey(rows, r => `${r.instance}-${r.region}-${r.os}`);
  
  const out = {
    meta: {
      os: ["Linux", "Windows", "RHEL"],
      vcpu: uniqSortedNums(cheapest.map(x => x.vcpu)),
      ram: uniqSortedNums(cheapest.map(x => x.ram))
    },
    compute: cheapest,
    storage: { region: REGION, ssd_per_gb_month: 0.17, hdd_per_gb_month: 0.04 }
  };

  atomicWrite(OUT, out);
  console.log(`✅ Wrote ${cheapest.length} rows to ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
