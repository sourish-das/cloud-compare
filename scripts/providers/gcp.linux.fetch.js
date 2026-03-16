// scripts/providers/gcp.linux.fetch.js
// Node 18+ (global fetch)

"use strict";

const path = require("path");
const fs = require("fs/promises");

const {
  CE_SERVICE_ID,
  getAccessTokenFromADC,
  listRegionZones,
  listZoneMachineTypes
} = require("../lib/gcp");

// -------- env / paths (Linux-only phase) --------
const PROJECT_ID  = process.env.GCP_PROJECT_ID;
const REGIONS     = (process.env.GCP_REGIONS || "us-east1").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
const MT_OUT      = process.env.GCP_MACHINE_TYPES_FILE || path.join("data", "gcp-linux-machine-types.json");
const CATALOG_OUT = process.env.GCP_CATALOG_FILE       || path.join("data", "gcp-linux-catalog.json");
const BILLING_KEY = process.env.GCP_BILLING_API_KEY;

// -------- helpers --------
async function ensureDir(p) {
  await fs.mkdir(path.dirname(p), { recursive: true });
}

async function fetchAllCatalogSkus() {
  if (!BILLING_KEY) throw new Error("GCP_BILLING_API_KEY env is required to fetch Cloud Billing Catalog.");
  const base = `https://cloudbilling.googleapis.com/v1/services/${CE_SERVICE_ID}/skus`;
  let token = "";
  const out = [];
  while (true) {
    const url = `${base}?key=${encodeURIComponent(BILLING_KEY)}&pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Catalog HTTP ${r.status}: ${await r.text().catch(()=>"<no body>")}`);
    const j = await r.json();
    out.push(...(j.skus || []));
    token = j.nextPageToken || "";
    if (!token) break;
  }
  return out;
}

async function main() {
  if (!PROJECT_ID) throw new Error("GCP_PROJECT_ID env is required.");
  const accessToken = await getAccessTokenFromADC();

  // ---------- DISCOVERY ----------
  const regionMap = {};
  for (const region of REGIONS) {
    const zones = await listRegionZones(PROJECT_ID, region, accessToken);
    const rows = [];
    for (const z of zones) {
      const mts = await listZoneMachineTypes(PROJECT_ID, z, accessToken);
      for (const mt of mts) {
        // Predefined only (lib.gcp already filters), keep minimal shape info
        rows.push({ name: mt.name, guestCpus: mt.guestCpus, memoryMb: mt.memoryMb, zone: z });
      }
    }
    // de-dup per type across zones
    const seen = new Set();
    const uniq = [];
    for (const r of rows) {
      const k = String(r.name).toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      uniq.push({ ...r, region });
    }
    regionMap[region] = uniq;
    console.log(`[GCP][disc] ${region} zones=${zones.length} types=${uniq.length}`);
  }

  await ensureDir(MT_OUT);
  await fs.writeFile(MT_OUT, JSON.stringify(regionMap, null, 2));
  console.log(`Wrote ${MT_OUT}`);

  // ---------- CATALOG ----------
  const skus = await fetchAllCatalogSkus();
  await ensureDir(CATALOG_OUT);
  await fs.writeFile(CATALOG_OUT, JSON.stringify(skus, null, 2));
  console.log(`Wrote ${CATALOG_OUT} (skus=${skus.length})`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
