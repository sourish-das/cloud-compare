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

  if (family === "general") {
    return (
      name.startsWith("C3")  || name.startsWith("C3D") ||
      name.startsWith("C4")  || name.startsWith("C4A") || name.startsWith("C4D") ||
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
// ---------------- OCI HELPERS (NEW) ----------------
//
// OCI compute in your aggregated prices.json is NOT a list of instances.
// It is a small "rates object" built from oci.prices.json:
//   { linux: { amd_e4:{...}, ampere_a1:{...} }, windows:{ license_per_vcpu_hour: ... } }
// We compute the on-demand hourly price on the fly.
//
// Policy used (aligned with backend decisions):
//  - Linux + Auto: try Ampere A1, fallback AMD E4
//  - Windows: AMD E4 only (no ARM)
//  - Family filters do not change RAM/vCPU input; they only affect which candidate is allowed.
//    (Auto chooses cheapest. Non-auto defaults to AMD E4 for apples-to-apples.)

function safeNum(x, fallback = null) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function vcpuToOcpuForArch(vcpu, arch) {
  const v = safeNum(vcpu, 0);
  if (arch === "arm") return v;       // modeled 1:1
  return v / 2;                       // x86: 1 OCPU = 2 vCPU
}

export function isOciInFamily(_inst, family) {
  // OCI Flex shapes don’t map 1:1 to AWS-like families in naming.
  // We keep this permissive; selection is controlled in findBestOci.
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

  const filtered = list.filter(x =>
    isOnDemandShared(x) &&
    isFinite(x.vcpu) &&
    isFinite(x.ram) &&
    isFinite(x.pricePerHourUSD) &&
    (!wantOS || normalizeOs(x.os) === wantOS) &&
    isAwsInFamily(x.instance, family)
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

  // 1) strict: OS + family (accept Unknown OS)
  let pre = list.filter(x =>
    isOnDemandShared(x) &&
    azureFamilyMatch(x, family) &&
    (normalizeOs(x.os) === wantOS || x.os === "Unknown")
  );

  // 2) fallback: remove family filter
  if (pre.length === 0 && family) {
    pre = list.filter(x =>
      isOnDemandShared(x) &&
      (normalizeOs(x.os) === wantOS || x.os === "Unknown")
    );
  }

  // 3) fallback: ignore OS
  if (pre.length === 0) {
    pre = list.filter(x => isOnDemandShared(x) && azureFamilyMatch(x, family));
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
// ---------------- OCI FINDER (NEW) ----------------
//
export function findBestOci(ociCompute, vcpu, ram, os, family) {
  if (!ociCompute || typeof ociCompute !== "object")
    throw new Error("OCI pricing block is missing (prices.json.oci)");

  const wantOS = normalizeOs(os || "Linux");
  const fam = String(family || "auto").toLowerCase();

  const linux = ociCompute.linux || {};
  const windows = ociCompute.windows || {};

  const amd = linux.amd_e4;
  const a1  = linux.ampere_a1;

  if (!amd) throw new Error("OCI pricing missing linux.amd_e4");

  const v = safeNum(vcpu, null);
  const m = safeNum(ram, null);
  if (!Number.isFinite(v) || !Number.isFinite(m))
    throw new Error("OCI requires numeric vCPU and RAM inputs");

  const licensePerVcpuHr = (wantOS === "windows")
    ? safeNum(windows.license_per_vcpu_hour, 0) ?? 0
    : 0;

  function priceCandidate(shapeObj, arch) {
    const ocpuRate = safeNum(shapeObj?.ocpu_per_hour, null);
    const memRate  = safeNum(shapeObj?.ram_gb_per_hour, null);
    if (!Number.isFinite(ocpuRate) || !Number.isFinite(memRate)) return null;

    const ocpu = vcpuToOcpuForArch(v, arch);
    const cpuBase = ocpu * ocpuRate;
    const memCost = m * memRate;
    const winLic  = v * licensePerVcpuHr;

    const ph = cpuBase + memCost + winLic;

    return {
      provider: "oci",
      instance: shapeObj.shape,
      vcpu: v,
      ram: m,
      os: (wantOS === "windows") ? "Windows" : "Linux",
      category: fam === "auto" ? "auto" : fam,      // UI display hint
      series: arch,
      pricePerHourUSD: ph,
      // Optional breakdown for UI debugging
      breakdown: {
        cpu_base_per_hour: cpuBase,
        windows_license_per_hour: winLic,
        memory_per_hour: memCost
      }
    };
  }

  // Windows => no ARM
  if (wantOS === "windows") {
    const best = priceCandidate(amd, "x86");
    if (!best) throw new Error("OCI AMD pricing invalid");
    return best;
  }

  // Linux:
  // Auto => choose cheapest of A1 and AMD
  if (fam === "auto") {
    const cands = [];
    if (a1) {
      const c1 = priceCandidate(a1, "arm");
      if (c1) cands.push(c1);
    }
    const c2 = priceCandidate(amd, "x86");
    if (c2) cands.push(c2);

    if (cands.length === 0) throw new Error("OCI candidates missing/invalid");
    cands.sort((p, q) => p.pricePerHourUSD - q.pricePerHourUSD);
    return cands[0];
  }

  // Non-auto families: keep apples-to-apples => AMD x86
  const best = priceCandidate(amd, "x86");
  if (!best) throw new Error("OCI AMD pricing invalid");
  return best;
}
