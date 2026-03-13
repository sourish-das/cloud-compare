// scripts/providers/gcp.fetch.js
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

const gcpLib = require("../lib/gcp");

// Configuration
const OUT      = process.env.OUTPUT_PATH || path.join("docs", "data", "gcp", "gcp.prices.json");
const REGION   = process.env.GCP_REGION   || "us-east1";
const CURRENCY = process.env.GCP_CURRENCY || "USD";
const API_KEY  = process.env.GCP_PRICE_API_KEY;   // For Catalog API
const PROJECT  = process.env.GCP_PROJECT_ID;      // For Compute API

/**
 * Fetches SKUs from Cloud Billing Catalog API
 */
async function listSkus(serviceId, pageToken = "") {
  const base = `https://cloudbilling.googleapis.com/v1/services/${serviceId}/skus?currencyCode=${encodeURIComponent(CURRENCY)}&pageSize=5000`;
  const url = pageToken ? `${base}&pageToken=${encodeURIComponent(pageToken)}` : base;

  const bearer = process.env.GCLOUD_ACCESS_TOKEN || process.env.GOOGLE_OAUTH_ACCESS_TOKEN || "";
  const headers = bearer ? { Authorization: `Bearer ${bearer}` } : {};
  const finalUrl = bearer ? url : `${url}&key=${API_KEY}`;

  const r = await fetch(finalUrl, { headers });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`[GCP] Catalog API HTTP ${r.status}: ${txt}`);
  }
  return await r.json();
}

async function fetchGcpPrices() {
  logStart(`[GCP] Fetching PAYG pricing for ${REGION}...`);

  // 1. Collect all SKUs for the Compute Engine service
  const allSkus = [];
  let pageToken = "";
  do {
    const data = await listSkus(gcpLib.CE_SERVICE_ID, pageToken);
    if (data.skus) allSkus.push(...data.skus);
    pageToken = data.nextPageToken || "";
  } while (pageToken);

  // 2. Build pricing maps using library helpers
  const linuxSeriesRates = gcpLib.buildSeriesUnitRateMaps(allSkus, REGION);
  const windowsCoreRate = gcpLib.buildWindowsCoreRate(allSkus, REGION);

  console.log(`[GCP] Resolved unit rates for ${Object.keys(linuxSeriesRates).length} series.`);
  console.log(`[GCP] Windows license rate: $${windowsCoreRate}/vCPU-hr`);

  // 3. Get Machine Types from Compute API (Source of Truth for shapes)
  const gcp_price_list = {};
  let counter = 0;

  if (!PROJECT) {
    throw new Error("[GCP] GCP_PROJECT_ID is required for machine type scanning.");
  }

  const token = await gcpLib.getAccessTokenFromADC();
  const zones = await gcpLib.listRegionZones(PROJECT, REGION, token);
  
  const mtMap = new Map(); // name -> { vcpu, ram }
  for (const zone of zones) {
    const mts = await gcpLib.listZoneMachineTypes(PROJECT, zone, token);
    for (const mt of mts) {
      if (!mtMap.has(mt.name)) {
        mtMap.set(mt.name, {
          vcpu: Number(mt.guestCpus),
          ram: Number(mt.memoryMb) / 1024
        });
      }
    }
  }

  // 4. Synthesize rows by combining Shapes + Rates
  for (const [name, hw] of mtMap.entries()) {
    const instanceTok = name.replace(/-/g, "_").toUpperCase();
    const category = gcpLib.classifyGcpInstance(instanceTok);
    if (!category) continue;

    const series = name.split("-")[0].toLowerCase();
    const rates = linuxSeriesRates[series];

    // Build Linux Row
    if (rates && rates.core && rates.ram) {
      const linuxPrice = (hw.vcpu * rates.core) + (hw.ram * rates.ram);
      
      const linuxKey = `sku_${++counter}`;
      gcp_price_list[linuxKey] = {
        region: REGION,
        machine_type: name,
        os: "Linux",
        price_per_hour: linuxPrice,
        vcpu: hw.vcpu,
        memory_gb: hw.ram,
        __src: "composed"
      };

      // Build Windows Row (Skip ARM series)
      if (windowsCoreRate && !gcpLib.isGcpArmMachineType(name)) {
        const winPrice = linuxPrice + (hw.vcpu * windowsCoreRate);
        const winKey = `sku_${++counter}`;
        gcp_price_list[winKey] = {
          region: REGION,
          machine_type: name,
          os: "Windows",
          price_per_hour: winPrice,
          vcpu: hw.vcpu,
          memory_gb: hw.ram,
          __src: "composed+win"
        };
      }
    }
  }

  logDone(`[GCP] Generated ${Object.keys(gcp_price_list).length} pricing entries.`);
  return { gcp_price_list };
}

async function main() {
  const data = await fetchGcpPrices();
  const skus = data.gcp_price_list || {};
  const rows = [];

  for (const key in skus) {
    const item = skus[key];
    const instance = item.machine_type.replace(/-/g, "_");
    const category = gcpLib.classifyGcpInstance(instance);

    rows.push({
      instance,
      category,
      vcpu: item.vcpu,
      ram: item.memory_gb,
      pricePerHourUSD: Number(item.price_per_hour.toFixed(6)),
      region: REGION,
      os: item.os,
      series: item.machine_type.split("-")[0].toLowerCase(),
      arch: gcpLib.isGcpArmMachineType(item.machine_type) ? "arm" : "x86",
      source: item.__src
    });
  }

  const cheapest = dedupeCheapestByKey(rows, r => `${r.instance}-${r.region}-${r.os}`);
  
  if (warnAndSkipWriteOnEmpty("GCP", cheapest)) return;

  const output = {
    meta: {
      os: ["Linux", "Windows"],
      vcpu: uniqSortedNums(cheapest.map(x => x.vcpu)),
      ram: uniqSortedNums(cheapest.map(x => x.ram))
    },
    compute: cheapest,
    storage: {
      region: REGION,
      ssd_per_gb_month: 0.17,
      hdd_per_gb_month: 0.04
    }
  };

  atomicWrite(OUT, output);
  console.log(`✅ Successfully wrote ${cheapest.length} rows to ${OUT}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
