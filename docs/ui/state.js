// docs/ui/state.js
// Single source of truth for data loading + (merged) recommendation logic
// This file merges the previous state.js + recommend.js so you can drop in one file for the demo.

export const API_BASE = "./data/prices.json";

/**
 * Architecture preference at the UI layer.
 * For the demo we HARD-BLOCK ARM by default (data still fetched and stored).
 * Allowed values: "x86" | "arm" | "any"
 */
export let ARCH_PREF = "x86";
export function setArchPref(v) {
  ARCH_PREF = (v === "x86" || v === "arm" || v === "any") ? v : "x86";
}

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
    // Balanced PD SSD, Standard HDD, and the HDD 30 GiB-month free band
    ssd_per_gb_month: 0.10,
    hdd_per_gb_month: 0.04,
    hdd_free_gb_per_month: 30
  },
  oci: {
    region: "us-ashburn-1",
    // OCI Block Volume pricing (USD / GB / month)
    block_volume_gb_month: 0.0255,
    // VPU (performance units) price per VPU per GB-month; Balanced = 10 VPUs → +0.017/GB-month
    vpu_per_gb_month: 0.0017
  }
};

/* ---------------------- small helpers ---------------------- */

/** Coerce a provider meta "os" array to plain string values. */
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

/** Ensure a unified `arch` field across providers (and be defensive if absent). */
function normalizeArch(row) {
  if (!row || typeof row !== "object") return row;
  const r = { ...row };
  r.arch = r.arch ?? r.architecture ?? null;
  return r;
}

/** Apply `normalizeArch` to an array safely. */
function mapNormalizeArch(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(normalizeArch);
}

/**
 * UI-level architecture filter:
 * - "x86": keep rows with arch === "x86"; if arch is null/unknown, keep (defensive)
 * - "arm": keep rows with arch === "arm"
 * - "any": keep everything
 */
function applyArchFilter(rows, pref) {
  if (!Array.isArray(rows) || pref === "any") return rows || [];
  if (pref === "arm")    return rows.filter(r => (r?.arch === "arm"));
  /* pref === "x86" */   return rows.filter(r => (r?.arch == null || r.arch === "x86"));
}

/* ---------------------- storage merge ---------------------- */

function mergeStorage(raw) {
  const incomingStorage = raw?.storage || {};
  const ociScopedStorage = raw?.oci?.storage || {};

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
      ),
      hdd_free_gb_per_month: Number(
        incomingStorage.gcp?.hdd_free_gb_per_month ?? STORAGE_CFG.gcp.hdd_free_gb_per_month
      )
    },
    oci: {
      region: (incomingStorage.oci?.region ?? ociScopedStorage.region) ?? STORAGE_CFG.oci.region,
      block_volume_gb_month: Number(
        (incomingStorage.oci?.block_volume_gb_month ?? ociScopedStorage.block_volume_gb_month)
        ?? STORAGE_CFG.oci.block_volume_gb_month
      ),
      vpu_per_gb_month: Number(
        (incomingStorage.oci?.vpu_per_gb_month ?? ociScopedStorage.vpu_per_gb_month)
        ?? STORAGE_CFG.oci.vpu_per_gb_month
      )
    }
  };
}

/* ---------------------- loader ---------------------- */

/**
 * Loads the aggregated file (docs/data/prices.json),
 * tolerates both WRAPPED and FLAT shapes, normalizes to:
 *   { meta, azure:[], aws:[], gcp:[], oci, generatedAt? }
 *
 * Also merges any `storage` blocks over STORAGE_CFG (without wiping defaults),
 * then **normalizes arch** and **filters out ARM** at the UI layer based on ARCH_PREF.
 */
export async function loadPricesAndMeta() {
  const url = `${API_BASE}?v=${Date.now()}`; // cache-buster
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
    azure = Array.isArray(raw.azure?.compute) ? raw.azure.compute : [];
    aws   = Array.isArray(raw.aws?.compute)   ? raw.aws.compute   : [];
    gcp   = Array.isArray(raw.gcp?.compute)   ? raw.gcp.compute   : [];
    oci   = raw.oci?.compute ?? raw.oci ?? null;
    meta  = raw.meta || raw.azure?.meta || raw.aws?.meta || raw.gcp?.meta || {};
  } else {
    azure = Array.isArray(raw.azure) ? raw.azure : [];
    aws   = Array.isArray(raw.aws)   ? raw.aws   : [];
    gcp   = Array.isArray(raw.gcp)   ? raw.gcp   : [];
    oci   = raw.oci?.compute ?? raw.oci ?? null;
    meta  = raw.meta || {};
  }

  // ---- Merge storage overrides safely ----
  mergeStorage(raw);

  // ---- Defensive meta fallback ----
  const fromFileOs = coerceOsList(meta.os);
  const fallbackOs = coerceOsList(FALLBACK_META.os).length
    ? coerceOsList(FALLBACK_META.os)
    : ["Linux", "RHEL", "Windows"];

  const normMeta = {
    os:   fromFileOs.length ? fromFileOs : fallbackOs,
    vcpu: FALLBACK_META.vcpu,
    ram:  FALLBACK_META.ram
  };

  // ---- Normalize and UI-filter architecture for AWS/Azure/GCP rows ----
  const awsNorm   = applyArchFilter(mapNormalizeArch(aws),   ARCH_PREF);
  const azureNorm = applyArchFilter(mapNormalizeArch(azure), ARCH_PREF);
  const gcpNorm   = applyArchFilter(mapNormalizeArch(gcp),   ARCH_PREF);

  // ---- Optional QoL: prime OCI RHEL uplift for BYOS (if present) ----
  try {
    const metaHint =
      (raw?.oci?.rhel && Number(raw.oci.rhel.license_per_vcpu_hour)) ||
      (raw?.meta?.oci?.rhel_rate_per_vcpu && Number(raw.meta.oci.rhel_rate_per_vcpu));

    if (typeof window !== "undefined" &&
        typeof window.OCI_RHEL_RATE_PER_VCPU === "undefined" &&
        Number.isFinite(metaHint) && metaHint >= 0) {
      window.OCI_RHEL_RATE_PER_VCPU = metaHint;
    }
  } catch (_) { /* non-fatal */ }

  // ---- Debug visibility of filtered ARM rows (demo mode) ----
  if (ARCH_PREF === "x86") {
    const armDrop = (arr) => (arr || []).filter(r => (normalizeArch(r)?.arch === "arm")).length;
    try { console.debug("[UI] ARM rows filtered (demo mode):", {
      aws:   armDrop(aws),
      azure: armDrop(azure),
      gcp:   armDrop(gcp)
    }); } catch {}
  }

  return {
    meta: normMeta,
    azure: azureNorm,
    aws:   awsNorm,
    gcp:   gcpNorm,
    oci, // structured block unchanged; flatten later in recommender
    generatedAt: raw.generatedAt
  };
}

/* ============================================================
 * MERGED RECOMMENDER (from recommend.js)
 * ============================================================ */

const HOURS_PER_MONTH = 730; // standard approximation used across the UI

/** Storage price → hourly (by provider). Includes GCP 30 GiB HDD free band. */
export function computeStorageHourly(row, inputs) {
  const size = Number(inputs?.storageGiB || 0);
  const type = String(inputs?.storageType || 'HDD').toUpperCase(); // 'HDD' | 'SSD'
  if (!(size > 0)) return 0;

  const p = String(row?.provider || '').toLowerCase();
  let monthly = 0;

  if (p === 'aws') {
    monthly = size * Number(
      type === 'SSD' ? STORAGE_CFG.aws.ssd_per_gb_month : STORAGE_CFG.aws.hdd_st1_per_gb_month
    );
  }
  else if (p === 'azure') {
    const table = (type === 'SSD') ? (STORAGE_CFG.azure.ssd_monthly || {})
                                   : (STORAGE_CFG.azure.hdd_monthly || {});
    const keys = Object.keys(table).map(k => Number(k)).filter(n => Number.isFinite(n)).sort((a,b)=>a-b);
    // Azure disks are charged by SKU sizes; choose the next available size >= requested (min 32 GiB for HDD)
    const want = Math.max(type === 'HDD' ? 32 : 1, size);
    const chosen = keys.find(k => k >= want) || keys[keys.length - 1];
    monthly = Number(table[chosen] || 0);
  }
  else if (p === 'gcp') {
    if (type === 'SSD') {
      monthly = size * Number(STORAGE_CFG.gcp.ssd_per_gb_month);
    } else {
      const free = Number(STORAGE_CFG.gcp.hdd_free_gb_per_month || 0); // 30 GiB-month free band
      const chargeable = Math.max(0, size - free);
      monthly = chargeable * Number(STORAGE_CFG.gcp.hdd_per_gb_month);
    }
  }
  else if (p === 'oci') {
    // OCI Block Volume: base per GB-month; SSD-like performance tiers add VPU cost
    const base = size * Number(STORAGE_CFG.oci.block_volume_gb_month);
    if (type === 'SSD') {
      const vpuPrice = Number(STORAGE_CFG.oci.vpu_per_gb_month || 0);
      const balancedVpu = 10; // Balanced = 10 VPUs
      monthly = base + (size * vpuPrice * balancedVpu);
    } else {
      monthly = base; // HDD-style: base only
    }
  }

  return monthly / HOURS_PER_MONTH;
}

/* -------- Generation ranking and sorter (to keep performance neck-to-neck) -------- */
function _num(x){ const n = Number(x); return Number.isFinite(n) ? n : 0; }
function genRankAWS(inst){ const m = String(inst||'').match(/[0-9]{1,2}/); return m ? _num(m[0]) : 0; }
function genRankAzure(sku){ const m = String(sku||'').toLowerCase().match(/v([0-9]{1,2})/); return m ? _num(m[1]) : 0; }
function genRankGCP(type){ const s = String(type||'').split('-')[0]; const m = s && s.match(/[a-z]*([0-9]{1,2})[a-z]?/i); return m ? _num(m[1]) : 0; }
function genRankOCI(shape){ const s = String(shape||''); const m = s.match(/\.E([0-9]+)/i); if (m) return _num(m[1]); if (/\.A4\./i.test(s)) return 4; if (/\.A2\./i.test(s)) return 2; if (/\.A1\./i.test(s)) return 1; return 0; }
function genRank(row){ const p = String(row?.provider||'').toLowerCase(); const id = row?.instance || row?.displayInstance || ''; if(p==='aws')return genRankAWS(id); if(p==='azure')return genRankAzure(id); if(p==='gcp')return genRankGCP(id); if(p==='oci')return genRankOCI(id); return 0; }
function srcRank(r){ return r?.source === 'catalog' ? 1 : 0; }
function sortForAuto(a, b){ return ( (a.totalHr - b.totalHr) || (genRank(b.row) - genRank(a.row)) || ((a.row.vcpu||0) - (b.row.vcpu||0)) || (srcRank(b.row) - srcRank(a.row)) ); }

/** Minimal allow-list to avoid very old families in Auto results. */
function allowListOK(row){
  const p = String(row?.provider || '').toLowerCase();
  const inst = String(row?.instance || '').toLowerCase();
  if (p === 'aws')   return /^(m[6-9]|c[6-9]|r[6-9]|t4)/.test(inst); // drop m4/m5-ancients
  if (p === 'azure') return /(dv5|das v5|dps v5|ev5|eas v5|eps v5|fsv2)/i.test(inst) || /standard d\d+ps v5/i.test(inst);
  if (p === 'gcp')   return /^(n4|n4d|t2a|t2d|c3|c4|c4a|m3)/.test(inst);
  if (p === 'oci')   return /(VM\.Standard\.E[3-6]\.Flex|VM\.Standard3\.Flex|VM\.Optimized3\.Flex|VM\.Standard\.A[124]\.Flex)/i.test(inst);
  return true;
}

/* -------- Candidate prep -------- */
function buildCandidates(rows, inputs) {
  if (!Array.isArray(rows)) return [];
  const os = String(inputs?.os || 'Linux');

  let list = mapNormalizeArch(rows);
  list = applyArchFilter(list, ARCH_PREF); // x86-only for demo
  list = list.filter(r => String(r.os) === os && allowListOK(r));

  const withTotals = list.map(r => ({ row: r, totalHr: Number(r.pricePerHourUSD || 0) + computeStorageHourly(r, inputs) }));
  withTotals.sort(sortForAuto);
  return withTotals.map(x => x.row);
}

/* -------- OCI: flatten families → rows for the requested vCPU/RAM -------- */
function flattenOciFamilies(ociCompute, inputs) {
  const out = [];
  if (!ociCompute || !ociCompute.linux) return out;

  const vcpu = Number(inputs?.vcpu || 0);
  const ramGiB = Number(inputs?.ramGiB || inputs?.ram || 0);
  const families = [
    { key: 'intel', list: ociCompute.linux.intel || [] },
    { key: 'amd',   list: ociCompute.linux.amd   || [] },
    { key: 'arm',   list: ociCompute.linux.arm   || [] },
  ];

  for (const { list } of families) {
    for (const ent of list) {
      const ocpu = vcpu / 2; // 1 OCPU = 2 vCPU
      const computeHr = (ocpu * Number(ent.ocpu_per_hour || 0)) + (ramGiB * Number(ent.ram_gb_per_hour || 0));
      out.push({
        provider: 'oci',
        instance: ent.shape,
        vcpu, ram: ramGiB,
        category: 'general',
        pricePerHourUSD: computeHr,
        region: ociCompute?.region || 'us-ashburn-1',
        os: 'Linux',
        arch: ent.architecture || null,
        source: 'catalog'
      });
    }
  }
  return out;
}

/* -------- Public API: recommend per provider -------- */
export function recommend(data, inputs) {
  const awsRows   = buildCandidates(data?.aws   || [], inputs);
  const azureRows = buildCandidates(data?.azure || [], inputs);
  const gcpRows   = buildCandidates(data?.gcp   || [], inputs);

  // Pick cheapest per category (general/compute/memory)
  const cats = ['general','compute','memory'];
  const pickCheapestPerCategory = (rows) => {
    const res = { general: null, compute: null, memory: null };
    const withTotals = (rows || []).map(r => ({ row: r, totalHr: Number(r.pricePerHourUSD||0) + computeStorageHourly(r, inputs) }));
    for (const c of cats) {
      const pick = withTotals.filter(x => String(x.row.category) === c).sort(sortForAuto)[0]?.row || null;
      res[c] = pick;
    }
    return res;
  };

  const awsPicks   = pickCheapestPerCategory(awsRows);
  const azurePicks = pickCheapestPerCategory(azureRows);
  const gcpPicks   = pickCheapestPerCategory(gcpRows);

  // OCI: flatten families, then compute cheapest per family + overall
  const ociRows = flattenOciFamilies(data?.oci || {}, inputs);
  const ociFiltered = applyArchFilter(ociRows, ARCH_PREF).filter(allowListOK);
  const ociWithTotals = ociFiltered.map(r => ({ row: r, totalHr: r.pricePerHourUSD + computeStorageHourly(r, inputs) }));

  const byFam = { intel: null, amd: null, arm: null };
  let overall = null;
  for (const x of ociWithTotals) {
    const fam = /\.Standard3\.|\.Optimized3\./i.test(x.row.instance) ? 'intel'
              : /\.E[3-6]\.Flex/i.test(x.row.instance)                 ? 'amd'
              : /\.A[124]\.Flex/i.test(x.row.instance)                 ? 'arm'
              : null;
    if (!fam) continue;
    if (!byFam[fam] || sortForAuto(x, byFam[fam]) < 0) byFam[fam] = x;
    if (!overall   || sortForAuto(x, overall)   < 0) overall = x;
  }

  const ociPicks = {
    intel:  byFam.intel?.row  || null,
    amd:    byFam.amd?.row    || null,
    arm:    byFam.arm?.row    || null,
    overall: overall?.row     || null
  };

  return {
    aws: awsPicks,
    azure: azurePicks,
    gcp: gcpPicks,
    oci: ociPicks,
    meta: { archPref: ARCH_PREF, hoursPerMonth: HOURS_PER_MONTH }
  };
}
