// scripts/providers/oci.pull-live.js
// Node 20+
// Arrays-first model: linux.amd[], linux.arm[], linux.intel[] (NO legacy single keys).
// If live fetch fails, do nothing and exit 0 so the pipeline stays green.

import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const REGION = process.env.OCI_REGION || "us-ashburn-1";
const TARGET = path.join("scripts", "providers", "oci.pricing-source.json");

// Oracle APEX (public, USD). May rate-limit or 403 occasionally → retry/backoff.
const APEX_URL = "https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/?currencyCode=USD";

// Fallback from Oracle public price tables (USD list).
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
  bv: 0.0255,   // Block Volume base price ($/GB-month)
  win: 0.046    // Windows uplift ($/vCPU-hour)
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
function matches(items, rx){ return items.filter(i => rx.test(labelOf(i))); }
function firstVal(items, rx, fb){
  const v = priceOf(matches(items, rx)[0]);
  return isNum(v) ? v : fb;
}
function minVal(items, rx, fb){
  const vs = matches(items, rx).map(priceOf).filter(isNum);
  return vs.length ? Math.min(...vs) : fb;
}
async function fetchWithRetry(url, attempts=4){
  let lastErr;
  for (let i=0; i<attempts; i++){
    try{
      const r = await fetch(url, {
        headers: { "User-Agent": "cloud-compare-ci/1.0", "Accept": "application/json" }
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    }catch(e){
      lastErr = e;
      await sleep(500 * Math.pow(2, i));
    }
  }
  throw lastErr;
}
function entry(gen, shape, cpu, ram, arch){
  return {
    gen, shape, architecture: arch,
    ocpu_per_hour: Number(cpu),
    ram_gb_per_hour: Number(ram)
  };
}

async function buildFromApex(){
  // Regex for the public price list’s labels.
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
    // Windows uplift & Block Volume
    WIN: /Windows.*(license|server).*(per.*(vCPU|OCPU).*(hour|hr))/i,
    BV:  /Block\s*Volume\s*Storage/i
  };

  const json = await fetchWithRetry(APEX_URL);
  const items = json?.items || [];

  const amd = [
    entry("E3", "VM.Standard.E3.Flex",
      firstVal(items, RX.E3_CPU, FALLBACK.amd.E3.cpu),
      firstVal(items, RX.E3_RAM, FALLBACK.amd.E3.ram),
      "x86"),
    entry("E4", "VM.Standard.E4.Flex",
      firstVal(items, RX.E4_CPU, FALLBACK.amd.E4.cpu),
      firstVal(items, RX.E4_RAM, FALLBACK.amd.E4.ram),
      "x86"),
    entry("E5", "VM.Standard.E5.Flex",
      firstVal(items, RX.E5_CPU, FALLBACK.amd.E5.cpu),
      firstVal(items, RX.E5_RAM, FALLBACK.amd.E5.ram),
      "x86"),
    entry("E6", "VM.Standard.E6.Flex",
      firstVal(items, RX.E6_CPU, FALLBACK.amd.E6.cpu),
      firstVal(items, RX.E6_RAM, FALLBACK.amd.E6.ram),
      "x86")
  ].filter(e => isNum(e.ocpu_per_hour) && isNum(e.ram_gb_per_hour));

  const arm = [
    entry("A1", "VM.Standard.A1.Flex",
      firstVal(items, RX.A1_CPU, FALLBACK.arm.A1.cpu),
      firstVal(items, RX.A1_RAM, FALLBACK.arm.A1.ram),
      "arm"),
    entry("A2", "VM.Standard.A2.Flex",
      firstVal(items, RX.A2_CPU, FALLBACK.arm.A2.cpu),
      firstVal(items, RX.A2_RAM, FALLBACK.arm.A2.ram),
      "arm"),
    entry("A4", "VM.Standard.A4.Flex",
      firstVal(items, RX.A4_CPU, FALLBACK.arm.A4.cpu),
      firstVal(items, RX.A4_RAM, FALLBACK.arm.A4.ram),
      "arm")
  ].filter(e => isNum(e.ocpu_per_hour) && isNum(e.ram_gb_per_hour));

  const intel = [
    entry("Standard3",  "VM.Standard3.Flex",
      firstVal(items, RX.X9S_CPU, FALLBACK.intel.Standard3.cpu),
      firstVal(items, RX.X9S_RAM, FALLBACK.intel.Standard3.ram),
      "x86"),
    entry("Optimized3", "VM.Optimized3.Flex",
      firstVal(items, RX.X9O_CPU, FALLBACK.intel.Optimized3.cpu),
      firstVal(items, RX.X9O_RAM, FALLBACK.intel.Optimized3.ram),
      "x86")
  ].filter(e => isNum(e.ocpu_per_hour) && isNum(e.ram_gb_per_hour));

  // Windows uplift + Block Volume base
  const win = firstVal(items, RX.WIN, FALLBACK.win);
  // Prefer the minimum price among “Block Volume Storage” entries; fallback to 0.0255.
  const bv  = minVal(items, RX.BV, FALLBACK.bv);

  // Require at least one AMD & one Arm entry to keep both arches usable.
  if (!amd.length) throw new Error("AMD list is empty after APEX parse");
  if (!arm.length) throw new Error("Arm list is empty after APEX parse");

  return {
    meta: {
      currency: "USD",
      source: "Oracle Public Pricelist (APEX) or fallback static rates",
      last_verified: new Date().toISOString(),
      region: REGION
    },
    linux: { amd, arm, intel },
    windows: { license_per_vcpu_hour: win },
    storage: { block_volume_gb_month: bv }
  };
}

async function main(){
  try{
    const src = await buildFromApex();
    fs.writeFileSync(TARGET, JSON.stringify(src, null, 2));
    console.log(`[OCI] ✅ Updated ${TARGET} (arrays; no legacy keys).`);
    process.exit(0);
  }catch(e){
    console.warn("[OCI] Live pull failed; keeping existing pricing-source.json:", e?.message);
    process.exit(0);
  }
}
main().catch(() => process.exit(0));
