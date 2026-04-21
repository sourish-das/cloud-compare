// docs/ui/matchers.js
// Unified matcher for AWS, Azure, GCP, OCI
// Exact → Nearest → Latest, no undersizing, no burstable

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
 * COMMON FILTERS
 * ============================ */
export function isOnDemandShared(x) {
  const bm  = String(x.billingModel || '').toLowerCase();
  const ten = String(x.tenancyType || '').toLowerCase();
  if ((bm && bm !== 'ondemand') || (ten && ten !== 'shared')) return false;

  const blob = [x.productName, x.skuName, x.meterName, x.instance]
    .filter(Boolean).join(' ').toLowerCase();

  return !(
    blob.includes('spot') ||
    blob.includes('low priority') ||
    blob.includes('reserved') ||
    blob.includes('savings plan')
  );
}

/* ============================
 * CORE SCORING
 * ============================ */
function scoreInstance(vcpu, ram, wantVcpu, wantRam, family) {
  if (!isFinite(vcpu) || !isFinite(ram)) return Infinity;

  // never undersize
  if (vcpu < wantVcpu || ram < wantRam) return Infinity;

  // cap RAM explosion except memory
  if (family !== 'memory' && ram > wantRam * 2) return Infinity;

  // exact match
  if (vcpu === wantVcpu && ram === wantRam) return 0;

  // nearest larger (CPU weighted more)
  return (vcpu - wantVcpu) * 10 + (ram - wantRam);
}

/* ============================
 * FAMILY MATCHERS
 * ============================ */
export function isAwsInFamily(inst, family) {
  if (!family) return true;
  const s = String(inst).toLowerCase();
  if (family === 'general') return s.startsWith('m') && genRankAws(inst) >= 6; // Only m6/m7 and newer
  if (family === 'compute') return s.startsWith('c');
  if (family === 'memory')  return s.startsWith('r');
  return true;
}

// ✅ Azure family must be instance‑based
export function azureFamilyMatch(row, family) {
  if (!family) return true;
  const inst = String(row?.instance || '').toLowerCase();

  if (family === 'compute') return inst.startsWith('standard_f');
  if (family === 'general') return inst.startsWith('standard_d') || inst.startsWith('standard_b');
  if (family === 'memory')  return inst.startsWith('standard_e') || inst.startsWith('standard_m');

  return true;
}

export function isGcpInFamily(inst, family) {
  if (!family) return true;
  const n = String(inst).toUpperCase();

  if (family === 'memory')  return /^M[1-4]/.test(n);
  if (family === 'compute') return /^(C2|C2D|H3|H4D)/.test(n);
  if (family === 'general')
    return /^(E2|N1|N2|N2D|N4|N4A|N4D|T2A|T2D)/.test(n);

  return true;
}

export function gcpFamilyMatch(row, family) {
  if (!family) return true;
  return isGcpInFamily(row?.instance, family);
}

/* ============================
 * ARM GUARDS (WINDOWS)
 * ============================ */
function isAzureArmInstance(n) {
  return /psv2|dpsv5|dpldsv5|epsv5/i.test(String(n));
}
function isAwsGravitonInstance(n) {
  return /(^|_)t4g|(^|_)c[6-9]g|(^|_)m[6-9]g|(^|_)r[6-9]g/.test(String(n));
}
export function isGcpArmInstance(n) {
  return /^(T2A|C4A|N4A|A4X)/.test(String(n).toUpperCase());
}

/* ============================
 * GENERATION RANKING
 * ============================ */
function genRankAws(i){ return +(String(i).match(/[a-z]+(\d+)/)?.[1] || 0); }
function genRankAzure(i){ return +(String(i).toLowerCase().match(/_v(\d+)/)?.[1] || 0); }
function genRankGcp(i){ return +(String(i).split('-')[0].match(/[a-z]+(\d+)/)?.[1] || 0); }

/* ============================
 * AZURE SPEC INFERENCE
 * ============================ */
export function inferAzureCoresRamFromName(name) {
  const n = String(name).toLowerCase();
  const cores = +(n.match(/standard_[a-z]+(\d+)/)?.[1] || 0);
  if (!cores) return { vcpu: null, ram: null };

  const perCore =
    n.startsWith('standard_d') ? 4 :
    n.startsWith('standard_f') ? 4 :   // ✅ F2ads v7 = 2 vCPU / 8 GB
    n.startsWith('standard_e') ? 8 :
    n.startsWith('standard_b') ? 4 :
    n.startsWith('standard_m') ? 16 : null;

  return { vcpu: cores, ram: perCore ? cores * perCore : null };
}

/* ============================
 * GENERIC PICKER (Exact → Near → Latest)
 * ============================ */
function pickBest(rows, wantVcpu, wantRam, family, genFn) {
  // exact first
  const exact = rows.filter(r => r.vcpu === wantVcpu && r.ram === wantRam);
  if (exact.length) {
    return exact.sort((a,b) => genFn(b.instance) - genFn(a.instance))[0];
  }

  let best = null, bestScore = Infinity, bestGen = -1;
  for (const r of rows) {
    const score = scoreInstance(r.vcpu, r.ram, wantVcpu, wantRam, family);
    if (!isFinite(score)) continue;

    const gen = genFn(r.instance);
    if (score < bestScore || (score === bestScore && gen > bestGen)) {
      best = r; bestScore = score; bestGen = gen;
    }
  }
  return best;
}

/* ============================
 * AWS
 * ============================ */
export function findBestAws(list, vcpu, ram, os, family) {
  const wantOS = normalizeOs(os);
  const isWin = wantOS === 'windows';

  const rows = list.filter(x =>
    isOnDemandShared(x) &&
    normalizeOs(x.os) === wantOS &&
    isAwsInFamily(x.instance, family) &&
    isFinite(x.vcpu) && isFinite(x.ram) &&
    genRankAws(x.instance) >= 6 &&          // block m3/m4
    (!isWin || !isAwsGravitonInstance(x.instance))
  );

  return pickBest(rows, vcpu, ram, family, genRankAws);
}

/* ============================
 * AZURE
 * ============================ */
export function findBestAzure(list, vcpu, ram, os, family) {
  const wantOS = normalizeOs(os);
  const isWin = wantOS === 'windows';

  const rows = list
    .filter(x =>
      isOnDemandShared(x) &&
      azureFamilyMatch(x, family) &&
      (normalizeOs(x.os) === wantOS || x.os === 'Unknown') &&
      (!isWin || !isAzureArmInstance(x.instance))
    )
    .map(x => {
      if (isFinite(x.vcpu) && isFinite(x.ram)) return x;
      const m = inferAzureCoresRamFromName(x.instance);
      return { ...x, vcpu: m.vcpu, ram: m.ram };
    });

  const best = pickBest(rows, vcpu, ram, family, genRankAzure);
  if (best) best.os = os;
  return best;
}

/* ============================
 * GCP
 * ============================ */
export function findBestGcp(list, vcpu, ram, os, family) {
  const wantOS = normalizeOs(os);
  const isWin = wantOS === 'windows';

  const rows = list.filter(x =>
    normalizeOs(x.os) === wantOS &&
    gcpFamilyMatch(x, family) &&
    isFinite(x.vcpu) && isFinite(x.ram) &&
    (!isWin || !isGcpArmInstance(x.instance))
  );

  return pickBest(rows, vcpu, ram, family, genRankGcp);
}

/* ============================
 * OCI
 * ============================ */
export function findBestOci(ociCompute, vcpu, ram, os, options = {}) {
  const wantOS = normalizeOs(os);
  const isWin = wantOS === 'windows';
  const isRhel = wantOS === 'rhel';

  const L = ociCompute.linux || {};
  const W = ociCompute.windows || {};
  const R = ociCompute.rhel || {};

  const proc = String(options.processor || 'auto').toLowerCase();
  const mode = String(options.mode || 'auto').toLowerCase();

  const winLic = isWin ? (W.license_per_vcpu_hour || 0) : 0;
  const rhelLic = isRhel ? (R.license_per_vcpu_hour || 0) : 0;

  const candidates = [];

  function add(entry, p) {
    if (proc !== 'auto' && proc !== p) return;
    if (isWin && p === 'arm') return;

    const ocpu = vcpu / 2;
    const price =
      ocpu * entry.ocpu_per_hour +
      ram * entry.ram_gb_per_hour +
      vcpu * winLic +
      vcpu * rhelLic;

    candidates.push({
      provider: 'oci',
      instance: entry.shape,
      vcpu, ram,
      os: wantOS,
      gen: entry.gen,
      pricePerHourUSD: price
    });
  }

  (L.amd || []).forEach(e => add(e, 'amd'));
  (L.arm || []).forEach(e => add(e, 'arm'));
  (L.intel || []).forEach(e => add(e, 'intel'));

  if (proc !== 'auto' && mode === 'latest') {
    return candidates.sort((a,b) => (b.gen||0)-(a.gen||0))[0];
  }
  return candidates.sort((a,b) => a.pricePerHourUSD - b.pricePerHourUSD)[0];
}
