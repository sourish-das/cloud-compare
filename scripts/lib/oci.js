// scripts/lib/oci.js
"use strict";

/** Region (OCI identifiers like us-ashburn-1). Workflow should pass OCI_REGION. */
const OCI_REGION = process.env.OCI_REGION || "us-ashburn-1";

/** Public pricing JSON endpoints (override via env if needed) */
const OCI_BLOCK_PRICING_URL =
  process.env.OCI_BLOCK_PRICING_URL ||
  "https://docs.oracle.com/en-us/iaas/pricing/block-volume.json";

const OCI_COMPUTE_PRICING_URL =
  process.env.OCI_COMPUTE_PRICING_URL ||
  "https://docs.oracle.com/en-us/iaas/pricing/compute.json";

/** 1 OCPU = 2 vCPUs (normalization helper) */
function ocpuToVcpu(ocpus) {
  const n = Number(ocpus);
  if (!Number.isFinite(n)) return undefined;
  return n * 2;
}

/** Fetch OCI Block Volume pricing JSON (public) */
async function fetchOciBlockVolumePricing() {
  const r = await fetch(OCI_BLOCK_PRICING_URL, { method: "GET" });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`[OCI] block-volume pricing HTTP ${r.status} ${txt}`);
  }
  return await r.json();
}

/**
 * Extract SSD (Balanced) & HDD (Standard) $/GB-month for a region.
 * Returns { ssd, hdd } or throws if not found.
 */
function pickStoragePricesForRegion(blockJson, region) {
  if (!blockJson || typeof blockJson !== "object" || !blockJson.regions) {
    throw new Error("[OCI] block-volume pricing JSON is missing 'regions'.");
  }
  const reg = blockJson.regions[region];
  if (!reg) {
    const known = Object.keys(blockJson.regions || {}).slice(0, 6);
    throw new Error(
      `[OCI] Region '${region}' not in block-volume pricing. Known sample: ${known.join(", ")} ...`
    );
  }

  // Common keys seen in OCI pricing feeds:
  //  - BlockVolume.Balanced.storage → SSD-equivalent (Balanced)
  //  - BlockVolume.Standard.storage → HDD-equivalent (Standard)
  const balanced = reg["BlockVolume.Balanced"] || reg["balanced"] || reg["BALANCED"];
  const standard = reg["BlockVolume.Standard"] || reg["standard"] || reg["STANDARD"];

  const ssd = Number(balanced?.storage);
  const hdd = Number(standard?.storage);

  if (!Number.isFinite(ssd) || !Number.isFinite(hdd)) {
    const dump = JSON.stringify(reg, null, 2).slice(0, 400);
    throw new Error(
      `[OCI] Could not resolve Balanced/Standard storage prices in '${region}'. Region entry:\n${dump}`
    );
  }
  return { ssd, hdd };
}

/* ---------- Placeholders for Step 2 (Compute) ---------- */

/**
 * Minimal signer stub for OCI REST (wire later for authenticated endpoints).
 * Storage is public; compute integration may require signing depending on approach.
 */
async function signedFetch(url, opts = {}) {
  // In Step 2 we'll sign requests to call /20160918/shapes, etc.
  // For now, fail loudly if someone calls it by mistake.
  throw new Error(
    "[OCI] signedFetch called but not implemented. Compute integration is not enabled yet."
  );
}

/**
 * Shape classification helper.
 *
 * Notes:
 * - Do NOT treat "E*" (e.g., VM.Standard.E4.Flex) as compute. E-series is generally "general".
 * - "HighCPU" shapes are compute-leaning.
 * - "DenseIO" is often memory/storage-heavy and best categorized as memory.
 * - Fallback: high RAM per OCPU => memory.
 */
function classifyOciShape(shapeName, ocpus, memoryGb) {
  if (!shapeName) return null;

  const name = String(shapeName);
  const o = Number(ocpus || 0);
  const m = Number(memoryGb || 0);
  const ratio = o > 0 ? (m / o) : NaN;

  // Strong signals first
  if (/DenseIO/i.test(name)) return "memory";
  if (/HighCPU/i.test(name)) return "compute";

  // Ratio-based fallback (tunable)
  if (Number.isFinite(ratio) && ratio >= 8) return "memory";

  return "general";
}

module.exports = {
  OCI_REGION,
  OCI_BLOCK_PRICING_URL,
  OCI_COMPUTE_PRICING_URL,
  fetchOciBlockVolumePricing,
  pickStoragePricesForRegion,
  ocpuToVcpu,
  classifyOciShape,
  signedFetch
};
``
