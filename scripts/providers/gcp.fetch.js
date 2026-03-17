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
  // unit-rate builder (OnDemand Core/RAM per series for a region)
  buildSeriesUnitRateMaps,
  // discovery helpers
  getAccessTokenFromADC,
  listRegionZones,
  listZoneMachineTypes,
  // arch tag
  isGcpArmSeries
} = require("../lib/gcp");

// ---------- env / output ----------
const OUT      = process.env.OUTPUT_PATH     || path.join("docs", "data", "gcp", "gcp.prices.json");
const REGION   = (process.env.GCP_REGION     || "us-east1").toLowerCase();
const CURRENCY = process.env.GCP_CURRENCY    || "USD";
const API_KEY  = process.env.GCP_PRICE_API_KEY;     // Catalog (only if no bearer)
const PROJECT  = process.env.GCP_PROJECT_ID;        // Compute discovery project

// --------- local helpers ----------
const EXCLUDE_NAME = /(ultra(mem|cpu)?|hyper|extreme|-metal|-lssd)/i;

function classifyBySuffix(instance) {
  const m = String(instance).toLowerCase().match(/-(standard|highcpu|highmem|ultramem|megamem)-\d+$/);
  if (!m) return null;
  const cls = m[1];
  if (cls === "highcpu") return "compute";
  if (cls === "highmem" || cls === "ultramem" || cls === "megamem") return "memory";
  return "general";
}

async function listSkus(serviceId, pageToken = "") {
  const base = `https://cloudbilling.googleapis.com/v1/services/${serviceId}/skus?currencyCode=${encodeURIComponent(CURRENCY)}&pageSize=5000`;
  const bearer = process.env.GCLOUD_ACCESS_TOKEN || process.env.GOOGLE_OAUTH_ACCESS_TOKEN || "";
  const headers = bearer ? { Authorization: `Bearer ${bearer}` } : {};
  const url = bearer ? (pageToken ? `${base}&pageToken=${encodeURIComponent(pageToken)}` : base)
                     : (pageToken ? `${base}&pageToken=${encodeURIComponent(pageToken)}&key=${API_KEY}` : `${base}&key=${API_KEY}`);
  const r = await fetch(url, { headers });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`[GCP] Catalog skus HTTP ${r.status} ${txt}`);
  }
  return r.json();
}

// ---------- main fetch ----------
async function main() {
  logStart(`[GCP] Linux-only fetch (region=${REGION})`);

  // 1) Pull full Catalog SKUs for Compute Engine
  if (!process.env.GCLOUD_ACCESS_TOKEN && !API_KEY) {
    throw new Error("[GCP] Need GCLOUD_ACCESS_TOKEN (OIDC) or GCP_PRICE_API_KEY to read Catalog.");
  }
  const allSkus = [];
  let pageToken = "";
  do {
    const { skus = [], nextPageToken } = await listSkus(CE_SERVICE_ID, pageToken);
    allSkus.push(...skus);
    pageToken = nextPageToken || "";
  } while (pageToken);

  // Build OnDemand Core/RAM unit-rate map per series for our region
  const unitRates = buildSeriesUnitRateMaps(allSkus, REGION);

  // 2) Discover predefined machine types (exact vCPU/RAM)
  if (!PROJECT) throw new Error("[GCP] GCP_PROJECT_ID is required for Compute discovery.");
  const accessToken = await getAccessTokenFromADC(); // reads GCLOUD_ACCESS_TOKEN
  if (!accessToken) throw new Error("[GCP] GCLOUD_ACCESS_TOKEN is empty.");

  const zones = await listRegionZones(PROJECT, REGION, accessToken);
  const mtMap = new Map(); // type -> { vcpu, ramGiB }

  for (const z of zones) {
    const mts = await listZoneMachineTypes(PROJECT, z, accessToken);
    for (const mt of mts) {
      const name = String(mt.name || "").toLowerCase();
      if (name.startsWith("custom-")) continue;
      if (!/^[a-z0-9]+-[a-z]+[a-z0-9]*-\d+$/.test(name)) continue;
      if (EXCLUDE_NAME.test(name)) continue;
      if (!mtMap.has(name)) {
        const vcpu = Number(mt.guestCpus || 0);
        const ramGiB = Number(mt.memoryMb || 0) / 1024;
        if (vcpu > 0 && ramGiB > 0) mtMap.set(name, { vcpu, ramGiB });
      }
    }
  }

  // 3) Compose Linux base from Core/RAM unit rates (suffix classification only)
  const rows = [];
  for (const [type, hw] of mtMap.entries()) {
    const category = classifyBySuffix(type);
    if (!category) continue;

    const series = type.split("-")[0]; // e.g., n2d, c3, c4a
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
      os: "Linux",
      series,
      arch: isGcpArmSeries(series) ? "arm" : "x86",
      source: "composed"
    });
  }

  // 4) Deduplicate / finalize (Linux only)
  const cheapest = dedupeCheapestByKey(rows, r => `${r.instance}-${r.region}-${r.os}`);

  const counts = cheapest.reduce((acc, r) => {
    acc[r.category] = (acc[r.category] || 0) + 1;
    return acc;
  }, {});
  console.log("[GCP] category-counts:", counts, "region:", REGION);
  console.log(`[GCP] collected=${rows.length}, cheapest=${cheapest.length}`);

  if (warnAndSkipWriteOnEmpty("GCP", cheapest)) return;

  // 5) Output (keep your storage defaults; unchanged)
  const meta = {
    os: ["Linux"],
    vcpu: uniqSortedNums(cheapest.map(x => x.vcpu)),
    ram:  uniqSortedNums(cheapest.map(x => x.ram))
  };

  const storage = {
    region: REGION,
    ssd_per_gb_month: 0.10,   // Balanced PD (zonal)
    hdd_per_gb_month: 0.04,   // Standard PD (zonal)
    hdd_free_gb_per_month: 30
  };

  const out = { meta, compute: cheapest, storage };
  atomicWrite(OUT, out);
  logDone(`✅ Wrote ${OUT}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
