// docs/ui/matchers.js
// All matching logic: normalization, families, scoring, inference, and fallbacks

//
// ---------------- OS NORMALIZATION (UPDATED) ----------------
//
export function normalizeOs(val) {
  const s = String(val || '').toLowerCase();
  if (s.startsWith('win')) return 'windows';
  if (/\bred\s*hat\b|\brhel\b/.test(s)) return 'rhel';
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
// ---------------- Generation ranking helpers ----------------
//
// For family-selected flows: pick latest generation (NOT cheapest)
// Tie-breaks still use price to keep deterministic.
function genRankAws(instance) {
  // m7i.large -> 7, c6a.xlarge -> 6
  const s = String(instance || "").toLowerCase();
  const m = s.match(/[a-z]+(\d{1,2})/);
  return m ? Number(m[1]) : 0;
}

function genRankAzure(instance) {
  // Standard_D4s_v5 -> 5
  const s = String(instance || "").toLowerCase();
  const m = s.match(/_v(\d{1,2})\b/);
  return m ? Number(m[1]) : 0;
}

function genRankGcp(instance) {
  // n2-standard-4 -> 2 ; c3-standard-8 -> 3
  const s = String(instance || "").toLowerCase();
  const head = s.split("-")[0];
  const m = head.match(/[a-z]+(\d{1,2})/);
  return m ? Number(m[1]) : 0;
}

// OCI generation helpers
function ociGenNumber(gen) {
  // E6 -> 6, A4 -> 4, Standard3 -> 3, Optimized3 -> 3
  const g = String(gen || "");
  const m = g.match(/(\d+)/);
  return m ? Number(m[1]) : 0;
}
function ociIntelVariantRank(gen) {
  // Prefer Standard over Optimized for same generation unless you decide otherwise
  const g = String(gen || "").toLowerCase();
  if (g.startsWith("standard")) return 2;
  if (g.startsWith("optimized")) return 1;
  return 0;
}

//
// ---------------- OCI HELPERS (UPDATED) ----------------
//
// With the arrays-first model, OCI compute looks like: [2](https://www.cloudcompare.org/tutorials.html)
//   oci.compute = {
//     linux: { amd:[{gen,shape,architecture,ocpu_per_hour,ram_gb_per_hour},...],
//              arm:[...],
//              intel:[...] },
//     windows: { license_per_vcpu_hour },
//     (optional) rhel: { license_per_vcpu_hour }
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
// RULES:
// - Auto (family empty): spec distance first, cheapest tie-breaker
// - Family selected: spec distance first, LATEST generation tie-breaker, then cheapest
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

  let best = null;
  let bestScore = Infinity;
  let bestGen = -1;

  for (const x of filtered) {
    const score = distance(x.vcpu, vcpu) + distance(x.ram, ram);
    const gen = genRankAws(x.instance);
    const price = x.pricePerHourUSD ?? Infinity;

    if (!family) {
      // AUTO: cheapest tie-breaker
      if (score < bestScore || (score === bestScore && price < (best?.pricePerHourUSD ?? Infinity))) {
        best = x; bestScore = score;
      }
    } else {
      // FAMILY: latest gen wins inside best-score bucket
      if (score < bestScore) {
        best = x; bestScore = score; bestGen = gen;
      } else if (score === bestScore) {
        if (gen > bestGen) {
          best = x; bestGen = gen;
        } else if (gen === bestGen && price < (best?.pricePerHourUSD ?? Infinity)) {
          best = x;
        }
      }
    }
  }

  return best;
}

//
// ---------------- AZURE FINDER ----------------
//
// RULES:
// - Auto: OS+family as requested; allow Unknown OS; cheapest tie-breaker
// - Family selected: DO NOT DROP family filter; pick latest gen inside best-score bucket
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

  // NOTE: We intentionally do NOT drop family filter when family is selected.
  // Only fallback allowed: ignore OS (but keep family)
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

  let best = null;
  let bestScore = Infinity;
  let bestGen = -1;

  for (const x of enriched) {
    const hasSpecs = isFinite(x.vcpu) && isFinite(x.ram);
    const baseScore = hasSpecs ? distance(x.vcpu, vcpu) + distance(x.ram, ram) : 9999;

    const gen = genRankAzure(x.instance);
    const price = x.pricePerHourUSD ?? Infinity;

    if (!family) {
      // AUTO: keep Unknown OS slightly worse
      let score = baseScore;
      if (x.os === "Unknown") score += 0.5;

      if (score < bestScore || (score === bestScore && price < (best?.pricePerHourUSD ?? Infinity))) {
        best = x; bestScore = score;
      }
    } else {
      // FAMILY: latest generation inside best-score bucket
      if (baseScore < bestScore) {
        best = x; bestScore = baseScore; bestGen = gen;
      } else if (baseScore === bestScore) {
        if (gen > bestGen) {
          best = x; bestGen = gen;
        } else if (gen === bestGen && price < (best?.pricePerHourUSD ?? Infinity)) {
          best = x;
        }
      }
    }
  }

  if (best) best.os = os; // ensure UI sees the requested OS label
  return best;
}

//
// ---------------- GCP FINDER (now centralized) ----------------
//
// RULES:
// - Auto: OS+family; cheapest tie-breaker
// - Family selected: do NOT drop family; choose latest gen inside best-score bucket
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

  // NOTE: We intentionally do NOT drop family filter when family is selected.
  // Fallback allowed: ignore OS (but keep family)
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

  let best = null;
  let bestScore = Infinity;
  let bestGen = -1;

  for (const x of pre) {
    const score = Math.abs(x.vcpu - vcpu) + Math.abs(x.ram - ram);
    const gen = genRankGcp(x.instance);
    const price = x.pricePerHourUSD ?? Infinity;

    if (!family) {
      // AUTO: cheapest tie-breaker
      if (score < bestScore || (score === bestScore && price < (best?.pricePerHourUSD ?? Infinity))) {
        best = x; bestScore = score;
      }
    } else {
      // FAMILY: latest gen inside best-score bucket
      if (score < bestScore) {
        best = x; bestScore = score; bestGen = gen;
      } else if (score === bestScore) {
        if (gen > bestGen) {
          best = x; bestGen = gen;
        } else if (gen === bestGen && price < (best?.pricePerHourUSD ?? Infinity)) {
          best = x;
        }
      }
    }
  }

  return best;
}

//
// ---------------- OCI FINDER (arrays-first, processor-aware) — UPDATED FOR RHEL ----------------
//
// RULES (as per your latest requirement): [2](https://www.cloudcompare.org/tutorials.html)
// - Auto: absolute cheapest across amd + intel + arm (Windows excludes arm) [1](https://github.com/sourish-das/cloud-compare/actions/workflows/update-azure.yml)[2](https://www.cloudcompare.org/tutorials.html)
// - Processor selected: latest generation ONLY (NOT cheapest-in-latest)
export function findBestOci(ociCompute, vcpu, ram, os, options = {}) {
  if (!ociCompute || typeof ociCompute !== "object")
    throw new Error("OCI pricing block is missing (prices.json.oci)");

  const wantOS = normalizeOs(os || "Linux");          // "linux" | "windows" | "rhel"
  const isWindows = (wantOS === "windows");
  const isRhel    = (wantOS === "rhel");

  const L = ociCompute.linux || {};
  const W = ociCompute.windows || {};
  const R = ociCompute.rhel || {};                    // optional (BYOS uplift if present)

  const v = safeNum(vcpu, null);
  const m = safeNum(ram, null);
  if (!Number.isFinite(v) || !Number.isFinite(m))
    throw new Error("OCI requires numeric vCPU and RAM inputs");

  const proc = String(options.processor || "auto").toLowerCase();    // "auto"|"amd"|"arm"|"intel"
  const mode = String(options.mode || "auto").toLowerCase();         // "auto"|"latest"
  // Backward compatibility: if someone still sends generation, keep honoring it
  const genFilter = String(options.generation || "auto").toLowerCase();

  const winUpliftPerVcpu  = isWindows ? (safeNum(W?.license_per_vcpu_hour, 0) ?? 0) : 0;

  // RHEL uplift priority:
  //   1) ociCompute.rhel.license_per_vcpu_hour (if backend provides)
  //   2) window.OCI_RHEL_RATE_PER_VCPU (if exposed by app)
  //   3) 0
  const rhelUpliftPerVcpu = isRhel
    ? (safeNum(R?.license_per_vcpu_hour,
        safeNum(typeof window !== "undefined" ? window.OCI_RHEL_RATE_PER_VCPU : undefined, 0)) ?? 0)
    : 0;

  const candidates = [];

  function addCandidate(entry, processorKey) {
    const ocpuRate = safeNum(entry?.ocpu_per_hour, null);
    const memRate  = safeNum(entry?.ram_gb_per_hour, null);
    if (!Number.isFinite(ocpuRate) || !Number.isFinite(memRate)) return;

    // Strict processor filter
    if (proc !== "auto" && processorKey !== proc) return;

    // Windows excludes ARM
    if (isWindows && processorKey === "arm") return;

    // Back-compat generation filter (if provided)
    const entGen = String(entry?.gen || "").toLowerCase();
    if (genFilter !== "auto" && entGen && entGen !== genFilter) return;

    const archLabel = (processorKey === "arm") ? "arm" : "x86";
    const ocpu = vcpuToOcpuForArch(v, archLabel);

    const cpuBase = ocpu * ocpuRate;
    const memCost = m * memRate;

    const winLic  = v * winUpliftPerVcpu;
    const rhelLic = v * rhelUpliftPerVcpu;

    const ph = cpuBase + memCost + winLic + rhelLic;

    candidates.push({
      provider: "oci",
      instance: entry.shape || "VM.Standard.Flex",
      vcpu: v,
      ram: m,
      os: isWindows ? "Windows" : (isRhel ? "RHEL" : "Linux"),
      series: processorKey,
      gen: entry.gen || undefined,
      pricePerHourUSD: ph,
      breakdown: {
        cpu_base_per_hour: cpuBase,
        windows_license_per_hour: winLic || undefined,
        rhel_license_per_hour: rhelLic || undefined,
        memory_per_hour: memCost
      }
    });
  }

  (Array.isArray(L.amd)   ? L.amd   : []).forEach(e => addCandidate(e, "amd"));
  (Array.isArray(L.arm)   ? L.arm   : []).forEach(e => addCandidate(e, "arm"));
  (Array.isArray(L.intel) ? L.intel : []).forEach(e => addCandidate(e, "intel"));

  if (candidates.length === 0) {
    throw new Error(`No OCI candidates for processor=${proc}`);
  }

  // Processor selected + latest mode => pick latest gen ONLY (not cheapest-in-latest)
  if (proc !== "auto" && mode === "latest") {
    let best = null;
    let bestGen = -1;
    let bestIntelVariant = -1;

    for (const c of candidates) {
      const g = ociGenNumber(c.gen);

      if (g > bestGen) {
        best = c;
        bestGen = g;
        bestIntelVariant = (proc === "intel") ? ociIntelVariantRank(c.gen) : -1;
        continue;
      }

      if (g === bestGen && proc === "intel") {
        const vr = ociIntelVariantRank(c.gen);
        if (vr > bestIntelVariant) {
          best = c;
          bestIntelVariant = vr;
        }
      }
    }

    return best;
  }

  // AUTO => absolute cheapest (spec distance is irrelevant because OCI candidates are built for chosen vCPU/RAM)
  let best = null;
  let bestPrice = Infinity;

  for (const c of candidates) {
    const price = Number(c.pricePerHourUSD ?? Infinity);
    if (price < bestPrice) {
      best = c;
      bestPrice = price;
    }
  }

  return best;
}
