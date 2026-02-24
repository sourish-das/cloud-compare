// scripts/providers/oci.fetch.js
// Node 18+
// Live-only model: try Oracle APEX -> write docs/data/oci/oci.prices.json
// Fallback 1: last committed docs/data/oci/oci.prices.json
// Fallback 2: published list-price defaults (keeps pipeline green)

const path = require("path");
const fs = require("fs");

const {
  atomicWrite,
  warnAndSkipWriteOnEmpty,
  logStart,
  logDone
} = require("../lib/common");

const OCI_REGION = process.env.OCI_REGION || "us-ashburn-1";
const OUT = process.env.OUTPUT_PATH
  ? process.env.OUTPUT_PATH
  : path.join("docs", "data", "oci", "oci.prices.json");

// Oracle APEX public pricelist (USD) — official list-price endpoint
const APEX_URL = "https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/?currencyCode=USD";

// Oracle public page defaults (USD) - used only if APEX + last-commit both unavailable
// Baselines reflect Oracle's published list prices for Compute (OCPU/hr + Memory GB/hr)
// and Block Volume base price ($/GB-month). Keep these minimal and conservative.
const FALLBACK = {
  amd: {
    E3: { cpu: 0.025,  ram: 0.0015, shape: "VM.Standard.E3.Flex", arch: "x86" },
    E4: { cpu: 0.025,  ram: 0.0015, shape: "VM.Standard.E4.Flex", arch: "x86" },
    E5: { cpu: 0.03,   ram: 0.002,  shape: "VM.Standard.E5.Flex", arch: "x86" },
    E6: { cpu: 0.03,   ram: 0.002,  shape: "VM.Standard.E6.Flex", arch: "x86" }
  },
  arm: {
    A1: { cpu: 0.01,   ram: 0.0015, shape: "VM.Standard.A1.Flex", arch: "arm" },
    A2: { cpu: 0.014,  ram: 0.002,  shape: "VM.Standard.A2.Flex", arch: "arm" },
    A4: { cpu: 0.0138, ram: 0.0027, shape: "VM.Standard.A4.Flex", arch: "arm" }
  },
  intel: {
    Standard3:  { cpu: 0.04,  ram: 0.0015, shape: "VM.Standard3.Flex",  arch: "x86" },
    Optimized3: { cpu: 0.054, ram: 0.0015, shape: "VM.Optimized3.Flex", arch: "x86" }
  },
  bv: 0.0255, // Block Volume base ($/GB-month)
  win: 0.046  // Windows uplift ($/vCPU-hour)
};

// ---- APEX helpers
async function fetchJsonWithRetry(url, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "cloud-compare-ci/1.0", "Accept": "application/json" }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 500 * Math.pow(2, i)));
    }
  }
  throw lastErr;
}

// Regex labels used on Oracle’s price list pages
const RX = {
  // AMD
  E3_CPU: /Compute\s*-\s*Standard\s*-\s*E3\s*-\s*OCPU/i,
  E3_RAM: /Compute\s*-\s*Standard\s*-\s*E3\s*-\s*Memory/i,
  E4_CPU: /Compute\s*-\s*Standard\s*-\s*E4\s*-\s*OCPU/i,
  E4_RAM: /Compute\s*-\s*Standard\s*-\s*E4\s*-\s*Memory/i,
  E5_CPU: /Compute\s*-\s*Standard\s*-\s*E5\s*-\s*OCPU/i,
  E5_RAM: /Compute\s*-\s*Standard\s*-\s*E5\s*-\s*Memory/i,
  E6_CPU: /Compute\s*-\s*Standard\s*-\s*E6\s*-\s*OCPU/i,
  E6_RAM: /Compute\s*-\s*Standard\s*-\s*E6\s*-\s*Memory/i,
  // Arm (dash variants)
  A1_CPU: /Compute\s*(–|-)\s*Ampere\s*A1\s*(–|-)\s*OCPU/i,
  A1_RAM: /Compute\s*(–|-)\s*Ampere\s*A1\s*(–|-)\s*Memory/i,
  A2_CPU: /Compute\s*-\s*Standard\s*-\s*A2\s*-\s*OCPU/i,
  A2_RAM: /Compute\s*-\s*Standard\s*-\s*A2\s*-\s*Memory/i,
  A4_CPU: /Compute\s*-\s*Standard\s*-\s*A4\s*-\s*OCPU/i,
  A4_RAM: /Compute\s*-\s*Standard\s*-\s*A4\s*-\s*Memory/i,
  // Intel (X9 Standard/Optimized on public pages)
  X9S_CPU: /Compute\s*-\s*Standard\s*-\s*X9\s*-\s*OCPU/i,
  X9S_RAM: /Compute\s*-\s*Standard\s*-\s*X9\s*-\s*Memory/i,
  X9O_CPU: /Compute\s*-\s*Virtual\s*Machine\s*Optimized\s*-\s*X9\s*-\s*OCPU/i,
  X9O_RAM: /Compute\s*-\s*Virtual\s*Machine\s*Optimized\s*-\s*X9\s*-\s*Memory/i,
  // Windows & Block Volume
  WIN: /Windows.*(license|server).*(per.*(vCPU|OCPU).*(hour|hr))/i,
  BV:  /Block\s*Volume\s*Storage/i
};

const isNum = (x) => Number.isFinite(Number(x));
function priceOf(item){
  const c = item?.currencyCodeLocalizations?.[0];
  const p = c?.prices?.[0];
  return Number(p?.value);
}
function labelOf(item){
  return (item?.serviceName || item?.displayName || item?.partDescription || "").toString();
}
function hits(items, rx){ return items.filter(i => rx.test(labelOf(i))); }
function firstVal(items, rx, fb){
  const v = priceOf(hits(items, rx)[0]);
  return isNum(v) ? v : fb;
}
function minVal(items, rx, fb){
  const vs = hits(items, rx).map(priceOf).filter(isNum);
  return vs.length ? Math.min(...vs) : fb;
}
function ent(gen, shape, cpu, ram, arch){
  return { gen, shape, architecture: arch, ocpu_per_hour: Number(cpu), ram_gb_per_hour: Number(ram) };
}

function buildFromApex(items) {
  const amd = [
    ent("E3", "VM.Standard.E3.Flex", firstVal(items, RX.E3_CPU, FALLBACK.amd.E3.cpu), firstVal(items, RX.E3_RAM, FALLBACK.amd.E3.ram), "x86"),
    ent("E4", "VM.Standard.E4.Flex", firstVal(items, RX.E4_CPU, FALLBACK.amd.E4.cpu), firstVal(items, RX.E4_RAM, FALLBACK.amd.E4.ram), "x86"),
    ent("E5", "VM.Standard.E5.Flex", firstVal(items, RX.E5_CPU, FALLBACK.amd.E5.cpu), firstVal(items, RX.E5_RAM, FALLBACK.amd.E5.ram), "x86"),
    ent("E6", "VM.Standard.E6.Flex", firstVal(items, RX.E6_CPU, FALLBACK.amd.E6.cpu), firstVal(items, RX.E6_RAM, FALLBACK.amd.E6.ram), "x86")
  ].filter(e => isNum(e.ocpu_per_hour) && isNum(e.ram_gb_per_hour));

  const arm = [
    ent("A1", "VM.Standard.A1.Flex", firstVal(items, RX.A1_CPU, FALLBACK.arm.A1.cpu), firstVal(items, RX.A1_RAM, FALLBACK.arm.A1.ram), "arm"),
    ent("A2", "VM.Standard.A2.Flex", firstVal(items, RX.A2_CPU, FALLBACK.arm.A2.cpu), firstVal(items, RX.A2_RAM, FALLBACK.arm.A2.ram), "arm"),
    ent("A4", "VM.Standard.A4.Flex", firstVal(items, RX.A4_CPU, FALLBACK.arm.A4.cpu), firstVal(items, RX.A4_RAM, FALLBACK.arm.A4.ram), "arm")
  ].filter(e => isNum(e.ocpu_per_hour) && isNum(e.ram_gb_per_hour));

  const intel = [
    ent("Standard3", "VM.Standard3.Flex", firstVal(items, RX.X9S_CPU, FALLBACK.intel.Standard3.cpu), firstVal(items, RX.X9S_RAM, FALLBACK.intel.Standard3.ram), "x86"),
    ent("Optimized3", "VM.Optimized3.Flex", firstVal(items, RX.X9O_CPU, FALLBACK.intel.Optimized3.cpu), firstVal(items, RX.X9O_RAM, FALLBACK.intel.Optimized3.ram), "x86")
  ].filter(e => isNum(e.ocpu_per_hour) && isNum(e.ram_gb_per_hour));

  if (!amd.length) throw new Error("AMD list empty");
  if (!arm.length) throw new Error("Arm list empty");

  const win = firstVal(items, RX.WIN, FALLBACK.win);
  const bv  = minVal(items, RX.BV,  FALLBACK.bv); // prefer minimum published base

  return {
    meta: {
      provider: "oci",
      region: OCI_REGION,
      currency: "USD",
      os: ["Linux", "Windows"],
      source: "Oracle Public Pricelist (APEX) or defaults",
      last_verified: new Date().toISOString()
    },
    compute: {
      linux: { amd, arm, intel },
      windows: { license_per_vcpu_hour: win }
    },
    storage: { region: OCI_REGION, block_volume_gb_month: bv }
  };
}

function buildFromLastCommit() {
  try {
    const p = path.join("docs", "data", "oci", "oci.prices.json");
    const raw = fs.readFileSync(p, "utf-8");
    const j = JSON.parse(raw);
    // minimal sanity
    if (j?.compute?.linux?.amd?.length && j?.compute?.linux?.arm?.length) return j;
  } catch {}
  return null;
}

function buildFromFallback() {
  const amd = Object.entries(FALLBACK.amd).map(([gen, v]) => ent(gen, v.shape, v.cpu, v.ram, v.arch));
  const arm = Object.entries(FALLBACK.arm).map(([gen, v]) => ent(gen, v.shape, v.cpu, v.ram, v.arch));
  const intel = Object.entries(FALLBACK.intel).map(([gen, v]) => ent(gen, v.shape, v.cpu, v.ram, v.arch));

  return {
    meta: {
      provider: "oci",
      region: OCI_REGION,
      currency: "USD",
      os: ["Linux", "Windows"],
      source: "Oracle Public pages (defaults)",
      last_verified: new Date().toISOString()
    },
    compute: {
      linux: { amd, arm, intel },
      windows: { license_per_vcpu_hour: FALLBACK.win }
    },
    storage: { region: OCI_REGION, block_volume_gb_month: FALLBACK.bv }
  };
}

async function main() {
  logStart("[OCI] Building pricing (live → last-commit → defaults)…");

  let out;
  try {
    // 1) Try live APEX (official USD price list)
    const json = await fetchJsonWithRetry(APEX_URL);
    const items = json?.items || [];
    out = buildFromApex(items);
  } catch (e) {
    console.warn("[OCI] Live pull failed:", e?.message);
    // 2) Fallback to last committed runtime
    out = buildFromLastCommit();
    if (!out) {
      console.warn("[OCI] No last-commit runtime; using published defaults.");
      // 3) Fallback to defaults from public price pages
      out = buildFromFallback();
    }
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  warnAndSkipWriteOnEmpty(out, OUT);
  atomicWrite(OUT, out);

  logDone(`[OCI] ✅ Wrote ${OUT}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
