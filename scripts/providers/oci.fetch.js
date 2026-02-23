// scripts/providers/oci.fetch.js
// Node 18+ (no network required)

const path = require("path");
const fs = require("fs");

const {
  atomicWrite,
  warnAndSkipWriteOnEmpty,
  logStart,
  logDone
} = require("../lib/common");

const OCI_REGION = process.env.OCI_REGION || "us-ashburn-1";
const OUT = process.env.OUTPUT_PATH
  ? process.env.OUTPUT_PATH
  : path.join("docs", "data", "oci", "oci.prices.json");

const SRC_PATH = path.join(__dirname, "oci.pricing-source.json");

function loadPricingSource() {
  const raw = fs.readFileSync(SRC_PATH, "utf-8");
  return JSON.parse(raw);
}

async function main() {
  logStart("[OCI] Building pricing from local source…");

  const src = loadPricingSource();

  const out = {
    meta: {
      provider: "oci",
      region: OCI_REGION,
      currency: src?.meta?.currency || "USD",
      os: ["Linux", "Windows"],
      source: "scripts/providers/oci.pricing-source.json"
    },
    // Keep raw primitives – lib/oci.js and UI can compute totals consistently
    compute: {
      linux: src.linux,
      windows: src.windows
    },
    storage: {
      region: OCI_REGION,
      block_volume_gb_month: src.storage.block_volume_gb_month
    }
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  warnAndSkipWriteOnEmpty(out, OUT);
  atomicWrite(OUT, out);

  logDone(`[OCI] ✅ Wrote ${OUT}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
