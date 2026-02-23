// scripts/providers/oci.fetch.js
// Node 18+ (global fetch)

const path = require("path");
const fs = require("fs");
const {
  atomicWrite,
  warnAndSkipWriteOnEmpty,
  logStart,
  logDone
} = require("../lib/common");

const {
  OCI_REGION,
  fetchOciBlockVolumePricing,
  pickStoragePricesForRegion
} = require("../lib/oci");

// Align with GCP: allow workflow to control output location
const OUT = process.env.OUTPUT_PATH
  ? process.env.OUTPUT_PATH
  : path.join("docs", "data", "oci", "oci.prices.json");

async function fetchOciPrices() {
  logStart("[OCI] Fetching pricing (storage first)…");

  // 1) Storage (public JSON; no auth needed)
  const blockJson = await fetchOciBlockVolumePricing();
  const { ssd, hdd } = pickStoragePricesForRegion(blockJson, OCI_REGION);

  logDone("[OCI] Pricing file loaded");
  return {
    storage: {
      region: OCI_REGION,
      ssd_per_gb_month: ssd,
      hdd_per_gb_month: hdd
    }
  };
}

async function main() {
  const json = await fetchOciPrices();

  // For now, compute is empty (we will append real rows in Step 3).
  const out = {
    meta: {
      os: ["Linux", "Windows"],
      vcpu: [],
      ram: []
    },
    compute: [],
    storage: json.storage
  };

  // Ensure output directory exists (important when writing to docs/)
  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  // If you want a safety guard like GCP: don't write empty/invalid payloads
  // (keeps behavior robust if upstream fetch returns unexpected data)
  warnAndSkipWriteOnEmpty(out, OUT);

  atomicWrite(OUT, out);
  console.log(`✅ Wrote ${OUT}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
