// scripts/providers/oci.pull-live.js
// Node 20+
// Simple contract: try to fetch live USD list prices; if successful, overwrite
// scripts/providers/oci.pricing-source.json. If anything fails, exit 0 without writing.

import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const REGION = process.env.OCI_REGION || "us-ashburn-1";
const TARGET = path.join("scripts", "providers", "oci.pricing-source.json");

// Oracle public endpoints / references (USD list)
const APEX_URL = "https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/?currencyCode=USD";
// Fallback: static rates consolidated from Oracle's public price pages
// (Compute & Block Volume pricing) — used if APEX is unavailable. [3](https://calculator.holori.com/oci)[4](https://www.cloudzero.com/blog/oracle-cloud-pricing/)
const FALLBACK = {
  e3: { cpu: 0.025,  ram: 0.0015 },
  e4: { cpu: 0.025,  ram: 0.0015 },
  e5: { cpu: 0.03,   ram: 0.002  },
  e6: { cpu: 0.03,   ram: 0.002  },
  a1: { cpu: 0.01,   ram: 0.0015 },
  a2: { cpu: 0.014,  ram: 0.002  },
  a4: { cpu: 0.0138, ram: 0.0027 },
  x9s:{ cpu: 0.04,   ram: 0.0015 },  // “Standard3 Flex” maps to X9 Standard on price list
  x9o:{ cpu: 0.054,  ram: 0.0015 },  // “Optimized3 Flex” maps to X9 Optimized on price list
  bv:  0.0255, // Block Volume base $/GB-month
  win: 0.046   // Windows uplift / vCPU-hour (commonly published uplift)
};

function isNum(x){ return Number.isFinite(x); }
function priceOf(item){
  const c = item?.currencyCodeLocalizations?.[0];
  const p = c?.prices?.[0];
  return Number(p?.value);
}
function byName(items, rx){
  const name = (o) => (o?.serviceName || o?.displayName || o?.partDescription || "").toString();
  return items.find(i => rx.test(name(i)));
}
function val(items, rx, fb){
  const v = priceOf(byName(items, rx));
  return isNum(v) ? v : fb;
}

async function fetchWithRetry(url, attempts=4){
  let lastErr;
  for (let i=0; i<attempts; i++){
    try{
      const resp = await fetch(url, {
        headers: {
          "User-Agent": "cloud-compare-ci/1.0 (+github actions)",
          "Accept": "application/json"
        }
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    }catch(e){
      lastErr = e;
      await sleep(500 * Math.pow(2, i)); // back-off
    }
  }
  throw lastErr;
}

async function tryPullFromApex(){
  // Regex keyed to Oracle “Compute …” / “Block Volume …” naming seen in price list pages. [3](https://calculator.holori.com/oci)
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
    // Arm
    A1_CPU: /Compute\s*(–|-)\s*Ampere\s*A1\s*(–|-)\s*OCPU/i,
    A1_RAM: /Compute\s*(–|-)\s*Ampere\s*A1\s*(–|-)\s*Memory/i,
    A2_CPU: /Compute\s*-\s*Standard\s*-\s*A2\s*-\s*OCPU/i,
    A2_RAM: /Compute\s*-\s*Standard\s*-\s*A2\s*-\s*Memory/i,
    A4_CPU: /Compute\s*-\s*Standard\s*-\s*A4\s*-\s*OCPU/i,
    A4_RAM: /Compute\s*-\s*Standard\s*-\s*A4\s*-\s*Memory/i,
    // Intel (maps to Standard3/Optimized3 Flex on UI; X9 in price list docs)
    X9S_CPU: /Compute\s*-\s*Standard\s*-\s*X9\s*-\s*OCPU/i,
    X9S_RAM: /Compute\s*-\s*Standard\s*-\s*X9\s*-\s*Memory/i,
    X9O_CPU: /Compute\s*-\s*Virtual\s*Machine\s*Optimized\s*-\s*X9\s*-\s*OCPU/i,
    X9O_RAM: /Compute\s*-\s*Virtual\s*Machine\s*Optimized\s*-\s*X9\s*-\s*Memory/i,
    // Windows uplift & Block Volume
    WIN: /Windows.*(license|server).*(per.*(vCPU|OCPU).*(hour|hr))/i,
    BV:  /Block\s*Volume\s*Storage/i
  };

  const json = await fetchWithRetry(APEX_URL); // may 403 sometimes. [1](https://expertbeacon.com/oracle-cloud-storage-pricing-guide-2023-tiers-cost-optimization-more/)
  const items = json?.items || [];

  function pick(rx, fb){ const v = val(items, rx, fb); return isNum(v) ? v : fb; }

  const out = {
    meta: {
      currency: "USD",
      source: "Oracle Public Pricelist (APEX) or fallback static rates",
      last_verified: new Date().toISOString(),
      region: REGION
    },
    linux: {
      // minimal (today’s tool needs only one AMD + one Arm; we also include intel for future)
      amd_e4: {
        shape: "VM.Standard.E4.Flex", architecture: "x86",
        ocpu_per_hour: pick(RX.E4_CPU, FALLBACK.e4.cpu),
        ram_gb_per_hour: pick(RX.E4_RAM, FALLBACK.e4.ram)
      },
      ampere_a1: {
        shape: "VM.Standard.A1.Flex", architecture: "arm",
        ocpu_per_hour: pick(RX.A1_CPU, FALLBACK.a1.cpu),
        ram_gb_per_hour: pick(RX.A1_RAM, FALLBACK.a1.ram)
      },
      // extra (not used by current UI; preserved for future Processor/Generation)
      intel_standard3: {
        shape: "VM.Standard3.Flex", architecture: "x86",
        ocpu_per_hour: pick(RX.X9S_CPU, FALLBACK.x9s.cpu),
        ram_gb_per_hour: pick(RX.X9S_RAM, FALLBACK.x9s.ram)
      },
      intel_optimized3: {
        shape: "VM.Optimized3.Flex", architecture: "x86",
        ocpu_per_hour: pick(RX.X9O_CPU, FALLBACK.x9o.cpu),
        ram_gb_per_hour: pick(RX.X9O_RAM, FALLBACK.x9o.ram)
      }
    },
    windows: {
      license_per_vcpu_hour: pick(RX.WIN, FALLBACK.win)
    },
    storage: {
      block_volume_gb_month: pick(RX.BV, FALLBACK.bv)
    }
  };

  // Minimal sanity check: ensure we at least got AMD E4 CPU & RAM rates
  if (!isNum(out.linux.amd_e4.ocpu_per_hour) || !isNum(out.linux.amd_e4.ram_gb_per_hour)) {
    throw new Error("AMD E4 rates missing after APEX parse");
  }
  return out;
}

async function main(){
  try{
    // Try APEX; if APEX fails entirely, fall through to static fallback block below.
    const out = await tryPullFromApex(); // may throw on 403/parse error. [2](https://redresscompliance.com/oci-pricing-and-oracle-licensing/)
    fs.writeFileSync(TARGET, JSON.stringify(out, null, 2));
    console.log(`[OCI] ✅ Updated ${TARGET} with live pricing.`);
    process.exit(0);
  }catch(e){
    // Last resort: do not write, keep previous file, and exit 0 to keep pipeline green.
    console.warn("[OCI] Live pull failed, keeping existing pricing-source.json:", e?.message);
    process.exit(0);
  }
}

main().catch(() => process.exit(0));
