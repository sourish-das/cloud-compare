// docs/ui/state.js
// Single source of truth for prices the UI loads: docs/data/prices.json

export const API_BASE = "./data/prices.json";

/**
 * Default dropdown meta used if the aggregated file omits/sparsely defines meta.
 * We keep these as STRINGS so the UI can bind directly to option values.
 *
 * NOTE: vcpu and ram here are intentionally authoritative for the UI.
 */
export const FALLBACK_META = {
  os:   ["Linux", "RHEL", "Windows"], // RHEL added
  vcpu: [1, 2, 4, 6, 8, 12, 18, 24],
  ram:  [1, 2, 4, 8, 16, 32, 64, 128]
};

// In-memory storage pricing defaults
// These are merged (not replaced) by any `storage` block in prices.json
export let STORAGE_CFG = {
  aws: {
    region: "us-east-1",
    ssd_per_gb_month: 0.08,
    hdd_st1_per_gb_month: 0.045
  },
  azure: {
    region: "eastus",
    // Monthly USD by disk size
    ssd_monthly: {4:0.3,8:0.6,16:1.2,32:2.4,64:4.8,128:9.6,256:19.2,512:38.4},
    hdd_monthly: {32:1.536,64:3.008,128:5.888,256:11.328}
  },
  gcp: {
    region: "us-east1",
    ssd_per_gb_month: 0.17,   // PD-SSD typical retail
    hdd_per_gb_month: 0.04    // PD-Standard typical retail
  },
  oci: {
    region: "us-ashburn-1",
    // OCI Block Volume base price (USD / GB / month)
    block_volume_gb_month: 0.0255
  }
};

/**
 * Coerce a provider meta "os" array to plain string values.
 * Accepts either ["Linux","RHEL","Windows"] or [{value:"Linux"}, ...].
 */
function coerceOsList(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const x of arr) {
    if (typeof x === "string" && x.trim()) out.push(x.trim());
    else if (x && typeof x === "object" && typeof x.value === "string" && x.value.trim()) {
      out.push(x.value.trim());
    }
  }
  return out;
}

/**
 * Loads the aggregated file (docs/data/prices.json),
 * tolerates both WRAPPED and FLAT shapes, normalizes to:
 *   { meta, azure:[], aws:[], gcp:[], oci, generatedAt? }
 *
 * Also merges any `storage` blocks over STORAGE_CFG
 * (without wiping defaults).
 */
export async function loadPricesAndMeta() {
  // Cache-buster avoids GH Pages CDN serving stale JSON
  const url = `${API_BASE}?v=${Date.now()}`;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`Failed to read ${API_BASE} (HTTP ${r.status})`);
  const raw = await r.json();

  // ---- Normalize structure (WRAPPED vs FLAT) ----
  let azure = [];
  let aws   = [];
  let gcp   = [];
  let oci   = null;  // normalized compute block for OCI
  let meta  = {};

  const looksWrapped =
    raw && typeof raw === "object" &&
    raw.azure && raw.aws && raw.gcp &&
    !Array.isArray(raw.azure) &&
    !Array.isArray(raw.aws) &&
    !Array.isArray(raw.gcp);

  if (looksWrapped) {
    // Older/alternate aggregator output:
    // { azure:{compute:[]}, aws:{compute:[]}, gcp:{compute:[]}, oci:{compute:{...}}? }
    azure = Array.isArray(raw.azure?.compute) ? raw.azure.compute : [];
    aws   = Array.isArray(raw.aws?.compute)   ? raw.aws.compute   : [];
    gcp   = Array.isArray(raw.gcp?.compute)   ? raw.gcp.compute   : [];

    // Normalize OCI to always return the compute block
    // Accept either oci.compute (wrapped) or oci (already compute)
    oci   = raw.oci?.compute ?? raw.oci ?? null;

    meta  = raw.meta || raw.azure?.meta || raw.aws?.meta || raw.gcp?.meta || {};
  } else {
    // Preferred FLAT shape (produced by your orchestrator)
    // { meta:{...}, azure:[], aws:[], gcp:[], oci:{...} }
    azure = Array.isArray(raw.azure) ? raw.azure : [];
    aws   = Array.isArray(raw.aws)   ? raw.aws   : [];
    gcp   = Array.isArray(raw.gcp)   ? raw.gcp   : [];

    // Same normalization here for safety
    oci   = raw.oci?.compute ?? raw.oci ?? null;

    meta  = raw.meta || {};
  }

  // ---- Merge storage overrides safely (do not wipe defaults) ----
  // Top-level storage block (extensible; not strictly required today)
  const incomingStorage = raw.storage || {};
  // Also allow provider-scoped storage under raw.oci.storage if ever added
  const ociScopedStorage = raw.oci?.storage || {};

  STORAGE_CFG = {
    aws: {
      region: incomingStorage.aws?.region ?? STORAGE_CFG.aws.region,
      ssd_per_gb_month: Number(
        incomingStorage.aws?.ssd_per_gb_month ?? STORAGE_CFG.aws.ssd_per_gb_month
      ),
      hdd_st1_per_gb_month: Number(
        incomingStorage.aws?.hdd_st1_per_gb_month ?? STORAGE_CFG.aws.hdd_st1_per_gb_month
      )
    },
    azure: {
      region: incomingStorage.azure?.region ?? STORAGE_CFG.azure.region,
      ssd_monthly: {
        ...(STORAGE_CFG.azure.ssd_monthly || {}),
        ...(incomingStorage.azure?.ssd_monthly || {})
      },
      hdd_monthly: {
        ...(STORAGE_CFG.azure.hdd_monthly || {}),
        ...(incomingStorage.azure?.hdd_monthly || {})
      }
    },
    gcp: {
      region: incomingStorage.gcp?.region ?? STORAGE_CFG.gcp.region,
      ssd_per_gb_month: Number(
        incomingStorage.gcp?.ssd_per_gb_month ?? STORAGE_CFG.gcp.ssd_per_gb_month
      ),
      hdd_per_gb_month: Number(
        incomingStorage.gcp?.hdd_per_gb_month ?? STORAGE_CFG.gcp.hdd_per_gb_month
      )
    },
    oci: {
      // Prefer top-level incoming override; else allow raw.oci.storage; else keep default
      region: (incomingStorage.oci?.region ?? ociScopedStorage.region) ?? STORAGE_CFG.oci.region,
      block_volume_gb_month: Number(
        (incomingStorage.oci?.block_volume_gb_month ?? ociScopedStorage.block_volume_gb_month) ?? STORAGE_CFG.oci.block_volume_gb_month
      )
    }
  };

  // ---- Defensive meta fallback (ensure arrays exist) ----
  // Accept both ["Linux","RHEL","Windows"] and [{value:"Linux"}, ...]
  const fromFileOs = coerceOsList(meta.os);
  const fallbackOs = coerceOsList(FALLBACK_META.os).length
    ? coerceOsList(FALLBACK_META.os)
    : ["Linux", "RHEL", "Windows"];

  // **ENFORCE** the UI dropdowns to the requested fixed sets.
  const normMeta = {
    os:   fromFileOs.length ? fromFileOs : fallbackOs,
    vcpu: FALLBACK_META.vcpu,
    ram:  FALLBACK_META.ram
  };

  // ---- Optional QoL: prime OCI RHEL uplift for BYOS (if present) ----
  // If the aggregated JSON carries an uplift hint, initialize window.OCI_RHEL_RATE_PER_VCPU once.
  try {
    const metaHint =
      (raw?.oci?.rhel && Number(raw.oci.rhel.license_per_vcpu_hour)) ||
      (raw?.meta?.oci?.rhel_rate_per_vcpu && Number(raw.meta.oci.rhel_rate_per_vcpu));

    if (typeof window !== "undefined" &&
        typeof window.OCI_RHEL_RATE_PER_VCPU === "undefined" &&
        Number.isFinite(metaHint) && metaHint >= 0) {
      window.OCI_RHEL_RATE_PER_VCPU = metaHint;
    }
  } catch (_) {
    // non-fatal
  }

  return {
    meta: normMeta,
    azure,
    aws,
    gcp,
    oci,
    generatedAt: raw.generatedAt
  };
}
