// docs/ui/state.js
// Global app state for Cloud Cost Comparator (ES module)
// - Windows is ALWAYS x86-only (ARM blocked), regardless of archPolicy.
// - Linux/RHEL follow archPolicy: 'x86' (default), 'allow', or 'arm'.

export const state = {
  os: 'Linux (Open-source)',       // 'Linux (Open-source)' | 'RHEL' | 'Windows ...'
  archPolicy: 'x86',               // 'x86' | 'allow' | 'arm' (Windows forces 'x86')

  // Inputs (UI can override)
  vcpu: 2,
  ramGiB: 4,
  storageGB: 32,
  storageType: 'HDD',              // 'HDD' | 'SSD'
  region: 'us-east1',              // optional: used by data loaders if needed
};

/* -------------------- OS & Architecture policy -------------------- */
export function isWindows(os) {
  return String(os || '').toLowerCase().includes('windows');
}

export function setOS(value) {
  state.os = String(value || '').trim() || 'Linux (Open-source)';
  // Enforce Windows → x86 only, always
  if (isWindows(state.os)) state.archPolicy = 'x86';
}

export function setArchPolicy(value) {
  const v = String(value || '').toLowerCase();
  const normalized = (v === 'x86' || v === 'allow' || v === 'arm') ? v : 'x86';
  // Windows stays x86-only regardless of requested policy
  state.archPolicy = isWindows(state.os) ? 'x86' : normalized;
}

export function getEffectiveArchPolicy() {
  return isWindows(state.os) ? 'x86' : state.archPolicy;
}

/* -------------------- Basic setters for numeric inputs -------------------- */
export function setVcpu(n) {
  const v = Number(n);
  if (Number.isFinite(v) && v > 0) state.vcpu = v;
}

export function setRamGiB(n) {
  const v = Number(n);
  if (Number.isFinite(v) && v > 0) state.ramGiB = v;
}

export function setStorageGB(n) {
  const v = Number(n);
  if (Number.isFinite(v) && v >= 0) state.storageGB = v;
}

export function setStorageType(t) {
  const v = String(t || 'HDD').toUpperCase();
  state.storageType = (v === 'SSD') ? 'SSD' : 'HDD';
}

export function setRegion(r) {
  state.region = String(r || state.region);
}

/* -------------------- Optional: storage config defaults -------------------- */
// These can be overridden by your data loaders if you already have per-cloud JSON.
export const STORAGE_CFG = {
  aws: {                         // gp3 / st1 defaults (can be overridden)
    ssd_per_gb_month: 0.08,
    hdd_st1_per_gb_month: 0.045,
  },
  azure: {                       // leave empty maps if your loader provides tables
    ssd_monthly: {},
    hdd_monthly: {},
  },
  gcp: {
    ssd_per_gb_month: 0.10,
    hdd_per_gb_month: 0.04,
    hdd_free_gb_per_month: 30,
  },
  oci: {
    block_volume_gb_month: 0.0255,
    vpu_per_gb_month: 0.0017,
  },
};

/* -------------------- Convenience: wire OS <select> if present -------------------- */
// If your page uses an OS <select id="osSelect">, this keeps the arch policy in sync.
export function attachOsSelectSync(selectId = 'osSelect') {
  const el = document.getElementById(selectId);
  if (!el) return;
  el.addEventListener('change', () => {
    setOS(el.value);
    // If Windows, we silently force x86 so the UI never shows ARM picks.
  });
}

// If you later add a slider/toggle for arch policy, call setArchPolicy(newValue)
// and re-run your comparison. Windows will remain x86-only automatically.
