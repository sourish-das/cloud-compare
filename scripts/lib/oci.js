// scripts/lib/oci.js
"use strict";

const fs = require("fs");
const path = require("path");

// Optional: used only by recommendOciFromRuntime()
const RUNTIME_PATH_DEFAULT = path.join("docs", "data", "oci", "oci.prices.json");

// ---------- Helpers ----------
function vcpuToOcpu_x86(vcpu) {
  const n = Number(vcpu);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n / 2; // x86: 1 OCPU = 2 vCPUs
}

function vcpuToOcpu_arm(vcpu) {
  const n = Number(vcpu);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n; // Ampere Flex modeled 1:1
}

function storageHourly(blockVolumeGbMonth, storageGb) {
  const gbm = Number(blockVolumeGbMonth);
  const sgb = Number(storageGb);
  if (!Number.isFinite(gbm) || !Number.isFinite(sgb) || sgb <= 0) return 0;
  return (gbm * sgb) / 730;
}

function familyRam(vcpu, family) {
  const n = Number(vcpu);
  if (!Number.isFinite(n) || n <= 0) return 0;

  switch (String(family || "").toLowerCase()) {
    case "compute": return n * 2;
    case "memory":  return n * 8;
    case "general":
    default:        return n * 4;
  }
}

/**
 * Build a recommender bound to a given OCI pricing object (preferred for UI).
 * @param {object} pricing  docs/data/oci/oci.prices.json contents (or the `oci` portion from docs/data/prices.json)
 * Expected shape:
 * {
 *   meta:{...},
 *   compute:{ linux:{ amd:[], arm:[], intel:[] }, windows:{ license_per_vcpu_hour } },
 *   storage:{ block_volume_gb_month }
 * }
 */
function createOciRecommender(pricing) {
  if (!pricing || typeof pricing !== "object") {
    throw new Error("createOciRecommender: missing pricing object");
  }

  const compute = pricing.compute || {};
  const linux = compute.linux || {};
  const windows = compute.windows || {};
  const storage = pricing.storage || {};

  /**
   * Arrays-first recommender for OCI Flex.
   * @param {object} args
   *   - os: "Linux"|"Windows"
   *   - vcpu: number
   *   - ramGb: number
   *   - family: "auto"|"general"|"compute"|"memory" (for RAM default only)
   *   - storageGb: number
   * @param {object} options?
   *   - processor?: "auto"|"amd"|"arm"|"intel"  (default "auto")
   *   - generation?: "auto"|string             (e.g., "E6","A1","Standard3","Optimized3")
   * @returns {{ best: Object, candidates: Object[] }}
   */
  function recommendOci({
    os, vcpu, ramGb, family, storageGb
  }, options = {}) {
    const OS = String(os || "Linux");
    const isWindows = OS.toLowerCase() === "windows";
    const fam = String(family || "general").toLowerCase();

    const proc = String(options.processor || "auto").toLowerCase();
    const genFilter = String(options.generation || "auto").toLowerCase();

    const v = Number(vcpu);
    const storageN = Number(storageGb) || 0;

    const desiredRam =
      Number.isFinite(Number(ramGb)) && Number(ramGb) > 0
        ? Number(ramGb)
        : (fam === "auto" ? familyRam(v, "general") : familyRam(v, fam));

    const safeNum = (x, fb = 0) => {
      const n = Number(x);
      return Number.isFinite(n) ? n : fb;
    };

    const winUplift = isWindows ? safeNum(windows?.license_per_vcpu_hour, 0) : 0;
    const bvBase = safeNum(storage?.block_volume_gb_month, 0);

    const candidates = [];

    function add(entry, archLabel) {
      const cpuRate = safeNum(entry?.ocpu_per_hour, null);
      const memRate = safeNum(entry?.ram_gb_per_hour, null);
      if (!Number.isFinite(cpuRate) || !Number.isFinite(memRate)) return;

      // Processor filter
      if (proc !== "auto") {
        const wantArch = (proc === "arm") ? "arm" : "x86";
        if (archLabel !== wantArch) return;
      }

      // Generation filter (if present)
      const entGen = String(entry?.gen || "").toLowerCase();
      if (genFilter !== "auto" && entGen && entGen !== genFilter) return;

      // Windows excludes Arm
      if (isWindows && archLabel === "arm") return;

      const ocpu = (archLabel === "arm") ? vcpuToOcpu_arm(v) : vcpuToOcpu_x86(v);
      const cpuBase = ocpu * cpuRate;
      const memCost = desiredRam * memRate;
      const winLic  = v * winUplift;
      const stor    = storageHourly(bvBase, storageN);

      const ph = cpuBase + memCost + winLic + stor;

      candidates.push({
        provider: "oci",
        shape: entry.shape || "VM.Standard.Flex",
        arch: archLabel,
        os: OS,
        vcpu: v,
        ramGb: desiredRam,
        storageGb: storageN,
        pricePerHour: ph,
        breakdown: {
          cpu_base_per_hour: cpuBase,
          windows_license_per_hour: winLic,
          memory_per_hour: memCost,
          storage_per_hour: stor
        },
        gen: entry.gen || undefined
      });
    }

    // Arrays-first (intel may be empty)
    (Array.isArray(linux.amd)   ? linux.amd   : []).forEach(e => add(e, "x86"));
    (Array.isArray(linux.arm)   ? linux.arm   : []).forEach(e => add(e, "arm"));
    (Array.isArray(linux.intel) ? linux.intel : []).forEach(e => add(e, "x86"));

    if (candidates.length === 0) {
      const p = proc || "auto";
      throw new Error(`No OCI candidates for OS=${os || "any"} processor=${p}`);
    }

    // Auto (or explicit) => pick cheapest; tie-break by gen label if present
    candidates.sort((a, b) =>
      a.pricePerHour - b.pricePerHour ||
      ((a.gen || "zzz") > (b.gen || "zzz") ? 1 : -1)
    );

    const best = candidates[0];
    return { best, candidates };
  }

  return { recommendOci };
}

/**
 * Optional Node helper: load runtime pricing from docs/data/oci/oci.prices.json
 * and run the recommender. Useful for quick CLI/tests without wiring a pricing object.
 */
function recommendOciFromRuntime(args, options = {}, runtimePath = RUNTIME_PATH_DEFAULT) {
  const raw = fs.readFileSync(runtimePath, "utf-8");
  const runtime = JSON.parse(raw);
  if (!runtime?.compute?.linux) {
    throw new Error("Invalid OCI runtime JSON: missing compute.linux");
  }
  const { recommendOci } = createOciRecommender(runtime);
  return recommendOci(args, options);
}

module.exports = {
  // Factory for browser/app code that already has pricing loaded
  createOciRecommender,

  // Convenience for Node usage
  recommendOciFromRuntime,

  // Expose helpers (unchanged API)
  vcpuToOcpu_x86,
  vcpuToOcpu_arm,
  familyRam,
  storageHourly
};
