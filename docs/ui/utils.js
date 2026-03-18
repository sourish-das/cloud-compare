// docs/ui/utils.js
// Shared UI helpers: formatting, DOM, storage pricing resolvers, and global
// architecture policy helpers (Windows → x86-only; Linux/RHEL follow slider in state.js).

export const HRS_PER_MONTH = 730;

/* ---------- Formatting & math helpers ---------- */
export function fmt(n) {
  return (n == null || isNaN(n)) ? '—' : `$${Number(n).toFixed(4)}`;
}
export function fmtDelta(n) {
  if (n == null || isNaN(n)) return '—';
  const v = Number(n);
  const sign = v > 0 ? '+' : '';
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
  el.innerHTML = '';
  for (const it of (items || [])) {
    const opt = document.createElement('option');
    if (typeof it === 'string') {
      opt.value = it; opt.textContent = it;
    } else if (it && typeof it === 'object') {
      opt.value = (it.value != null) ? String(it.value) : '';
      opt.textContent = (it.text != null) ? String(it.text) : String(it.value ?? '');
      if (it.disabled) opt.disabled = true;
      if (it.selected) opt.selected = true;
    } else { continue; }
    el.appendChild(opt);
  }
}
export function ensureSelectOption(id, value, label) {
  const el = document.getElementById(id);
  if (!el) return;
  const needle = String(value).toLowerCase();
  const exists = Array.from(el.options).some(o => String(o.value).toLowerCase() === needle);
  if (exists) return;
  const opt = document.createElement('option');
  opt.value = value; opt.textContent = label || String(value);
  const linuxIdx = Array.from(el.options).findIndex(o => String(o.value).toLowerCase() === 'linux');
  if (linuxIdx >= 0 && linuxIdx < el.options.length - 1) el.add(opt, el.options[linuxIdx + 1]);
  else el.add(opt);
}
export function setSelectValue(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  const current = el.value;
  const match = Array.from(el.options).find(o => o.value == value);
  el.value = match ? value : current;
}
export function safeSetText(id, value, { html = false } = {}) {
  const el = document.getElementById(id);
  if (!el) return;
  const v = (value == null) ? '' : String(value);
  if (html) el.innerHTML = v; else el.textContent = v;
}
export function appendToText(id, extra) {
  const el = document.getElementById(id); if (el) el.textContent = (el.textContent || '') + extra;
}
export function setStatus(msg, level = 'info') {
  const el = document.getElementById('status'); if (!el) return;
  const err='var(--err,#b91c1c)', warn='var(--warn,#b45309)', mut='var(--muted,#666)';
  el.textContent = msg;
  el.style.color = (level === 'error') ? err : (level === 'warn') ? warn : mut;
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
  if (type === 'ssd') {
    const map = {4:'E1',8:'E2',16:'E3',32:'E4',64:'E6',128:'E10',256:'E15',512:'E20',1024:'E30',2048:'E40',4096:'E50'};
    return map[size] || null;
  } else {
    const map = {32:'S4',64:'S6',128:'S10',256:'S15',512:'S20',1024:'S30',2048:'S40',4096:'S50'};
    return map[size] || null;
  }
}

/* ---------- Storage price resolvers ---------- */
export function getAwsStorageMonthlyFromCfg(type, gb, awsCfg) {
  if (!isFinite(gb) || gb <= 0) return null;
  const t = (type || 'hdd').toLowerCase();
  if (t === 'ssd') return gb * Number(awsCfg?.ssd_per_gb_month ?? 0.08);
  return gb * Number(awsCfg?.hdd_st1_per_gb_month ?? 0.045);
}
export function getAzureStorageSkuAndMonthlyFromCfg(type, gb, azCfg) {
  const t = (type || 'hdd').toLowerCase();
  if (!isFinite(gb) || gb <= 0)
    return { sku: null, size: null, monthlyUSD: null, adjusted: false };
  const ssdTbl = azCfg?.ssd_monthly || {}; const hddTbl = azCfg?.hdd_monthly || {};
  if (t === 'ssd') {
    const size = nearestCeil(gb, Object.keys(ssdTbl).map(Number));
    const monthlyUSD = size != null ? (ssdTbl[size] ?? null) : null;
    const sku = sizeToAzureSku('ssd', size);
    return { sku, size, monthlyUSD, adjusted: (size != null && size !== gb) };
  }
  const allowed = Object.keys(hddTbl).map(Number);
  let size = nearestCeil(gb, allowed);
  if (size == null && allowed.length) size = allowed.sort((a, b) => a - b)[0];
  if (size != null && size < 32) size = 32; // HDD minimum
  const monthlyUSD = size != null ? (hddTbl[size] ?? null) : null;
  const sku = sizeToAzureSku('hdd', size);
  return { sku, size, monthlyUSD, adjusted: (size != null && size !== gb) };
}

/* ---------- GCP storage pricing + label ---------- */
export function getGcpStorageMonthlyFromCfg(type, gb, gcpCfg) {
  if (!isFinite(gb) || gb <= 0) return null;
  const t = (type || 'hdd').toLowerCase();
  if (t === 'ssd') return gb * Number(gcpCfg?.ssd_per_gb_month ?? 0.10);
  const hddRate = Number(gcpCfg?.hdd_per_gb_month ?? 0.04);
  const freeBand = Number(gcpCfg?.hdd_free_gb_per_month ?? 0) || 0;
  const billableGiB = Math.max(0, Number(gb) - freeBand);
  return billableGiB * hddRate;
}
export function formatGcpStorageLabel(type, gb, gcpCfg) {
  const size = Number(gb || 0);
  const t = String(type || 'HDD').toUpperCase();
  if (!Number.isFinite(size) || size <= 0) return 'Storage: —';
  if (t === 'SSD') return `Storage: ${size} GB SSD`; // SSD billed as-is
  const free = Number(gcpCfg?.hdd_free_gb_per_month || 0) || 0;
  const billed = Math.max(0, size - free);
  return `Storage: ${size} GB HDD (first ${free} GB free → billed ${billed} GB)`;
}

/* ---------- OCI storage pricing ---------- */
export function getOciStorageMonthlyFromCfg(arg1, arg2, arg3) {
  let type = 'ssd', gb, cfg;
  if (typeof arg1 === 'string') { type = String(arg1).toLowerCase(); gb = arg2; cfg = arg3; }
  else { gb = arg1; cfg = arg2; }
  if (!isFinite(gb) || gb <= 0) return null;
  const base = Number(cfg?.block_volume_gb_month ?? 0.0255);
  const vpuUSD = Number(cfg?.vpu_per_gb_month ?? 0.0017);
  const vpus = (type === 'hdd') ? 0 : 10; // SSD → Balanced (10), HDD → Lower Cost (0)
  return Number(gb) * (base + vpus * vpuUSD);
}

/* ---------- Reset all UI fields (AWS + Azure + GCP + OCI) ---------- */
export function resetCards() {
  safeSetText('awsInstance', `<strong>Recommended Instance:</strong> …`, { html: true });
  safeSetText('awsCpu', 'vCPU: …');
  safeSetText('awsRam', 'RAM: …');
  safeSetText('awsPrice', 'EC2 Price/hr: —');
  safeSetText('awsMonthly', '≈ EC2 Monthly: —');
  safeSetText('awsStorageSel', 'Storage: —');
  safeSetText('awsStoragePriceHrLabel', 'EBS Price/hr:');
  safeSetText('awsStoragePriceHr', '—');
  safeSetText('awsStorageMonthlyLabel', '≈ EBS Monthly:');
  safeSetText('awsStorageMonthly', '—');
  safeSetText('awsTotalHr', '—');
  safeSetText('awsTotalMonthly', '—');

  safeSetText('azInstance', `<strong>Recommended VM Size:</strong> …`, { html: true });
  safeSetText('azCpu', 'vCPU: …');
  safeSetText('azRam', 'RAM: …');
  safeSetText('azPrice', 'VM Price/hr: —');
  safeSetText('azMonthly', '≈ VM Monthly: —');
  safeSetText('azStorageSel', 'Storage: —');
  safeSetText('azStoragePriceHrLabel', 'Azure Disk Price/hr:');
  safeSetText('azStoragePriceHr', '—');
  safeSetText('azStorageMonthlyLabel', '≈ Azure Disk Monthly:');
  safeSetText('azStorageMonthly', '—');
  safeSetText('azTotalHr', '—');
  safeSetText('azTotalMonthly', '—');

  safeSetText('gcpInstance', `<strong>Recommended Machine:</strong> …`, { html: true });
  safeSetText('gcpCpu', 'vCPU: …');
  safeSetText('gcpRam', 'RAM: …');
  safeSetText('gcpPrice', 'Compute Engine Price/hr: —');
  safeSetText('gcpMonthly', '≈ Compute Engine Monthly: —');
  safeSetText('gcpStorageSel', 'Storage: —');
  safeSetText('gcpStoragePriceHrLabel', 'Persistent Disk Price/hr:');
  safeSetText('gcpStoragePriceHr', '—');
  safeSetText('gcpStorageMonthlyLabel', '≈ Persistent Disk Monthly:');
  safeSetText('gcpStorageMonthly', '—');
  safeSetText('gcpTotalHr', '—');
  safeSetText('gcpTotalMonthly', '—');

  safeSetText('ociInstance', `<strong>Recommended Machine:</strong> …`, { html: true });
  safeSetText('ociCpu', 'vCPU: …');
  safeSetText('ociRam', 'RAM: …');
  safeSetText('ociPrice', 'Compute Price/hr: —');
  safeSetText('ociMonthly', '≈ Compute Monthly: —');
  safeSetText('ociStorageSel', 'Storage: —');
  safeSetText('ociStoragePriceHrLabel', 'Block Volume Price/hr:');
  safeSetText('ociStoragePriceHr', '—');
  safeSetText('ociStorageMonthlyLabel', '≈ Block Volume Monthly:');
  safeSetText('ociStorageMonthly', '—');
  safeSetText('ociTotalHr', '—');
  safeSetText('ociTotalMonthly', '—');
}

/* ================= Normalization + sorting exports ================= */
export function normalizeArch(row){ if (!row) return row; row.arch = row.arch || row.architecture || null; return row; }
export function normalizeRows(rows){ return (rows || []).map(r => normalizeArch({ ...r })); }
export function applyArchFilter(rows, archPref){ if (archPref === 'any') return rows; return (rows || []).filter(r => !r.arch || r.arch === archPref); }

function _num(x){ const n = Number(x); return Number.isFinite(n) ? n : 0; }
export function genRankAWS(inst){ const m = String(inst||'').match(/[0-9]{1,2}/); return m ? _num(m[0]) : 0; }
export function genRankAzure(sku){ const m = String(sku||'').toLowerCase().match(/v([0-9]{1,2})/); return m ? _num(m[1]) : 0; }
export function genRankGCP(type){ const s = String(type||'').split('-')[0]; const m = s && s.match(/[a-z]*([0-9]{1,2})[a-z]?/i); return m ? _num(m[1]) : 0; }
export function genRankOCI(shape){ const s = String(shape||''); const m = s.match(/\.E([0-9]+)/i); if (m) return _num(m[1]); if (/\.A4\./i.test(s)) return 4; if (/\.A2\./i.test(s)) return 2; if (/\.A1\./i.test(s)) return 1; return 0; }
export function genRank(row){ const p = String(row?.provider||'').toLowerCase(); const id = row?.instance || row?.displayInstance || ''; if(p==='aws')return genRankAWS(id); if(p==='azure')return genRankAzure(id); if(p==='gcp')return genRankGCP(id); if(p==='oci')return genRankOCI(id); return 0; }
function srcRank(r){ return r?.source === 'catalog' ? 1 : 0; }
export function sortForAuto(a, b){ return ((a.totalHr - b.totalHr) || (genRank(b.row) - genRank(a.row)) || ((a.row.vcpu||0) - (b.row.vcpu||0)) || (srcRank(b.row) - srcRank(a.row))); }

/* ---------- Global ARCH POLICY ---------- */
// Policy from slider (future):
//  - 'x86'   : block ARM
//  - 'allow' : allow both
//  - 'arm'   : ARM-only
// Windows is ALWAYS x86-only (enforced in state.js effectiveArchPrefForOS)
function _effectiveArchPolicy() {
  // if state.js is available use its resolver; else fall back to window.state
  const eff = (typeof window !== 'undefined' && window.state && typeof window.state.os !== 'undefined')
    ? (window.state.os.match(/windows/i) ? 'x86' : (window.state.archPolicy || 'x86'))
    : 'x86';
  const v = String(eff).toLowerCase();
  return (v === 'x86' || v === 'allow' || v === 'arm') ? v : 'x86';
}
// Robust ARM detector (fallback when row.arch missing)
function _isArmRow(row) {
  const arch = String(row?.arch || row?.architecture || '').toLowerCase();
  if (arch) return arch === 'arm';
  const p = String(row?.provider || '').toLowerCase();
  const id = String(row?.instance || row?.displayInstance || '').toLowerCase();
  if (p === 'aws')  return /^a1\./.test(id) || /^t4g\./.test(id) || /\b[cmr]\d+g\./.test(id);
  if (p === 'azure')return /\b(dpsv5|dplsv5|epsv5)\b/.test(id) || /standard_[de]\d+p(l)?s_v5/.test(id);
  if (p === 'gcp')  return /\b(n4a|c4a|t2a)-/.test(id);
  if (p === 'oci')  return /\bvm\.standard\.a[124]\.flex\b/.test(id) || /\bstandard\.a[124]\.flex\b/.test(id) || /\bampere\b/.test(id) || /\baltra\b/.test(id);
  return false;
}
function _archPolicyPass(row, policy) {
  const isArm = _isArmRow(row);
  if (policy === 'x86')  return !isArm;
  if (policy === 'arm')  return  isArm;
  return true; // allow
}

/** Main picker with totals, honoring the arch policy first. */
export function pickCheapestPerCategory(
  rows,
  { includeStorageHr = false, storageHrFn = null, archPolicy = _effectiveArchPolicy() } = {}
){
  const cats = ['general','compute','memory'];
  const res = { general: null, compute: null, memory: null };
  const withTotals = (rows || [])
    .filter(r => _archPolicyPass(r, String(archPolicy).toLowerCase()))
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
