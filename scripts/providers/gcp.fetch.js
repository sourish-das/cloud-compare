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

// Import from your library
const gcpLib = require("../lib/gcp");

// Destructure with fallbacks to prevent "is not a function" errors
const {
  CE_SERVICE_ID,
  classifyGcpInstance,
  extractHourlyPrice,
  inferMachineType,
  deriveVcpuRamFromType,
  regionMatches,
  isPerInstanceSku,
  getAccessTokenFromADC,
  listRegionZones,
  listZoneMachineTypes,
  buildWindowsCoreRate,
  buildRhelPerInstanceAdders,
  isGcpArmMachineType
} = gcpLib;

// Handle potential naming mismatch for the unit rate builder
const buildSeriesUnitRateMaps = gcpLib.buildSeriesUnitRateMaps || gcpLib.buildLinuxUnitRates; 
const calculateRhelPrice = gcpLib.calculateRhelPrice || ((base, vcpu) => base + (vcpu * 0.06));

// Env Config
const OUT      = process.env.OUTPUT_PATH || path.join("docs", "data", "gcp", "gcp.prices.json");
const REGION   = process.env.GCP_REGION   || "us-east1";
const CURRENCY = process.env.GCP_CURRENCY || "USD";
const API_KEY  = process.env.GCP_PRICE_API_KEY;
const PROJECT  = process.env.GCP_PROJECT_ID;

async function listSkus(serviceId, pageToken = "") {
  const base = `https://cloudbilling.googleapis.com/v1/services/${serviceId}/skus?currencyCode=${encodeURIComponent(CURRENCY)}&pageSize=5000`;
  const url = pageToken ? `${base}&pageToken=${encodeURIComponent(pageToken)}` : base;
  const bearer = process.env.GCLOUD_ACCESS_TOKEN || "";
  const headers = bearer ? { Authorization: `Bearer ${bearer}` } : {};
  const finalUrl = bearer ? url : `${url}&key=${API_KEY}`;

  const r = await fetch(finalUrl, { headers });
  if (!r.ok) throw new Error(`[GCP] SKUs HTTP ${r.status}`);
  return await r.json();
}

async function main() {
  logStart("[GCP] Starting fetch with fixed function references...");

  const allSkus = [];
  let pageToken = "";
  try {
    do {
      const data = await listSkus(CE_SERVICE_ID, pageToken);
      allSkus.push(...(data.skus || []));
      pageToken = data.nextPageToken || "";
    } while (pageToken);
  } catch (e) {
    console.error("[GCP] Failed to fetch Catalog SKUs:", e.message);
  }

  // Build helper maps
  const linuxSeriesRates = buildSeriesUnitRateMaps ? buildSeriesUnitRateMaps(allSkus, REGION) : {};
  const windowsCoreRate = buildWindowsCoreRate ? buildWindowsCoreRate(allSkus, REGION) : 0;
  const rhelAdders = buildRhelPerInstanceAdders ? buildRhelPerInstanceAdders(allSkus, REGION) : {};

  const rows = [];
  
  // 1. Process Catalog SKUs
  for (const sku of allSkus) {
    if (!regionMatches(sku.serviceRegions, REGION)) continue;
    const mt = inferMachineType(sku);
    if (!mt || !isPerInstanceSku(sku, mt)) continue;

    const category = classifyGcpInstance(mt.replace(/-/g, "_").toUpperCase());
    if (!category) continue;

    const desc = (sku.description || "").toLowerCase();
    let os = "Linux";
    if (desc.includes("windows")) os = "Windows";
    else if (desc.includes("rhel") || desc.includes("red hat")) os = "RHEL";

    const price = extractHourlyPrice(sku.pricingInfo);
    const { vcpu, ram } = deriveVcpuRamFromType(mt);
    if (price > 0 && vcpu > 0) {
      rows.push({
        instance: mt, category, vcpu, ram, pricePerHourUSD: price,
        region: REGION, os, series: mt.split("-")[0],
        arch: isGcpArmMachineType(mt) ? "arm" : "x86", source: "catalog"
      });
    }
  }

  // 2. Composition Fallback (Only if PROJECT is provided)
  if (PROJECT && getAccessTokenFromADC) {
    const token = await getAccessTokenFromADC().catch(() => null);
    if (token) {
      const zones = await listRegionZones(PROJECT, REGION, token);
      const mtMap = new Map();
      for (const z of zones) {
        const mts = await listZoneMachineTypes(PROJECT, z, token);
        mts.forEach(m => mtMap.set(m.name, { vcpu: m.guestCpus, ram: m.memoryMb / 1024 }));
      }

      for (const [mt, hw] of mtMap.entries()) {
        const category = classifyGcpInstance(mt.replace(/-/g, "_").toUpperCase());
        if (!category) continue;

        const series = mt.split("-")[0];
        const rates = linuxSeriesRates[series];
        if (rates?.core && rates?.ram) {
          const basePrice = (hw.vcpu * rates.core) + (hw.ram * rates.ram);
          
          // Add Linux
          rows.push({
            instance: mt, category, vcpu: hw.vcpu, ram: hw.ram, pricePerHourUSD: basePrice,
            region: REGION, os: "Linux", series, arch: isGcpArmMachineType(mt) ? "arm" : "x86", source: "composed"
          });

          // Add RHEL Synthesis
          const rhelPrice = rhelAdders[mt] ? (basePrice + rhelAdders[mt]) : calculateRhelPrice(basePrice, hw.vcpu);
          rows.push({
            instance: mt, category, vcpu: hw.vcpu, ram: hw.ram, pricePerHourUSD: rhelPrice,
            region: REGION, os: "RHEL", series, arch: isGcpArmMachineType(mt) ? "arm" : "x86", source: "composed+rhel"
          });
        }
      }
    }
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
  logDone(`Wrote ${cheapest.length} rows to ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
