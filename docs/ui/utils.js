// docs/ui/utils.js
// Shared UI helpers: formatting, DOM, storage pricing resolvers, and (optionally)
// architecture normalization + stable sorting utilities. Safe to use alongside
// the merged state.js recommender — implementations here match state.js.

export const HRS_PER_MONTH = 730;

/* ---------- Formatting & math helpers ---------- */
export function fmt(n) {
  return (n == null || isNaN(n)) ? "—" : `$${Number(n).toFixed(4)}`;
}

export function fmtDelta(n) {
  if (n == null || isNaN(n)) return "—";
  const v = Number(n);
  const sign = v > 0 ? "+" : "";
  return `${sign}$${v.toFixed(4)}`;
}

export function monthly(ph) {
  return (ph == null || isNaN(ph)) ? null : Number(ph) * HRS_PER_MONTH;
}

export function sumSafe(a, b) {
  const na = (a == null || isNaN(a)) ? 0 : Number(a);
  const nb = (b == null || isNaN(b)) ? 0 : Number(b);
  if (a == null && b == null) return null;
  return na + nb;
}

/* ---------- DOM helpers ---------- */
export function fillSelect(id, items) {
  const el = document.getElementById(id);
  if (!el) return;

  el.innerHTML = "";

  // Accept strings (used directly as value/text) or objects
  for (const it of (items || [])) {
    const opt = document.createElement("option");

    if (typeof it === "string") {
      opt.value = it;
      opt.textContent = it;
    } else if (it && typeof it === "object") {
      opt.value = (it.value != null) ? String(it.value) : "";
      opt.textContent = (it.text != null) ? String(it.text) : String(it.value ?? "");
      if (it.disabled) opt.disabled = true;
      if (it.selected) opt.selected = true;
    } else {
      continue;
    }

    el.appendChild(opt);
  }
}

/**
 * Ensures an option with given value exists in the select.
 * If not present, insert it after the "Linux" option (if found),
 * otherwise append at the end.
 */
export function ensureSelectOption(id, value, label) {
  const el = document.getElementById(id);
  if (!el) return;

  const needle = String(value).toLowerCase();
  const exists = Array.from(el.options).some(o => String(o.value).toLowerCase() === needle);
  if (exists) return;

  const opt = document.createElement("option");
  opt.value = value;
  opt.textContent = label || String(value);

  // Try to place after Linux for nicer order
  const linuxIdx = Array.from(el.options).findIndex(o => String(o.value).toLowerCase() === "linux");
  if (linuxIdx >= 0 && linuxIdx < el.options.length - 1) {
    el.add(opt, el.options[linuxIdx + 1]);
  } else {
    el.add(opt);
  }
}

export function setSelectValue(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  const current = el.value;
  const match = Array.from(el.options).find(o => o.value == value);
  el.value = match ? value : current;
}

/**
 * Set text into an element, optionally allowing trusted HTML.
 * Use { html: true } ONLY for known, code-generated strings.
 */
export function safeSetText(id, value, { html = false } = {}) {
  const el = document.getElementById(id);
  if (!el) return;
  const v = (value == null) ? "" : String(value);
  if (html) {
    el.innerHTML = v; // trusted, code-generated strings only
  } else {
    el.textContent = v; // default: escape HTML
  }
}

export function appendToText(id, extra) {
  const el = document.getElementById(id);
  if (el) el.textContent = (el.textContent || "") + extra;
}

export function setStatus(msg, level = "info") {
  const el = document.getElementById("status");
  if (!el) return;
  const err  = "var(--err,#b91c1c)";
  const warn = "var(--warn,#b45309)";
  const mut  = "var(--muted,#666)";
  el.textContent = msg;
  el.style.color =
    (level === "error") ? err :
    (level === "warn")  ? warn : mut;
}

/* ---------- Numeric helpers ---------- */
export function nearestCeil(requested, allowed) {
  const sorted = [...(allowed || [])].sort((a, b) => a - b);
  for (const s of sorted) if (requested <= s) return s;
  return sorted.length ? sorted[sorted.length - 1] : null;
}

/* ---------- Azure disk label helpers ---------- */
export function sizeToAzureSku(type, size) {
  if (!isFinite(size)) return null;
  if (type === "ssd") {
    const map = {4:"E1",8:"E2",16:"E3",32:"E4",64:"E6",128:"E10",256:"E15",512:"E20",1024:"E30",2048:"E40",4096:"E50"};
    return map[size] || null;
  } else {
    const map = {32:"S4",64:"S6",128:"S10",256:"S15",512:"S20",1024:"S30",2048:"S40",4096:"S50"};
    return map[size] || null;
  }
}

/* ---------- Storage price resolvers ---------- */
/**
 * AWS: simple per-GB × amount table (gp3 for SSD, st1 for HDD).
 * Returns monthly USD or null.
 */
export function getAwsStorageMonthlyFromCfg(type, gb, awsCfg) {
  if (!isFinite(gb) || gb <= 0) return null;
  const t = (type || "hdd").toLowerCase();
  if (t === "ssd") {
    return gb * Number(awsCfg?.ssd_per_gb_month ?? 0.08);
  }
  return gb * Number(awsCfg?.hdd_st1_per_gb_month ?? 0.045);
}

/**
 * Azure: using monthly lookup tables.
 * Returns { sku, size, monthlyUSD, adjusted }
 */
export function getAzureStorageSkuAndMonthlyFromCfg(type, gb, azCfg) {
  const t = (type || "hdd").toLowerCase();
  if (!isFinite(gb) || gb <= 0)
    return { sku: null, size: null, monthlyUSD: null, adjusted: false };

  const ssdTbl = azCfg?.ssd_monthly || {};
  const hddTbl = azCfg?.hdd_monthly || {};

  if (t === "ssd") {
    const size = nearestCeil(gb, Object.keys(ssdTbl).map(Number));
    const monthlyUSD = size != null ? (ssdTbl[size] ?? null) : null;
    const sku = sizeToAzureSku("ssd", size);
    return { sku, size, monthlyUSD, adjusted: (size != null && size !== gb) };
  }

  // HDD branch
  const allowed = Object.keys(hddTbl).map(Number);
  let size = nearestCeil(gb, allowed);
  if (size == null && allowed.length) size = allowed.sort((a, b) => a - b)[0];
  if (size != null && size < 32) size = 32; // 32 GiB minimum for HDD

  const monthlyUSD = size != null ? (hddTbl[size] ?? null) : null;
  const sku = sizeToAzureSku("hdd", size);
  return { sku, size, monthlyUSD, adjusted: (size != null && size !== gb) };
}

/* ---------- GCP storage pricing ---------- */
/**
 * GCP PD-Balanced (SSD) and PD-Standard (HDD).
 * - SSD: simple per-GB rate (Balanced PD).
 * - HDD: per-GB rate with a one-time free 30 GiB-month band (if provided in cfg).
 * Returns monthly USD or null.
 */
export function getGcpStorageMonthlyFromCfg(type, gb, gcpCfg) {
  if (!isFinite(gb) || gb <= 0) return null;
  const t = (type || "hdd").toLowerCase();

  if (t === "ssd") {
    // Balanced PD default = $0.10/GB-month (overridden by STORAGE_CFG.gcp if present)
    const rate = Number(gcpCfg?.ssd_per_gb_month ?? 0.10);
    return gb * rate;
  }

  // HDD (PD-Standard) with one-time 30 GiB-month free band
  const hddRate = Number(gcpCfg?.hdd_per_gb_month ?? 0.04);
  const freeBand = Number(gcpCfg?.hdd_free_gb_per_month ?? 0) || 0;
  const billableGiB = Math.max(0, Number(gb) - freeBand);
  return billableGiB * hddRate;
}

/* ---------- OCI storage pricing ---------- */
/**
 * OCI Block Volume monthly USD:
 * Monthly = GB × (base_per_GB_month + VPUs × vpu_price_per_GB_month)
 * - Back-compat: if called as (gb, cfg) → assume SSD/Balanced (10 VPUs).
 * - If called as ('ssd'|'hdd', gb, cfg):
 *     'ssd' → Balanced (10 VPUs)
 *     'hdd' → Lower Cost (0 VPUs)
 * Note: Defaults (0.0255 base; 0.0017 per VPU per GB-month) can be overridden
 *       by STORAGE_CFG.oci in state.js.
 */
export function getOciStorageMonthlyFromCfg(arg1, arg2, arg3) {
  let type = 'ssd', gb, cfg;
  if (typeof arg1 === 'string') { type = String(arg1).toLowerCase(); gb = arg2; cfg = arg3; }
  else { gb = arg1; cfg = arg2; }
  if (!isFinite(gb) || gb <= 0) return null;

  const base   = Number(cfg?.block_volume_gb_month ?? 0.0255);
  const vpuUSD = Number(cfg?.vpu_per_gb_month ?? 0.0017);
  const vpus   = (type === 'hdd') ? 0 : 10; // SSD → Balanced (10), HDD → Lower Cost (0)

  return Number(gb) * (base + vpus * vpuUSD);
}

/* ---------- Reset all UI fields (AWS + Azure + GCP + OCI) ---------- */
export function resetCards() {
  // Titles use trusted HTML for bold labels; everything else stays text-only.
  safeSetText("awsInstance", `<strong>Recommended Instance:</strong> …`, { html: true });
  safeSetText("awsCpu",     "vCPU: …");
  safeSetText("awsRam",     "RAM: …");
  safeSetText("awsPrice",   "EC2 Price/hr: —");
  safeSetText("awsMonthly", "≈ EC2 Monthly: —");
  safeSetText("awsStorageSel",     "Storage: —");
  safeSetText("awsStoragePriceHrLabel", "EBS Price/hr:");
  safeSetText("awsStoragePriceHr", "—");
  safeSetText("awsStorageMonthlyLabel", "≈ EBS Monthly:");
  safeSetText("awsStorageMonthly", "—");
  safeSetText("awsTotalHr",        "—");
  safeSetText("awsTotalMonthly",   "—");

  safeSetText("azInstance", `<strong>Recommended VM Size:</strong> …`, { html: true });
  safeSetText("azCpu",     "vCPU: …");
  safeSetText("azRam",     "RAM: …");
  safeSetText("azPrice",   "VM Price/hr: —");
  safeSetText("azMonthly", "≈ VM Monthly: —");
  safeSetText("azStorageSel",     "Storage: —");
  safeSetText("azStoragePriceHrLabel", "Azure Disk Price/hr:");
  safeSetText("azStoragePriceHr", "—");
  safeSetText("azStorageMonthlyLabel", "≈ Azure Disk Monthly:");
  safeSetText("azStorageMonthly", "—");
  safeSetText("azTotalHr",        "—");
  safeSetText("azTotalMonthly",   "—");

  safeSetText("gcpInstance", `<strong>Recommended Machine:</strong> …`, { html: true });
  safeSetText("gcpCpu",     "vCPU: …");
  safeSetText("gcpRam",     "RAM: …");
  safeSetText("gcpPrice",   "Compute Engine Price/hr: —");
  safeSetText("gcpMonthly", "≈ Compute Engine Monthly: —");
  safeSetText("gcpStorageSel",     "Storage: —");
  safeSetText("gcpStoragePriceHrLabel", "Persistent Disk Price/hr:");
  safeSetText("gcpStoragePriceHr", "—");
  safeSetText("gcpStorageMonthlyLabel", "≈ Persistent Disk Monthly:");
  safeSetText("gcpStorageMonthly", "—");
  safeSetText("gcpTotalHr",        "—");
  safeSetText("gcpTotalMonthly",   "—");

  safeSetText("ociInstance", `<strong>Recommended Machine:</strong> …`, { html: true });
  safeSetText("ociCpu",     "vCPU: …");
  safeSetText("ociRam",     "RAM: …");
  safeSetText("ociPrice",   "Compute Price/hr: —");
  safeSetText("ociMonthly", "≈ Compute Monthly: —");
  safeSetText("ociStorageSel",     "Storage: —");
  safeSetText("ociStoragePriceHrLabel", "Block Volume Price/hr:");
  safeSetText("ociStoragePriceHr", "—");
  safeSetText("ociStorageMonthlyLabel", "≈ Block Volume Monthly:");
  safeSetText("ociStorageMonthly", "—");
  safeSetText("ociTotalHr",        "—");
  safeSetText("ociTotalMonthly",   "—");
}

/* ================= Optional: Normalization + sorting exports =================
 * These are kept for backward-compatibility if other modules import them.
 * The merged state.js already implements equivalent logic.
 */

export function normalizeArch(row){
  if (!row) return row;
  row.arch = row.arch || row.architecture || null;
  return row;
}

export function normalizeRows(rows){
  return (rows || []).map(r => normalizeArch({ ...r }));
}

export function applyArchFilter(rows, archPref){
  if (archPref === 'any') return rows;
  return (rows || []).filter(r => !r.arch || r.arch === archPref);
}

function _num(x){ const n = Number(x); return Number.isFinite(n) ? n : 0; }
export function genRankAWS(inst){ const m = String(inst||'').match(/[0-9]{1,2}/); return m ? _num(m[0]) : 0; }
export function genRankAzure(sku){ const m = String(sku||'').toLowerCase().match(/v([0-9]{1,2})/); return m ? _num(m[1]) : 0; }
export function genRankGCP(type){ const s = String(type||'').split('-')[0]; const m = s && s.match(/[a-z]*([0-9]{1,2})[a-z]?/i); return m ? _num(m[1]) : 0; }
export function genRankOCI(shape){ const s = String(shape||''); const m = s.match(/\.E([0-9]+)/i); if (m) return _num(m[1]); if (/\.A4\./i.test(s)) return 4; if (/\.A2\./i.test(s)) return 2; if (/\.A1\./i.test(s)) return 1; return 0; }
export function genRank(row){ const p = String(row?.provider||'').toLowerCase(); const id = row?.instance || row?.displayInstance || ''; if(p==='aws')return genRankAWS(id); if(p==='azure')return genRankAzure(id); if(p==='gcp')return genRankGCP(id); if(p==='oci')return genRankOCI(id); return 0; }
function srcRank(r){ return r?.source === 'catalog' ? 1 : 0; }
export function sortForAuto(a, b){ return ( (a.totalHr - b.totalHr) || (genRank(b.row) - genRank(a.row)) || ((a.row.vcpu||0) - (b.row.vcpu||0)) || (srcRank(b.row) - srcRank(a.row)) ); }

export function allowListOK(row){
  const p = String(row?.provider || '').toLowerCase();
  const inst = String(row?.instance || '').toLowerCase();
  if (p === 'aws')   return /^(m[6-9]|c[6-9]|r[6-9]|t4)/.test(inst);
  if (p === 'azure') return /(dv5|das v5|dps v5|ev5|eas v5|eps v5|fsv2)/i.test(inst) || /standard d\d+ps v5/i.test(inst);
  if (p === 'gcp')   return /^(n4|n4d|t2a|t2d|c3|c4|c4a|m3)/.test(inst);
  if (p === 'oci')   return /(VM\.Standard\.E[3-6]\.Flex|VM\.Standard3\.Flex|VM\.Optimized3\.Flex|VM\.Standard\.A[124]\.Flex)/i.test(row.instance||'');
  return true;
}

export function pickCheapestPerCategory(rows, { includeStorageHr = false, storageHrFn = null } = {}){
  const cats = ['general','compute','memory'];
  const res = { general: null, compute: null, memory: null };

  const withTotals = (rows || [])
    .filter(allowListOK)
    .map(r => {
      const storageHr = includeStorageHr && typeof storageHrFn === 'function' ? storageHrFn(r) : 0;
      return { row: r, totalHr: (Number(r.pricePerHourUSD) || 0) + (Number(storageHr) || 0) };
    });

  for (const c of cats) {
    const pick = withTotals.filter(x => String(x.row.category) === c).sort(sortForAuto)[0]?.row || null;
    res[c] = pick;
  }
  return res;
}
