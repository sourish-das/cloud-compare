// scripts/lib/aws.js
// Helpers for AWS Retail Prices + RHEL/Windows synthesis

/**
 * Family filter: m, c, r, t, x, i, z, h
 */
function isWantedEc2Family(instance = "") {
  const c = String(instance)[0]?.toLowerCase();
  return ["m", "c", "r", "t", "x", "i", "z", "h"].includes(c);
}

/**
 * Detect AWS burstable (credit-based) families (t2/t3/t3a/t4g…)
 */
function isBurstableAws(instance = "") {
  const s = String(instance || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return /^t\d[a-z0-9]*$/.test(s);
}

/**
 * Detect AWS Graviton (ARM) shapes.
 */
function isAwsGravitonInstance(instance = "") {
  const s = String(instance || "").toLowerCase();
  const flat = s.replace(/[^a-z0-9]/g, "");
  return (
    flat.startsWith("t4g") ||
    /^c[6-9]g/.test(flat) ||
    /^m[6-9]g/.test(flat) ||
    /^r[6-9]g/.test(flat) ||
    /^i[6-9]g/.test(flat) ||
    /^x[6-9]g/.test(flat)
  );
}

/**
 * Windows license uplift ($/vCPU-hr).
 * Default: 0.046
 */
function getAwsWindowsUplift() {
  const raw = process.env.AWS_WINDOWS_RATE_PER_VCPU;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  return 0.046; 
}

/**
 * RHEL license uplift ($/vCPU-hr) — AWS moved to per‑vCPU billing (2024‑07‑01).
 *
 * Priority:
 *   1) AWS_RHEL_RATE_PER_VCPU_MAP (JSON: { "us-east-1":0.0168, "_default":0.016 })
 *   2) AWS_RHEL_RATE_PER_VCPU     (single numeric override)
 *   3) default = 0.0168
 */
function getAwsRhelUplift() {
  // 1) Region‑aware JSON map
  try {
    const mapRaw = process.env.AWS_RHEL_RATE_PER_VCPU_MAP;
    if (mapRaw) {
      const map = JSON.parse(mapRaw);
      const region = process.env.AWS_REGION || "us-east-1";
      const v = Number(map?.[region] ?? map?._default);
      if (Number.isFinite(v) && v > 0) return v;
    }
  } catch {}

  // 2) Single numeric override
  const raw = process.env.AWS_RHEL_RATE_PER_VCPU;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;

  // 3) Default — matched to AWS Pricing Calculator for us-east-1
  return 0.0168;
}

/**
 * Normalize OS label (linux | windows | rhel)
 */
function _normOs(val) {
  const s = String(val || "").toLowerCase();
  if (s.startsWith("win")) return "windows";
  if (/\bred\s*hat\b|\brhel\b/.test(s)) return "rhel";
  return "linux";
}

function _safeNum(v, d = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/**
 * Detect SQL/SAP/HA variant SKUs (exclude from plain RHEL)
 */
function _hasRhelVariantKeywords(text = "") {
  const s = String(text || "").toLowerCase();
  return /sql\s*(server|web|standard|enterprise)|\bwith\s*ha\b|\bsap\b/.test(s);
}

/**
 * True if catalog item is a clean RHEL‑License‑Included SKU (no BYOL, no SQL/SAP/HA).
 */
function isPlainRhel(attrs = {}, names = {}) {
  const os = String(attrs?.operatingSystem || "");
  const isRhel = (os === "RHEL" || os === "Red Hat Enterprise Linux");
  if (!isRhel) return false;

  const lm = String(attrs?.licenseModel || "");
  if (lm && lm !== "License Included") return false;

  const pre = String(attrs?.preInstalledSw || "");
  if (pre && pre !== "NA") return false;

  const blob = [
    names.productName,
    names.skuName,
    names.meterName,
    attrs.usagetype,
    attrs.operation
  ].filter(Boolean).join(" ");

  if (_hasRhelVariantKeywords(blob)) return false;

  return true;
}

/**
 * Duplicate row guards
 */
function _hasWindowsRowAlready(rows, base) {
  const inst = String(base?.instance || "");
  const reg  = String(base?.region   || "");
  return rows.some(r =>
    String(r.instance) === inst &&
    String(r.region)   === reg &&
    _normOs(r.os) === "windows"
  );
}

function _hasRhelRowAlready(rows, base) {
  const inst = String(base?.instance || "");
  const reg  = String(base?.region   || "");
  return rows.some(r =>
    String(r.instance) === inst &&
    String(r.region)   === reg &&
    _normOs(r.os) === "rhel"
  );
}

/**
 * Synthesize AWS Windows rows from Linux rows.
 */
function synthesizeAwsWindowsRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  const uplift = getAwsWindowsUplift();
  let added = 0;

  const linux = rows.filter(r => _normOs(r.os) === "linux");

  for (const base of linux) {
    const inst = String(base.instance || "");
    const vcpu = _safeNum(base.vcpu, null);
    const pLnx = _safeNum(base.pricePerHourUSD, null);

    if (!inst || !Number.isFinite(vcpu) || !Number.isFinite(pLnx)) continue;
    if (isAwsGravitonInstance(inst)) continue; 
    if (_hasWindowsRowAlready(rows, base)) continue;

    const priceWin = pLnx + (vcpu * uplift);
    if (!Number.isFinite(priceWin) || priceWin <= 0) continue;

    rows.push({
      ...base,
      os: "Windows",
      pricePerHourUSD: priceWin,
      source: (base.source ? String(base.source) : "linux") + "+win"
    });
    added++;
  }

  return added;
}

/**
 * Synthesize AWS RHEL rows from Linux rows.
 * Applies correct per‑vCPU uplift; ARM is allowed.
 */
function synthesizeAwsRhelRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  const uplift = getAwsRhelUplift();
  let added = 0;

  const linux = rows.filter(r => _normOs(r.os) === "linux");

  for (const base of linux) {
    const inst = String(base.instance || "");
    const vcpu = _safeNum(base.vcpu, null);
    const pLnx = _safeNum(base.pricePerHourUSD, null);

    if (!inst || !Number.isFinite(vcpu) || !Number.isFinite(pLnx)) continue;
    if (_hasRhelRowAlready(rows, base)) continue;

    const priceRhel = pLnx + (vcpu * uplift);
    if (!Number.isFinite(priceRhel) || priceRhel <= 0) continue;

    rows.push({
      ...base,
      os: "RHEL",
      pricePerHourUSD: priceRhel,
      source: (base.source ? String(base.source) : "linux") + "+rhel"
    });
    added++;
  }

  return added;
}

/**
 * Post‑filter: remove RHEL rows that look like SQL/SAP/HA bundles.
 */
function filterOnlyPlainRhel(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.filter(r => {
    if (_normOs(r.os) !== "rhel") return true;
    const blob = [r.instance, r.region, r.source].filter(Boolean).join(" ");
    return !_hasRhelVariantKeywords(blob);
  });
}

module.exports = {
  isWantedEc2Family,
  isBurstableAws,
  isAwsGravitonInstance,

  getAwsWindowsUplift,
  getAwsRhelUplift,

  synthesizeAwsWindowsRows,
  synthesizeAwsRhelRows,

  isPlainRhel,
  filterOnlyPlainRhel
};
