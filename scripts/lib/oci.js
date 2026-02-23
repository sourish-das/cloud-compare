// scripts/lib/oci.js
"use strict";

const fs = require("fs");
const path = require("path");

const OCI_REGION = process.env.OCI_REGION || "us-ashburn-1";

// Price source lives with provider scripts (data, not logic)
const SRC_PATH =
  process.env.OCI_PRICING_SOURCE ||
  path.join(__dirname, "..", "providers", "oci.pricing-source.json");

function loadSource() {
  const raw = fs.readFileSync(SRC_PATH, "utf-8");
  return JSON.parse(raw);
}

// Normalization helpers
function vcpuToOcpu_x86(vcpu) {
  // x86: 1 OCPU = 2 vCPUs
  const n = Number(vcpu);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n / 2;
}
function vcpuToOcpu_arm(vcpu) {
  // A1 is effectively 1:1 in practice for our tool model
  const n = Number(vcpu);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n;
}

function storageHourly(blockVolumeGbMonth, storageGb) {
  const gbm = Number(blockVolumeGbMonth);
  const sgb = Number(storageGb);
  if (!Number.isFinite(gbm) || !Number.isFinite(sgb)) return 0;
  // same convention as other tools: 730 hours/month
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
 * Recommend cheapest OCI option for given inputs (on-demand, list)
 * Policy:
 *  - Only VM.Standard.*.Flex
 *  - Auto(Linux): try Ampere A1 first, else AMD E4
 *  - Windows: AMD E4 only (no ARM)
 */
function recommendOci({ os, vcpu, ramGb, family, storageGb }) {
  const src = loadSource();

  const OS = String(os || "Linux");
  const isWindows = OS.toLowerCase() === "windows";

  // If RAM not explicitly provided, derive from family like your GUI
  const desiredRam =
    Number.isFinite(Number(ramGb)) && Number(ramGb) > 0
      ? Number(ramGb)
      : familyRam(vcpu, family);

  const candidates = [];

  // Candidate builder
  function addCandidate({ arch, key, shapeLabel, ocpuRate, memRate }) {
    const ocpu =
      arch === "arm" ? vcpuToOcpu_arm(vcpu) : vcpuToOcpu_x86(vcpu);

    const licenseUplift =
      isWindows ? Number(src.windows.license_per_vcpu_hour || 0) : 0;

    // license uplift modeled per vCPU-hour for Windows
    const cpuCost = (ocpu * ocpuRate) + (Number(vcpu) * licenseUplift);
    const memCost = desiredRam * memRate;

    const blockGbMonth = Number(src.storage.block_volume_gb_month);
    const storCost = storageHourly(blockGbMonth, storageGb);

    const totalPerHour = cpuCost + memCost + storCost;

    candidates.push({
      provider: "oci",
      shape: shapeLabel,
      arch,
      os: OS,
      vcpu: Number(vcpu),
      ramGb: desiredRam,
      storageGb: Number(storageGb) || 0,
      pricePerHour: totalPerHour
    });
  }

  // Auto: allow ARM first only for Linux
  if (!isWindows && String(family || "").toLowerCase() === "auto") {
    const a1 = src.linux.ampere_a1;
    addCandidate({
      arch: "arm",
      key: "ampere_a1",
      shapeLabel: a1.shape,
      ocpuRate: Number(a1.ocpu_per_hour),
      memRate: Number(a1.ram_gb_per_hour)
    });
  }

  // AMD E4 always available
  const e4 = src.linux.amd_e4;
  addCandidate({
    arch: "x86",
    key: "amd_e4",
    shapeLabel: e4.shape,
    ocpuRate: Number(e4.ocpu_per_hour),
    memRate: Number(e4.ram_gb_per_hour)
  });

  // Pick cheapest
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
