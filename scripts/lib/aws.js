// scripts/lib/aws.js

/**
 * Family filter: m, c, r, t, x, i, z, h
 * (same behavior as before)
 */
function isWantedEc2Family(instance = "") {
  const c = String(instance)[0]?.toLowerCase();
  return ["m", "c", "r", "t", "x", "i", "z", "h"].includes(c);
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

function _normOs(val) {
  const s = String(val || "").toLowerCase();
  return s.startsWith("win") ? "windows" : "linux";
}

function _safeNum(v, d = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
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
 * Synthesize AWS Windows rows from Linux rows.
 *   windows_price = linux_price + (vcpu * uplift)
 * - Skips Graviton families (t4g/c7g/m7g/r7g/...)
 * - Keeps all other fields the same; sets os="Windows" and
 *   appends "+win" to the source marker for traceability.
 *
 * @param {Array<Object>} rows - array of provider-normalized rows
 * @returns {number} count of Windows rows added
 */
function synthesizeAwsWindowsRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  const uplift = getAwsWindowsUplift();
  let added = 0;

  // Use only Linux rows as base
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

module.exports = {
  isWantedEc2Family,
  isAwsGravitonInstance,
  getAwsWindowsUplift,
  synthesizeAwsWindowsRows
};
