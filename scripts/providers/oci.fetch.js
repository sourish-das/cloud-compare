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

function assert(condition, message) {
  if (!condition) throw new Error(`[OCI] ${message}`);
}

async function main() {
  logStart("[OCI] Building pricing from local source…");

  const src = loadPricingSource();

  // ---- validation
  assert(src.linux, "Missing 'linux' section");
  assert(src.linux.amd_e4, "Missing 'linux.amd_e4'");
  assert(src.linux.ampere_a1, "Missing 'linux.ampere_a1'");
  assert(src.windows, "Missing 'windows' section");
  assert(
    typeof src.storage?.block_volume_gb_month === "number",
    "Missing or invalid 'storage.block_volume_gb_month'"
  );

  const out = {
    meta: {
      provider: "oci",
      region: OCI_REGION,
      currency: src?.meta?.currency || "USD",
      os: ["Linux", "Windows"],
      source: src?.meta?.source || "scripts/providers/oci.pricing-source.json",
      last_verified: src?.meta?.last_verified || null
    },
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
