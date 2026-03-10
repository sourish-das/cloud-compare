// scripts/lib/aws.js
// Helpers for Aws Retail Prices + ResourceSkus enrichment

/**
 * Family filter: m, c, r, t, x, i, z, h
 * (same behavior as before)
 */
function isWantedEc2Family(instance = "") {
  const c = String(instance)[0]?.toLowerCase();
  return ["m", "c", "r", "t", "x", "i", "z", "h"].includes(c);
}

/**
 * Detect AWS burstable (credit-based) instance families (T-class).
 * Matches t2, t3, t3a, t4g, etc.
 * Use this in the AWS fetcher to EXCLUDE burstables at source.
 */
function isBurstableAws(instance = "") {
  const s = String(instance || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  // t + digit + optional letter suffix (t2, t3, t3a, t4g, ...)
  return /^t\d[a-z0-9]*$/.test(s);
}

/**
 * Detect AWS Graviton instance names (no public Windows AMIs).
 * Works with variants like "t4g.medium", "t4g_medium", "t4gmedium".
 */
function isAwsGravitonInstance(instance = "") {
  const s = String(instance || "").toLowerCase();
  const flat = s.replace(/[^a-z0-9]/g, ""); // normalize separators
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
 * Resolve Windows license uplift ($/vCPU-hr).
 * - If AWS_WINDOWS_RATE_PER_VCPU is set and valid (>0), use that.
 * - Otherwise default to 0.046 ($/vCPU-hr).
 */
function getAwsWindowsUplift() {
  const raw = process.env.AWS_WINDOWS_RATE_PER_VCPU;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  return 0.046; // safe default; override via env when needed
}

/**
 * Resolve RHEL license uplift ($/vCPU-hr).
 * - If AWS_RHEL_RATE_PER_VCPU is set and valid (>0), use that.
 * - Otherwise default to 0.060 ($/vCPU-hr).
 */
function getAwsRhelUplift() {
  const raw = process.env.AWS_RHEL_RATE_PER_VCPU;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  return 0.060; // conservative default; override via env when needed
}

/** Canonicalize OS label to: 'windows' | 'rhel' | 'linux' (strict word boundaries) */
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

/** Variant keyword guard (SQL, SAP, HA, etc.) for product/sku/meter names */
function _hasRhelVariantKeywords(text = "") {
  const s = String(text || "").toLowerCase();
  // Any of these signals should disqualify "plain RHEL" rows
  return /sql\s*(server|web|standard|enterprise)|\bwith\s*ha\b|\bsap\b/.test(s);
}

/**
 * True for "plain Red Hat Enterprise Linux" (license-included) rows, not BYOL,
 * and no SQL/SAP/HA bundles. Use when interpreting AWS catalog products.
 *
 * @param {object} attrs - product.attributes from AWS price index
 * @param {object} names - { productName, skuName?, meterName? } (optional extra context)
 */
function isPlainRhel(attrs = {}, names = {}) {
  // OS must be explicitly RHEL/Red Hat in catalog
  const os = String(attrs?.operatingSystem || "");
  const isRhel = (os === "RHEL" || os === "Red Hat Enterprise Linux");
  if (!isRhel) return false;

  // License must be included (no BYOL)
  const lm = String(attrs?.licenseModel || "");
  if (lm && lm !== "License Included") return false;

  // No preinstalled software (SQL etc.)
  const pre = String(attrs?.preInstalledSw || "");
  if (pre && pre !== "NA") return false;

  // Extra safety: disallow any variant keywords in nearby strings
  const blob = [
    names.productName, names.skuName, names.meterName,
    attrs.usagetype, attrs.operation
  ].filter(Boolean).join(" ");
  if (_hasRhelVariantKeywords(blob)) return false;

  return true;
}

/**
 * Prevent duplicate Windows rows for the same instance+region.
 * (cheap guard so the function is safe to call multiple times)
 */
function _hasWindowsRowAlready(rows, base) {
  const inst = String(base?.instance || "");
  const reg  = String(base?.region || "");
  return rows.some(r =>
    String(r?.instance || "") === inst &&
    String(r?.region || "")   === reg &&
    _normOs(r?.os) === "windows"
  );
}

/**
 * Prevent duplicate RHEL rows for the same instance+region.
 */
function _hasRhelRowAlready(rows, base) {
  const inst = String(base?.instance || "");
  const reg  = String(base?.region || "");
  return rows.some(r =>
    String(r?.instance || "") === inst &&
    String(r?.region || "")   === reg &&
    _normOs(r?.os) === "rhel"
  );
}

/**
 * Synthesize AWS Windows rows from Linux rows.
 *   windows_price = linux_price + (vcpu * uplift)
 * - Skips Graviton families (t4g/c7g/m7g/r7g/…)
 */
function synthesizeAwsWindowsRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  const uplift = getAwsWindowsUplift();
  let added = 0;

  const linux = rows.filter(r => _normOs(r?.os) === "linux");

  for (const base of linux) {
    const inst = String(base?.instance || "");
    const vcpu = _safeNum(base?.vcpu, null);
    const pLnx = _safeNum(base?.pricePerHourUSD, null);

    if (!inst || !Number.isFinite(vcpu) || !Number.isFinite(pLnx)) continue;
    if (isAwsGravitonInstance(inst)) continue;           // skip ARM
    if (_hasWindowsRowAlready(rows, base)) continue;     // skip if already present

    const priceWin = pLnx + (vcpu * uplift);
    if (!Number.isFinite(priceWin) || priceWin <= 0) continue;

    rows.push({
      ...base,
      os: "Windows",
      pricePerHourUSD: priceWin,
      source: ((base?.source) ? String(base.source) : "linux") + "+win"
    });
    added++;
  }

  return added;
}

/**
 * Synthesize AWS RHEL rows from Linux rows (plain RHEL only).
 *   rhel_price = linux_price + (vcpu * uplift)
 * - Unlike Windows, RHEL is allowed on ARM; we DO NOT exclude Graviton.
 * - This synthesis never creates "RHEL with HA / SQL / SAP" rows—it's built from plain Linux.
 */
function synthesizeAwsRhelRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  const uplift = getAwsRhelUplift();
  let added = 0;

  const linux = rows.filter(r => _normOs(r?.os) === "linux");

  for (const base of linux) {
    const inst = String(base?.instance || "");
    const vcpu = _safeNum(base?.vcpu, null);
    const pLnx = _safeNum(base?.pricePerHourUSD, null);

    if (!inst || !Number.isFinite(vcpu) || !Number.isFinite(pLnx)) continue;
    if (_hasRhelRowAlready(rows, base)) continue;        // skip if already present

    const priceRhel = pLnx + (vcpu * uplift);
    if (!Number.isFinite(priceRhel) || priceRhel <= 0) continue;

    rows.push({
      ...base,
      os: "RHEL",
      pricePerHourUSD: priceRhel,
      source: ((base?.source) ? String(base.source) : "linux") + "+rhel"
    });
    added++;
  }

  return added;
}

/**
 * Optional "belt-and-suspenders" post-filter:
 * Remove any RHEL rows that look like variant bundles (SQL/SAP/HA).
 * Call this once after you build 'rows' in your fetcher if you want an extra guard.
 */
function filterOnlyPlainRhel(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.filter(r => {
    if (_normOs(r?.os) !== "rhel") return true; // keep non-RHEL rows untouched

    // Check the text we have on the row (instance/region/source) and drop if variant keywords found
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

  // NEW exports for stricter control
  isPlainRhel,
  filterOnlyPlainRhel
};
