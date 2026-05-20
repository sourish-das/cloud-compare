// docs/ui/matchers.js
// - FAMILY (family set):     Exact -> NearestFit -> Newer -> Cheapest (no undersizing)

'use strict';

/* ============================
 * OS NORMALIZATION
 * ============================ */
export function normalizeOs(val) {
  const s = String(val || '').toLowerCase();
  if (s.startsWith('win')) return 'windows';
  if (/\bred\s*hat\b|\brhel\b/.test(s)) return 'rhel';
  return 'linux';
}

/* ============================
 * FAMILY NORMALIZATION (IMPORTANT)
 * ============================
 * UI "Auto (Recommended)" may send value "auto" (or similar).
 * We treat that as "no family filter" => AUTO mode.
 */
function normalizeFamily(val) {
  const s = String(val || '').trim().toLowerCase();
  if (!s) return '';
  if (s === 'auto' || s.startsWith('auto')) return '';
  return s; // 'general' | 'compute' | 'memory' | provider-specific
}

/* ============================
 * COMMON FILTERS
 * ============================ */
export function isOnDemandShared(x) {
  const bm = String(x?.billingModel || '').toLowerCase();
  const ten = String(x?.tenancyType || '').toLowerCase();
  if ((bm && bm !== 'ondemand') || (ten && ten !== 'shared')) return false;

  const blob = [x?.productName, x?.skuName, x?.meterName, x?.instance]
    .filter(Boolean).join(' ').toLowerCase();

  return !(
    blob.includes('spot') ||
    blob.includes('low priority') ||
    blob.includes('reserved') ||
    blob.includes('savings plan')
  );
}

/* ============================
 * CORE SCORING (balanced oversize, no CPU/RAM weightage)
 * ============================ */
/**
 * Balanced nearest-fit score:
 * score = ((vcpu-want)/wantVcpu) + ((ram-want)/wantRam)
 * - Infinity if undersized
 * - Exact match score = 0
 */
function oversizeScore(vcpu, ram, wantVcpu, wantRam) {
  if (!Number.isFinite(vcpu) || !Number.isFinite(ram)) return Infinity;
  if (!Number.isFinite(wantVcpu) || !Number.isFinite(wantRam) || wantVcpu <= 0 || wantRam <= 0) return Infinity;

  if (vcpu < wantVcpu || ram < wantRam) return Infinity;
  if (vcpu === wantVcpu && ram === wantRam) return 0;

  const cpuGap = (vcpu - wantVcpu) / wantVcpu;
  const ramGap = (ram - wantRam) / wantRam;
  return cpuGap + ramGap;
}

/**
 * Guardrail against extreme jumps when exact is missing.
 * Keeps results sensible without biasing CPU vs RAM.
 * - Set to Infinity if you want "no cap".
 */
const MAX_GAP = 2.0; // +200% per dimension allowed

function passesGapGuard(vcpu, ram, wantVcpu, wantRam, family) {
  const cpuGap = (vcpu - wantVcpu) / wantVcpu;
  const ramGap = (ram - wantRam) / wantRam;

  // Memory family can oversize RAM more, but still keep CPU sane
  if (family === 'memory') return cpuGap <= MAX_GAP;

  // General/compute: cap both dimensions
  return cpuGap <= MAX_GAP && ramGap <= MAX_GAP;
}

/* ============================
 * FAMILY MATCHERS
 * ============================ */
export function isAwsInFamily(inst, family) {
  if (!family) return true;
  const s = String(inst || '').toLowerCase();
  if (family === 'general') return /^m(6|7)[a-z]*\./.test(s);
  if (family === 'compute') return s.startsWith('c');
  if (family === 'memory') return s.startsWith('r');
  return true;
}

// Azure family must be instance-based
export function azureFamilyMatch(row, family) {
  if (!family) return true;
  const inst = String(row?.instance || '').toLowerCase();
  if (family === 'compute') return inst.startsWith('standard_f');
  if (family === 'general') return inst.startsWith('standard_d') || inst.startsWith('standard_b');
  if (family === 'memory') return inst.startsWith('standard_e') || inst.startsWith('standard_m');
  return true;
}

// GCP family mapping is suffix-based; prefers dataset category if present
export function gcpFamilyMatch(row, family) {
  if (!family) return true;

  const fam = String(family || '').toLowerCase();

  const cat = String(row?.category || '').toLowerCase();
  if (cat === 'general' || cat === 'compute' || cat === 'memory') {
    return cat === fam;
  }

  const inst = String(row?.instance || '').toLowerCase();
  if (fam === 'general') return /-standard-\d+$/.test(inst);
  if (fam === 'compute') return /-highcpu-\d+$/.test(inst);
  if (fam === 'memory') return /-(highmem|megamem|ultramem|hypermem)-\d+$/.test(inst);
  return true;
}

/* ============================
 * ARM GUARDS (WINDOWS)
 * ============================ */
function isAzureArmInstance(n) {
  const s = String(n || '').toLowerCase();
  return /dpsv5|dplsv5|epsv5|epdsv5/.test(s) ||
    /standard_[de]\d+p(ds|pls|ls|s)_v5/.test(s);
}

function isAwsGravitonInstance(n) {
  return /(^|_)t4g|(^|_)c[6-9]g|(^|_)m[6-9]g|(^|_)r[6-9]g/.test(String(n || ''));
}

export function isGcpArmInstance(n) {
  return /^(T2A|C4A|N4A|A4X)/.test(String(n || '').toUpperCase());
}

/* ============================
 * GENERATION RANKING
 * ============================ */
function genRankAws(i) { return +(String(i || '').match(/[a-z]+(\d+)/)?.[1] || 0); }
function genRankAzure(i) { return +(String(i || '').toLowerCase().match(/_v(\d+)/)?.[1] || 0); }
function genRankGcp(i) { return +(String(i || '').split('-')[0].match(/[a-z]+(\d+)/)?.[1] || 0); }

/* ============================
 * AZURE SPEC INFERENCE
 * ============================ */
export function inferAzureCoresRamFromName(name) {
  const n = String(name || '').toLowerCase();
  const cores = +(n.match(/standard_[a-z]+(\d+)/)?.[1] || 0);
  if (!cores) return { vcpu: null, ram: null };

  const perCore =
    n.startsWith('standard_d') ? 4 :
    n.startsWith('standard_f') ? 4 :
    n.startsWith('standard_e') ? 8 :
    n.startsWith('standard_b') ? 4 :
    n.startsWith('standard_m') ? 16 : null;

  return { vcpu: cores, ram: perCore ? cores * perCore : null };
}

/* ============================
 * GENERIC PICKERS
 * ============================ */

// AUTO: Exact -> NearestFit bucket -> Cheapest (tie: newer)
function pickAuto(rows, wantVcpu, wantRam, family, genFn) {
  const valid = (rows || []).filter(r => {
    const v = Number(r?.vcpu), m = Number(r?.ram);
    if (!Number.isFinite(v) || !Number.isFinite(m)) return false;
    if (v < wantVcpu || m < wantRam) return false;
    return passesGapGuard(v, m, wantVcpu, wantRam, family);
  });

  const exact = valid.filter(r => Number(r.vcpu) === wantVcpu && Number(r.ram) === wantRam);
  if (exact.length) {
    exact.sort((a, b) =>
      (Number(a.pricePerHourUSD) - Number(b.pricePerHourUSD)) ||
      (genFn(b.instance) - genFn(a.instance))
    );
    return exact[0];
  }

  const scored = valid
    .map(r => ({ r, s: oversizeScore(Number(r.vcpu), Number(r.ram), wantVcpu, wantRam) }))
    .filter(x => Number.isFinite(x.s))
    .sort((a, b) => a.s - b.s);

  const bucket = scored.slice(0, 8).map(x => x.r);
  if (!bucket.length) return null;

  bucket.sort((a, b) =>
    (Number(a.pricePerHourUSD) - Number(b.pricePerHourUSD)) ||
    (genFn(b.instance) - genFn(a.instance))
  );
  return bucket[0];
}

// FAMILY: Exact -> NearestFit bucket -> Newer -> Cheapest
function pickFamily(rows, wantVcpu, wantRam, family, genFn) {
  const valid = (rows || []).filter(r => {
    const v = Number(r?.vcpu), m = Number(r?.ram);
    if (!Number.isFinite(v) || !Number.isFinite(m)) return false;
    if (v < wantVcpu || m < wantRam) return false;
    return passesGapGuard(v, m, wantVcpu, wantRam, family);
  });

  const exact = valid.filter(r => Number(r.vcpu) === wantVcpu && Number(r.ram) === wantRam);
  if (exact.length) {
    exact.sort((a, b) =>
      (genFn(b.instance) - genFn(a.instance)) ||
      (Number(a.pricePerHourUSD) - Number(b.pricePerHourUSD))
    );
    return exact[0];
  }

  const scored = valid
    .map(r => ({ r, s: oversizeScore(Number(r.vcpu), Number(r.ram), wantVcpu, wantRam) }))
    .filter(x => Number.isFinite(x.s))
    .sort((a, b) => a.s - b.s);

  const bucket = scored.slice(0, 20).map(x => x.r);
  if (!bucket.length) return null;

  bucket.sort((a, b) =>
    (genFn(b.instance) - genFn(a.instance)) ||
    (Number(a.pricePerHourUSD) - Number(b.pricePerHourUSD))
  );
  return bucket[0];
}

// Unified wrapper: normalize family; empty => AUTO, else => FAMILY
function pick(rows, wantVcpu, wantRam, family, genFn) {
  const fam = normalizeFamily(family);
  if (!fam) return pickAuto(rows, wantVcpu, wantRam, fam, genFn);
  return pickFamily(rows, wantVcpu, wantRam, fam, genFn);
}

/* ============================
 * AWS
 * ============================ */
export function findBestAws(list, vcpu, ram, os, family) {
  const wantOS = normalizeOs(os);
  const isWin = wantOS === 'windows';
  const fam = normalizeFamily(family);

  const rows = (list || []).filter(x =>
    isOnDemandShared(x) &&
    normalizeOs(x.os) === wantOS &&
    isAwsInFamily(x.instance, fam) &&
    Number.isFinite(x.vcpu) && Number.isFinite(x.ram) &&
    genRankAws(x.instance) >= 6 &&
    (!isWin || !isAwsGravitonInstance(x.instance))
  );

  return pick(rows, Number(vcpu), Number(ram), fam, genRankAws);
}

/* ============================
 * AZURE
 * ============================ */
export function findBestAzure(list, vcpu, ram, os, family) {
  const wantOS = normalizeOs(os);
  const isWin = wantOS === 'windows';
  const fam = normalizeFamily(family);

  const rows = (list || [])
    .filter(x =>
      isOnDemandShared(x) &&
      azureFamilyMatch(x, fam) &&
      normalizeOs(x.os) === wantOS &&
      (!isWin || !isAzureArmInstance(x.instance))
    )
    .map(x => {
      if (Number.isFinite(x.vcpu) && Number.isFinite(x.ram)) return x;
      const m = inferAzureCoresRamFromName(x.instance);
      return { ...x, vcpu: m.vcpu, ram: m.ram };
    })
    .filter(x => Number.isFinite(x.vcpu) && Number.isFinite(x.ram));

  const best = pick(rows, Number(vcpu), Number(ram), fam, genRankAzure);
  if (best) best.os = os;
  return best;
}

/* ============================
 * GCP
 * ============================ */
export function findBestGcp(list, vcpu, ram, os, family) {
  const wantOS = normalizeOs(os);
  const isWin = wantOS === 'windows';
  const fam = normalizeFamily(family);

  const rows = (list || []).filter(x =>
    normalizeOs(x.os) === wantOS &&
    gcpFamilyMatch(x, fam) &&
    Number.isFinite(x.vcpu) && Number.isFinite(x.ram) &&
    (!isWin || !isGcpArmInstance(x.instance))
  );

  return pick(rows, Number(vcpu), Number(ram), fam, genRankGcp);
}

/* ============================
 * OCI
 * ============================ */
export function findBestOci(ociCompute, vcpu, ram, os, options = {}) {
  const wantOS = normalizeOs(os);
  const isWin = wantOS === 'windows';
  const isRhel = wantOS === 'rhel';

  const L = ociCompute?.linux || {};
  const W = ociCompute?.windows || {};
  const R = ociCompute?.rhel || {};

  const proc = String(options.processor || 'auto').toLowerCase();
  const mode = String(options.mode || 'auto').toLowerCase();

  const winLic = isWin ? (W.license_per_vcpu_hour || 0) : 0;
  const rhelLic = isRhel ? (R.license_per_vcpu_hour || 0) : 0;

  const candidates = [];

  function add(entry, p) {
    if (proc !== 'auto' && proc !== p) return;
    if (isWin && p === 'arm') return;

    const ocpu = Number(vcpu) / 2;
    const price =
      ocpu * Number(entry.ocpu_per_hour || 0) +
      Number(ram) * Number(entry.ram_gb_per_hour || 0) +
      Number(vcpu) * winLic +
      Number(vcpu) * rhelLic;

    candidates.push({
      provider: 'oci',
      instance: entry.shape,
      vcpu: Number(vcpu),
      ram: Number(ram),
      os: wantOS,
      gen: entry.gen || 0,
      pricePerHourUSD: price
    });
  }

  (L.amd || []).forEach(e => add(e, 'amd'));
  (L.arm || []).forEach(e => add(e, 'arm'));
  (L.intel || []).forEach(e => add(e, 'intel'));

  if (proc !== 'auto' && mode === 'latest') {
    return candidates.sort((a, b) => (b.gen || 0) - (a.gen || 0))[0] || null;
  }
  return candidates.sort((a, b) => a.pricePerHourUSD - b.pricePerHourUSD)[0] || null;
}
