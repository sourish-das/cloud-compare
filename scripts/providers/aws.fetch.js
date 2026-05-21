// scripts/providers/aws.fetch.js
// Node 18+ (global fetch)

const path = require("path");
const {
  atomicWrite,
  dedupeCheapestByKey,
  warnAndSkipWriteOnEmpty,
  logStart,
  logDone,
  uniqSortedNums
} = require("../lib/common");

const {
  isWantedEc2Family,
  isBurstableAws,
  isAwsGravitonInstance,
  synthesizeAwsWindowsRows,
  synthesizeAwsRhelRows,
  isPlainRhel,
  filterOnlyPlainRhel
} = require("../lib/aws");

// Region + output
const REGION = process.env.AWS_REGION || "us-east-1";
const OUT = process.env.OUTPUT_PATH || path.join("docs", "data", "aws", "aws.prices.json");

/**
 * Fetch the regional EC2 public price index JSON.
 */
async function fetchAwsIndex() {
  logStart(`[AWS] EC2 PAYG ${REGION} ...`);
  const url = `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/${REGION}/index.json`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`[AWS] Pricing HTTP ${r.status}`);
  const j = await r.json();
  logDone(`✅ [AWS] products=${Object.keys(j.products || {}).length} done`);
  return j;
}

/**
 * Pick the lowest OnDemand price dimension in USD with an hourly unit.
 * Accept both "Hrs" and "Hour" (AWS uses both).
 */
function pickHourlyUsdMin(onDemandTermsForSku) {
  if (!onDemandTermsForSku) return null;
  let best = null;

  // Scan all term keys & dimensions (some SKUs have >1)
  for (const termKey of Object.keys(onDemandTermsForSku)) {
    const dims = onDemandTermsForSku?.[termKey]?.priceDimensions || {};
    for (const dimKey of Object.keys(dims)) {
      const dim = dims[dimKey];
      const unit = String(dim?.unit || "").toLowerCase();
      if (!(unit.startsWith("hrs") || unit.startsWith("hour"))) continue;

      const usd = Number(dim?.pricePerUnit?.USD);
      if (!Number.isFinite(usd) || usd <= 0) continue;

      if (best === null || usd < best) best = usd;
    }
  }

  return best;
}

/** Normalize memory string like "16 GiB" -> 16 */
function parseGiB(memStr) {
  if (!memStr) return null;
  const n = Number(String(memStr).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Windows Server only: license included, no SQL, no BYOL */
function isWindowsServerOnly(attrs) {
  const os = String(attrs?.operatingSystem || "");
  if (os !== "Windows") return false;

  // preInstalledSw must be NA to exclude SQL Std/Ent/Web
  const pre = String(attrs?.preInstalledSw || "").trim();
  if (pre && pre !== "NA") return false;

  // licenseModel varies in AWS feed; accept common “license included” equivalents
  const lm = String(attrs?.licenseModel || "").trim();
  if (lm && !["License Included", "No License required", "NA"].includes(lm)) return false;

  return true;
}

/** Plain RHEL: exclude SQL/SAP/HA/BYOL, accept licenseModel variants */
function isPlainRhelLocal(attrs) {
  const os = String(attrs?.operatingSystem || "");
  if (!(os === "RHEL" || os === "Red Hat Enterprise Linux")) return false;

  const pre = String(attrs?.preInstalledSw || "").trim();
  if (pre && pre !== "NA") return false;

  const lm = String(attrs?.licenseModel || "").trim();
  // RHEL is typically "License Included", but allow empty/NA/No License required
  if (lm && !["License Included", "No License required", "NA"].includes(lm)) return false;

  const blob = [
    attrs?.usagetype,
    attrs?.operation,
    attrs?.softwareType,
    attrs?.productDescription
  ].filter(Boolean).join(" ").toLowerCase();

  // defensive keyword blocks
  if (blob.includes("sql")) return false;
  if (blob.includes("sap")) return false;
  if (blob.includes("ha")) return false;

  return true;
}

/** Normalize OS label for output */
function normOsOut(isLinux, isWin, isRhel, osRaw) {
  if (isWin) return "Windows";
  if (isRhel) return "RHEL";
  if (isLinux) return "Linux";
  // fallback
  const s = String(osRaw || "").toLowerCase();
  if (s.includes("rhel") || s.includes("red hat")) return "RHEL";
  if (s.includes("win")) return "Windows";
  return "Linux";
}

/** Detect AWS architecture from instance type */
function detectAwsArch(instanceType = "") {
  const t = String(instanceType).toLowerCase();
  if (/^a1\./.test(t)) return "arm";
  if (/(^|\.)(t4g|c[6-9]g|m[6-9]g|r[6-9]g|c[1-9][0-9]g|m[1-9][0-9]g|r[1-9][0-9]g)(\.|$)/.test(t)) return "arm";
  return "x86";
}

async function main() {
  const j = await fetchAwsIndex();

  const products = j.products || {};
  const onDemandTerms = (j.terms && j.terms.OnDemand) || {};

  const rows = [];

  // small debug counters (helps verify we are collecting Windows/RHEL now)
  let seenLinux = 0, seenWin = 0, seenRhel = 0;

  for (const sku in products) {
    const p = products[sku];
    if (!p || p.productFamily !== "Compute Instance") continue;

    const a = p.attributes || {};
    const inst = a.instanceType;
    if (!inst || !isWantedEc2Family(inst)) continue;

    // Exclude burstable (T-class)
    if (isBurstableAws(inst)) continue;

    // Tenancy/capacity
    if (a.tenancy !== "Shared") continue;
    if (!["Used", "Normal"].includes(a.capacitystatus)) continue;

    const osRaw = String(a.operatingSystem || "");
    const isLinux = (osRaw === "Linux");
    const isWinOK = isWindowsServerOnly(a);

    // Prefer shared lib check, but also allow local fallback to avoid “0 RHEL rows”
    const isRhelOK = isPlainRhel(a, {
      productName: p.productName || "",
      skuName: a.sku || a.instanceType || "",
      meterName: a.usagetype || a.operation || ""
    }) || isPlainRhelLocal(a);

    if (!(isLinux || isWinOK || isRhelOK)) continue;

    // Specs
    const vcpu = Number(a.vcpu);
    const ram = parseGiB(a.memory);
    if (!Number.isFinite(vcpu) || vcpu <= 0) continue;
    if (!Number.isFinite(ram) || ram <= 0) continue;

    // Windows cannot run on Graviton; keep dataset clean
    if (isWinOK && isAwsGravitonInstance(inst)) continue;

    // Price for this SKU
    const price = pickHourlyUsdMin(onDemandTerms[sku]);
    if (!(price > 0)) continue;

    const architecture = detectAwsArch(inst);

    const osOut = normOsOut(isLinux, isWinOK, isRhelOK, osRaw);
    if (osOut === "Linux") seenLinux++;
    else if (osOut === "Windows") seenWin++;
    else if (osOut === "RHEL") seenRhel++;

    rows.push({
      instance: inst,
      vcpu,
      ram,
      pricePerHourUSD: price,
      region: REGION,
      os: osOut,
      architecture,
      source: osOut === "Linux" ? "catalog" : osOut === "Windows" ? "catalog+win" : "catalog+rhel"
    });
  }

  console.log(`[AWS] pre-synth counts: Linux=${seenLinux}, Windows=${seenWin}, RHEL=${seenRhel}`);

  // Synthesize Windows rows (only if STILL missing)
  const beforeWin = rows.filter(r => r.os === "Windows").length;
  if (beforeWin === 0) {
    const added = synthesizeAwsWindowsRows(rows);
    console.log(`[AWS] Windows rows missing; synthesized ${added} rows.`);
  }

  // Synthesize RHEL rows (only if STILL missing)
  const beforeRhel = rows.filter(r => r.os === "RHEL").length;
  if (beforeRhel === 0) {
    const added = synthesizeAwsRhelRows(rows);
    console.log(`[AWS] RHEL rows missing; synthesized ${added} rows.`);
  }

  // Remove SQL/HA/SAP variants defensively (RHEL)
  const hardened = filterOnlyPlainRhel(rows);

  // Deduplicate lowest price for each (instance, region, OS)
  const cheapest = dedupeCheapestByKey(
    hardened,
    r => `${r.instance}-${r.region}-${r.os}`
  );

  const countsByOs = cheapest.reduce((acc, r) => {
    acc[r.os] = (acc[r.os] || 0) + 1;
    return acc;
  }, {});

  console.log(
    `[AWS] collected=${rows.length}, hardened=${hardened.length}, cheapest=${cheapest.length}, byOS=`,
    countsByOs
  );

  if (warnAndSkipWriteOnEmpty("AWS", cheapest)) return;

  const meta = {
    os: ["Linux", "RHEL", "Windows"],
    vcpu: uniqSortedNums(cheapest.map(x => x.vcpu)),
    ram: uniqSortedNums(cheapest.map(x => x.ram))
  };

  const storage = {
    region: REGION,
    ssd_per_gb_month: 0.08,
    hdd_st1_per_gb_month: 0.045
  };

  const out = { meta, compute: cheapest, storage };
  atomicWrite(OUT, out);
  console.log(`✅ Wrote ${OUT}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
