"use strict";

const fs = require("fs");
const path = require("path");

const OCI_REGION = process.env.OCI_REGION || "us-ashburn-1";

const SRC_PATH =
  process.env.OCI_PRICING_SOURCE ||
  path.join(__dirname, "..", "providers", "oci.pricing-source.json");

// ---- Cache pricing source to avoid repeated FS reads
let _cachedSource = null;
let _cachedMtimeMs = null;

function loadSourceCached() {
  const stat = fs.statSync(SRC_PATH);
  if (_cachedSource && _cachedMtimeMs === stat.mtimeMs) return _cachedSource;

  const raw = fs.readFileSync(SRC_PATH, "utf-8");
  _cachedSource = JSON.parse(raw);
  _cachedMtimeMs = stat.mtimeMs;
  return _cachedSource;
}

// Normalization helpers
function vcpuToOcpu_x86(vcpu) {
  const n = Number(vcpu);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n / 2; // x86: 1 OCPU = 2 vCPUs
}

function vcpuToOcpu_arm(vcpu) {
  const n = Number(vcpu);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n; // modeled as 1:1 for A1 in this tool
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
    case "compute":
      return n * 2;
    case "memory":
      return n * 8;
    case "general":
    default:
      return n * 4;
  }
}

/**
 * Recommend cheapest OCI option for given inputs (on-demand list).
 * Policy:
 *  - Only VM.Standard.*.Flex
 *  - Auto(Linux): try Ampere A1 first, else AMD E4
 *  - Windows: AMD E4 only (no ARM)
 */
function recommendOci({ os, vcpu, ramGb, family, storageGb }) {
  const src = loadSourceCached();

  const OS = String(os || "Linux");
  const isWindows = OS.toLowerCase() === "windows";
  const fam = String(family || "general").toLowerCase();

  const vcpuN = Number(vcpu);
  const storageN = Number(storageGb) || 0;

  // If RAM not explicitly provided, derive from family like your GUI
  const desiredRam =
    Number.isFinite(Number(ramGb)) && Number(ramGb) > 0
      ? Number(ramGb)
      : (fam === "auto" ? familyRam(vcpuN, "general") : familyRam(vcpuN, fam));

  const candidates = [];

  function safeNum(x, fallback = 0) {
    const n = Number(x);
    return Number.isFinite(n) ? n : fallback;
  }

  function addCandidate({ arch, shapeLabel, ocpuRate, memRate }) {
    const ocpu =
      arch === "arm" ? vcpuToOcpu_arm(vcpuN) : vcpuToOcpu_x86(vcpuN);

    const licenseUplift = isWindows
      ? safeNum(src?.windows?.license_per_vcpu_hour, 0)
      : 0;

    const cpuRateN = safeNum(ocpuRate);
    const memRateN = safeNum(memRate);

    // Breakdown
    const cpuBase = ocpu * cpuRateN;
    const windowsLicense = vcpuN * licenseUplift;
    const memCost = desiredRam * memRateN;

    const blockGbMonth = safeNum(src?.storage?.block_volume_gb_month, 0);
    const storCost = storageHourly(blockGbMonth, storageN);

    const totalPerHour = cpuBase + windowsLicense + memCost + storCost;

    candidates.push({
      provider: "oci",
      shape: shapeLabel,
      arch,
      os: OS,
      vcpu: vcpuN,
      ramGb: desiredRam,
      storageGb: storageN,
      pricePerHour: totalPerHour,
      breakdown: {
        cpu_base_per_hour: cpuBase,
        windows_license_per_hour: windowsLicense,
        memory_per_hour: memCost,
        storage_per_hour: storCost
      }
    });
  }

  // Auto: allow ARM first only for Linux
  if (!isWindows && fam === "auto" && src?.linux?.ampere_a1) {
    const a1 = src.linux.ampere_a1;
    addCandidate({
      arch: "arm",
      shapeLabel: a1.shape,
      ocpuRate: a1.ocpu_per_hour,
      memRate: a1.ram_gb_per_hour
    });
  }

  // AMD E4 always available (must exist)
  if (!src?.linux?.amd_e4) {
    throw new Error("[OCI] Missing linux.amd_e4 in pricing source JSON.");
  }

  const e4 = src.linux.amd_e4;
  addCandidate({
    arch: "x86",
    shapeLabel: e4.shape,
    ocpuRate: e4.ocpu_per_hour,
    memRate: e4.ram_gb_per_hour
  });

  candidates.sort((a, b) => a.pricePerHour - b.pricePerHour);
  return { best: candidates[0], candidates };
}

module.exports = {
  OCI_REGION,
  recommendOci,
  vcpuToOcpu_x86,
  vcpuToOcpu_arm,
  familyRam,
  storageHourly
};
