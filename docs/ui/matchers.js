// docs/ui/matchers.js
// All matching logic: normalization, families, scoring, inference, and fallbacks

export function normalizeOs(val) {
  const s = String(val || '').toLowerCase();
  if (s.startsWith('win')) return 'windows';
  return 'linux';
}

export function isOnDemandShared(x) {
  const bm  = String(x.billingModel || '').toLowerCase();  // expect "ondemand"
  const ten = String(x.tenancyType || '').toLowerCase();   // expect "shared"
  const okBilling = (!bm || bm === 'ondemand');
  const okTenancy = (!ten || ten === 'shared');

  const blob = [x.productName, x.skuName, x.meterName, x.instance]
    .filter(Boolean).join(" ").toLowerCase();

  const looksSpot = blob.includes("low priority") || blob.includes("spot")
                 || blob.includes("savings plan") || blob.includes("reserved");

  return okBilling && okTenancy && !looksSpot;
}

// ---------------- Provider family helpers ----------------

export function isAwsInFamily(inst, family) {
  if (!family) return true;
  const s = String(inst || "").toLowerCase();
  if (family === "general")  return /^[mt]/.test(s);
  if (family === "compute")  return /^c/.test(s);
  if (family === "memory")   return /^[rxz]/.test(s);
  return true;
}

export function isAzureInFamily(inst, family) {
  if (!family) return true;
  const n = String(inst || "").toLowerCase();
  const m = n.match(/standard_([a-z]+)/);
  const first = m?.[1]?.[0] || n[0] || null;
  if (!first) return true;

  if (family === "general")  return first === "d" || first === "b";
  if (family === "compute")  return first === "f";
  if (family === "memory")   return first === "e" || first === "m";
  return true;
}

// Prefer server category (from backend) when present; fallback to first-letter rule
export function azureFamilyMatch(row, family) {
  if (!family) return true;
  const fam = String(family).toLowerCase();
  const cat = String(row?.category || "").toLowerCase();

  if (cat) {
    if (fam === "general") return cat === "general";
    if (fam === "compute") return cat === "compute";
    if (fam === "memory")  return cat === "memory";
    return true;
  }
  return isAzureInFamily(row?.instance, family);
}

export function distance(a, b) {
  if (!isFinite(a) || !isFinite(b)) return 1000;
  return Math.abs(Number(a) - Number(b));
}

// Improved inference (best-effort) for constrained v7 titles like F16-4ams_v7
export function inferAzureCoresRamFromName(name) {
  if (!name || typeof name !== "string") return { vcpu: null, ram: null };
  const n = name.toLowerCase();

  let coreMatch = n.match(/standard_[a-z]+(\d+)[a-z]*/i);
  if (!coreMatch) coreMatch = n.match(/[a-z]+(\d+)-/i);
  const vcpu = coreMatch ? Number(coreMatch[1]) : null;

  let familyRamPerCore = null;
  if (n.startsWith("standard_d")) familyRamPerCore = 4;
  else if (n.startsWith("standard_f")) familyRamPerCore = 2;
  else if (n.startsWith("standard_e")) familyRamPerCore = 8;
  else if (n.startsWith("standard_b")) familyRamPerCore = 4;
  else if (n.startsWith("standard_m")) familyRamPerCore = 16;

  const ram = (vcpu && familyRamPerCore) ? vcpu * familyRamPerCore : null;
  return { vcpu, ram };
}

//
// ---------------- Additional guards for Windows ----------------
//

// Azure: common ARM shapes (Windows Server images generally unavailable for these)
function isAzureArmInstance(name) {
  const n = String(name || "").toLowerCase();
  // Bpsv2 (e.g., Standard_B2pls_v2), Dpsv5, Dpldsv5, Epsv5 indicate Ampere/ARM
  return /standard_b.*psv2|standard_dpsv5|standard_dpldsv5|standard_epsv5/.test(n);
}

// AWS: Graviton families (no public Windows AMIs)
function isAwsGravitonInstance(name) {
  const s = String(name || "").toLowerCase();
  // t4g, c6g/c7g/etc., m6g/m7g/etc., r6g/r7g/etc.
  return /(^|_)t4g|(^|_)c[6-9]g|(^|_)m[6-9]g|(^|_)r[6-9]g/.test(s);
}

// GCP: Arm families helper (for GCP finders or extra validation)
export function isGcpArmInstance(name) {
  const n = String(name || "").toUpperCase();
  return n.startsWith("T2A") || n.startsWith("C4A") || n.startsWith("N4A") || n.startsWith("A4X");
}

//
// ---------------- GCP FAMILY MATCHING ----------------
//

// Fallback: infer category from instance prefix (only if backend category missing)
export function isGcpInFamily(inst, family) {
  if (!family) return true;
  if (!inst) return true;

  const name = String(inst).toUpperCase();

  if (family === "memory") {
    return (
      name.startsWith("M1") ||
      name.startsWith("M2") ||
      name.startsWith("M3") ||
      name.startsWith("M4")
    );
  }

  if (family === "compute") {
    return (
      name.startsWith("C2")  ||
      name.startsWith("C2D") ||
      name.startsWith("H3")  ||
      name.startsWith("H4D")
    );
  }

  // C3/C4* should not be under "general"
  if (family === "general") {
    return (
      name.startsWith("E2")  ||
      name.startsWith("N1")  || name.startsWith("N2")   || name.startsWith("N2D") ||
      name.startsWith("N4")  || name.startsWith("N4A")  || name.startsWith("N4D") ||
      name.startsWith("T2A") || name.startsWith("T2D")
    );
  }

  return true;
}

export function gcpFamilyMatch(row, family) {
  if (!family) return true;

  const fam = String(family).toLowerCase();
  const cat = String(row?.category || "").toLowerCase();

  if (cat) {
    if (fam === "general") return cat === "general";
    if (fam === "compute") return cat === "compute";
    if (fam === "memory")  return cat === "memory";
    return true;
  }

  return isGcpInFamily(row?.instance, family);
}

//
// ---------------- OCI HELPERS (UPDATED) ----------------
//
// With the arrays‑first model, OCI compute in the aggregated prices.json looks like:
//   oci.compute = {
//     linux: { amd:[{gen,shape,architecture,ocpu_per_hour,ram_gb_per_hour},...],
//              arm:[...],
//              intel:[...] },
//     windows: { license_per_vcpu_hour }
//   }
//
// We compute the on-demand hourly price on the fly based on vCPU/RAM inputs.

function safeNum(x, fallback = null) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function vcpuToOcpuForArch(vcpu, arch) {
  const v = safeNum(vcpu, 0);
  if (arch === "arm") return v;       // ARM: 1 OCPU = 1 vCPU
  return v / 2;                       // x86: 1 OCPU = 2 vCPU
}

// Kept for compatibility (not used by the new OCI matcher)
export function isOciInFamily(_inst, family) {
  if (!family) return true;
  const f = String(family).toLowerCase();
  return f === "auto" || f === "general" || f === "compute" || f === "memory";
}

//
// ---------------- AWS FINDER ----------------
//
export function findBestAws(list, vcpu, ram, os, family) {
  if (!Array.isArray(list) || list.length === 0)
    throw new Error("AWS price list is empty");

  const wantOS = String(os || "").toLowerCase();
  const isWin = (wantOS === "windows");

  const filtered = list.filter(x =>
    isOnDemandShared(x) &&
    isFinite(x.vcpu) &&
    isFinite(x.ram) &&
    isFinite(x.pricePerHourUSD) &&
    (!wantOS || normalizeOs(x.os) === wantOS) &&
    isAwsInFamily(x.instance, family) &&
    (!isWin || !isAwsGravitonInstance(x.instance)) // block Graviton for Windows
  );
  if (filtered.length === 0) {
    const fLabel = family ? ` family=${family}` : "";
    throw new Error(`No AWS entries for OS=${os || "any"}${fLabel}`);
  }

  let best = null, bestScore = Infinity;
  for (const x of filtered) {
    const score = distance(x.vcpu, vcpu) + distance(x.ram, ram);
    const tieBreaker = x.pricePerHourUSD;
    if (score < bestScore || (score === bestScore && tieBreaker < (best?.pricePerHourUSD ?? Infinity))) {
      best = x; bestScore = score;
    }
  }
  return best;
}

//
// ---------------- AZURE FINDER ----------------
//
export function findBestAzure(list, vcpu, ram, os, family) {
  if (!Array.isArray(list) || list.length === 0)
    throw new Error("Azure price list is empty");

  const wantOS = String(os || "").toLowerCase();
  const isWin = (wantOS === "windows");

  // 1) strict: OS + family (accept Unknown OS)
  let pre = list.filter(x =>
    isOnDemandShared(x) &&
    azureFamilyMatch(x, family) &&
    (normalizeOs(x.os) === wantOS || x.os === "Unknown") &&
    (!isWin || !isAzureArmInstance(x.instance))          // block ARM on Windows
  );

  // 2) fallback: remove family filter
  if (pre.length === 0 && family) {
    pre = list.filter(x =>
      isOnDemandShared(x) &&
      (normalizeOs(x.os) === wantOS || x.os === "Unknown") &&
      (!isWin || !isAzureArmInstance(x.instance))
    );
  }

  // 3) fallback: ignore OS
  if (pre.length === 0) {
    pre = list.filter(x =>
      isOnDemandShared(x) &&
      azureFamilyMatch(x, family) &&
      (!isWin || !isAzureArmInstance(x.instance))
    );
  }

  if (pre.length === 0) {
    const fLabel = family ? ` family=${family}` : "";
    throw new Error(`No Azure entries for OS=${os || "any"}${fLabel}`);
  }

  // Prefer complete specs; fallback to inferred
  const enriched = pre.map(x => {
    if (isFinite(x.vcpu) && isFinite(x.ram)) return x;
    const meta = inferAzureCoresRamFromName(x.instance);
    return { ...x, vcpu: x.vcpu ?? meta.vcpu, ram: x.ram ?? meta.ram };
  });

  let best = null, bestScore = Infinity;
  for (const x of enriched) {
    const hasSpecs = isFinite(x.vcpu) && isFinite(x.ram);
    let score = hasSpecs
      ? distance(x.vcpu, vcpu) + distance(x.ram, ram)
      : 9999;

    if (x.os === "Unknown") score += 0.5;
    const tieBreaker = x.pricePerHourUSD ?? Infinity;

    if (score < bestScore || (score === bestScore && tieBreaker < (best?.pricePerHourUSD ?? Infinity))) {
      best = x; bestScore = score;
    }
  }
  if (best) best.os = os;
  return best;
}

//
// ---------------- GCP FINDER (now centralized) ----------------
//
export function findBestGcp(list, vcpu, ram, os, family) {
  if (!Array.isArray(list) || list.length === 0)
    throw new Error("GCP price list is empty");

  const wantOS = String(os || "").toLowerCase();
  const isWin  = (wantOS === "windows");

  // 1) strict: OS + family
  let pre = list.filter(x =>
    isFinite(x?.vcpu) &&
    isFinite(x?.ram) &&
    isFinite(x?.pricePerHourUSD) &&
    (!wantOS || String(x.os || "").toLowerCase() === wantOS) &&
    gcpFamilyMatch(x, family) &&
    (!isWin || !isGcpArmInstance(x.instance))             // Windows ≠ Arm
  );

  // 2) fallback: remove family
  if (pre.length === 0 && family) {
    pre = list.filter(x =>
      isFinite(x?.vcpu) &&
      isFinite(x?.ram) &&
      isFinite(x?.pricePerHourUSD) &&
      (!wantOS || String(x.os || "").toLowerCase() === wantOS) &&
      (!isWin || !isGcpArmInstance(x.instance))
    );
  }

  // 3) fallback: ignore OS (keep family)
  if (pre.length === 0) {
    pre = list.filter(x =>
      isFinite(x?.vcpu) &&
      isFinite(x?.ram) &&
      isFinite(x?.pricePerHourUSD) &&
      gcpFamilyMatch(x, family) &&
      (!isWin || !isGcpArmInstance(x.instance))
    );
  }

  if (pre.length === 0) {
    const fLabel = family ? ` family=${family}` : "";
    throw new Error(`No GCP entries for OS=${os || "any"}${fLabel}`);
  }

  let best = null, bestScore = Infinity;
  for (const x of pre) {
    const score = Math.abs(x.vcpu - vcpu) + Math.abs(x.ram - ram);
    const tieBreaker = x.pricePerHourUSD ?? Infinity;
    if (score < bestScore || (score === bestScore && tieBreaker < (best?.pricePerHourUSD ?? Infinity))) {
      best = x; bestScore = score;
    }
  }
  return best;
}

//
// ---------------- OCI FINDER (arrays‑first, processor-aware) ----------------
//
// Signature: findBestOci(ociCompute, vcpu, ram, os, options)
//   options = { processor: "auto"|"amd"|"arm"|"intel", generation: "auto"|string }
//
// Behavior:
//   - Auto: cheapest across allowed candidates.
//   - Windows: exclude ARM always.
//   - If processor is set, restrict to that arch;
//     if generation is also set, restrict to that gen label.
//   - Returns the single cheapest candidate; tie-break by gen label.

export function findBestOci(ociCompute, vcpu, ram, os, options = {}) {
  if (!ociCompute || typeof ociCompute !== "object")
    throw new Error("OCI pricing block is missing (prices.json.oci)");

  const wantOS = normalizeOs(os || "Linux");
  const isWindows = (wantOS === "windows");

  const L = ociCompute.linux || {};
  const W = ociCompute.windows || {};

  const v = safeNum(vcpu, null);
  const m = safeNum(ram, null);
  if (!Number.isFinite(v) || !Number.isFinite(m))
    throw new Error("OCI requires numeric vCPU and RAM inputs");

  const proc = String(options.processor || "auto").toLowerCase();    // "auto"|"amd"|"arm"|"intel"
  const genFilter = String(options.generation || "auto").toLowerCase();

  const winUpliftPerVcpu = isWindows ? (safeNum(W?.license_per_vcpu_hour, 0) ?? 0) : 0;

  const candidates = [];

  function addCandidate(entry, archLabel) {
    const ocpuRate = safeNum(entry?.ocpu_per_hour, null);
    const memRate  = safeNum(entry?.ram_gb_per_hour, null);
    if (!Number.isFinite(ocpuRate) || !Number.isFinite(memRate)) return;

    // Processor filter
    if (proc !== "auto") {
      const wantArch = (proc === "arm") ? "arm" : "x86";
      if (archLabel !== wantArch) return;
    }

    // Generation filter
    const entGen = String(entry?.gen || "").toLowerCase();
    if (genFilter !== "auto" && entGen && entGen !== genFilter) return;

    // Windows excludes ARM
    if (isWindows && archLabel === "arm") return;

    const ocpu = vcpuToOcpuForArch(v, archLabel);
    const cpuBase = ocpu * ocpuRate;
    const memCost = m * memRate;
    const winLic  = v * winUpliftPerVcpu;

    const ph = cpuBase + memCost + winLic;

    candidates.push({
      provider: "oci",
      instance: entry.shape || "VM.Standard.Flex",
      vcpu: v,
      ram: m,
      os: isWindows ? "Windows" : "Linux",
      series: archLabel,
      gen: entry.gen || undefined,
      pricePerHourUSD: ph,
      breakdown: {
        cpu_base_per_hour: cpuBase,
        windows_license_per_hour: winLic,
        memory_per_hour: memCost
      }
    });
  }

  // Gather from arrays; intel may be empty in some regions
  (Array.isArray(L.amd)   ? L.amd   : []).forEach(e => addCandidate(e, "x86"));
  (Array.isArray(L.arm)   ? L.arm   : []).forEach(e => addCandidate(e, "arm"));
  (Array.isArray(L.intel) ? L.intel : []).forEach(e => addCandidate(e, "x86"));

  if (candidates.length === 0) {
    throw new Error(`No OCI candidates for processor=${proc}`);
  }

  // Sort cheapest first; tie-break by gen label (alphabetical)
  candidates.sort((a, b) =>
    a.pricePerHourUSD - b.pricePerHourUSD ||
    String(a.gen || "zzz").localeCompare(String(b.gen || "zzz"))
  );

  return candidates[0];
}
