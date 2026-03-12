// scripts/providers/gcp.fetch.js
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
  CE_SERVICE_ID,
  classifyGcpInstance,
  extractHourlyPrice,
  inferMachineType,
  deriveVcpuRamFromType,
  regionMatches,
  isPerInstanceSku,
  // FULL-mode helpers
  getAccessTokenFromADC,
  listRegionZones,
  listZoneMachineTypes,
  buildSeriesUnitRateMaps,
  buildWindowsCoreRate,
  // RHEL per-instance adders (preferred) + fallback constant
  buildRhelPerInstanceAdders,
  RHEL_FALLBACK_RATE_PER_VCPU,
  // New helpers to keep Windows off Arm & simplify fetchers
  isGcpArmMachineType
} = require("../lib/gcp");

// Output & env
const OUT      = process.env.OUTPUT_PATH || path.join("docs", "data", "gcp", "gcp.prices.json");
const REGION   = process.env.GCP_REGION   || "us-east1";
const CURRENCY = process.env.GCP_CURRENCY || "USD";
const API_KEY  = process.env.GCP_PRICE_API_KEY;   // Catalog API (public)
const PROJECT  = process.env.GCP_PROJECT_ID;      // for Compute API fallback

// Catalog: list SKUs (paged) — prefer OAuth (Bearer) from OIDC; fall back to API key
async function listSkus(serviceId, pageToken = "") {
  const base =
    `https://cloudbilling.googleapis.com/v1/services/${serviceId}/skus` +
    `?currencyCode=${encodeURIComponent(CURRENCY)}&pageSize=5000`;
  const url = pageToken ? `${base}&pageToken=${encodeURIComponent(pageToken)}` : base;

  const bearer =
    process.env.GCLOUD_ACCESS_TOKEN ||
    process.env.GOOGLE_OAUTH_ACCESS_TOKEN ||
    "";

  const headers = bearer ? { Authorization: `Bearer ${bearer}` } : {};
  const finalUrl = bearer ? url : `${url}&key=${API_KEY}`;

  console.log(`[GCP] Catalog auth: ${bearer ? "OAuth(Bearer)" : "API key"}`);

  const r = await fetch(finalUrl, { headers });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`[GCP] skus HTTP ${r.status} ${txt}`);
  }
  return await r.json();
}

async function fetchGcpPrices() {
  logStart("[GCP] Fetching PAYG pricing via Catalog API (with FULL-mode fallback)…");

  if (!process.env.GCLOUD_ACCESS_TOKEN && !process.env.GCP_PRICE_API_KEY) {
    throw new Error("[GCP] No Catalog credentials found (need GCLOUD_ACCESS_TOKEN or GCP_PRICE_API_KEY).");
  }

  // 1) Pull all SKUs for Compute Engine (Catalog)
  const allSkus = [];
  let pageToken = "";
  do {
    const { skus = [], nextPageToken } = await listSkus(CE_SERVICE_ID, pageToken);
    allSkus.push(...skus);
    pageToken = nextPageToken || "";
  } while (pageToken);

  // Build Linux unit-rate maps (Core/Ram per series) for fallback
  const linuxSeriesRates = buildSeriesUnitRateMaps(allSkus, REGION);

  // Resolve Windows license per-vCPU rate (hybrid: Catalog if present; else public/env)
  const windowsCoreRate = buildWindowsCoreRate(allSkus, REGION);
  if (windowsCoreRate) {
    console.log(`[GCP] Windows per-vCPU (license) rate: $${windowsCoreRate.toFixed(6)}/vCPU-hr`);
  } else {
    // Hybrid resolver returns a fallback when Catalog has no license SKU.
    console.warn("[GCP] Windows per-vCPU rate not resolved; Windows synthesis will be skipped.");
  }

  // Resolve RHEL per-instance image adders from Catalog (preferred)
  const rhelAdders = buildRhelPerInstanceAdders(allSkus, REGION) || {};
  const rhelAddersCount = Object.keys(rhelAdders).length;
  if (rhelAddersCount > 0) {
    console.log(`[GCP] Discovered RHEL per-instance adders: ${rhelAddersCount} machine types (region=${REGION})`);
  } else {
    console.log("[GCP] No RHEL per-instance adders discovered in Catalog for this region.");
  }

  // Debug: show sample of rhelAdders when requested
  if (process.env.GCP_DEBUG_RHEL === "1") {
    const sample = Object.entries(rhelAdders).slice(0, 40).map(([k, v]) => ({ machine: k, price: v }));
    console.log("[GCP][RHEL] addon map sample:", JSON.stringify(sample, null, 2));
  }

  // RHEL fallback per-vCPU rate: prefer explicit env override, else use library default
  const RHEL_FALLBACK_VCPU = Number(process.env.GCP_RHEL_RATE_PER_VCPU || 0) || Number(RHEL_FALLBACK_RATE_PER_VCPU || 0);
  if (RHEL_FALLBACK_VCPU > 0) {
    console.log(`[GCP] RHEL fallback per-vCPU rate in use: $${RHEL_FALLBACK_VCPU.toFixed(6)}/vCPU-hr`);
  } else {
    console.log("[GCP] No RHEL fallback per-vCPU rate configured; RHEL synthesis will only use per-instance adders if present.");
  }

  // Optional: force composition path via env (ignores lack of per-instance rows)
  const FORCE_COMPOSE = String(process.env.GCP_FORCE_COMPOSE || "").toLowerCase() === "1";
  if (FORCE_COMPOSE) {
    console.log("[GCP] FORCE_COMPOSE=1 → will run composition fallback regardless of per-instance results.");
  }

  // 2) First pass: per‑instance SKUs (Linux + Windows + RHEL)
  const gcp_price_list = {};
  let counter = 0;

  for (const sku of allSkus) {
    const cat = sku.category || {};
    if (cat.resourceFamily !== "Compute") continue;
    if (cat.usageType && !/OnDemand/i.test(cat.usageType)) continue; // On‑demand only
    if (!regionMatches(sku.serviceRegions, REGION)) continue;

    const mt = inferMachineType(sku);
    if (!mt) continue;                   // includes exclusion of custom
    if (!isPerInstanceSku(sku, mt)) continue;

    const instTok = mt.replace(/-/g, "_").toUpperCase();
    const fam = classifyGcpInstance(instTok);
    if (!fam) continue;

    const readable = (sku.description || sku.displayName || "");
    const lname = readable.toLowerCase();
    let os = "Linux";
    if (/windows/.test(lname)) os = "Windows";
    else if (/(rhel|red\s*hat)/.test(lname)) os = "RHEL"; // detect per-instance RHEL

    const price = extractHourlyPrice(sku.pricingInfo);
    if (!(price > 0)) continue;

    const a = sku.attributes || {};
    let vcpu = a.vcpu ? Number(a.vcpu) : undefined;
    let ram  = a.memoryGb ? Number(a.memoryGb) : undefined;
    if (!vcpu || !ram) {
      const d = deriveVcpuRamFromType(mt);
      vcpu = vcpu || d.vcpu;
      ram  = ram  || d.ram;
    }
    if (!vcpu || !ram) continue;

    const key = `sku_${++counter}`;
    gcp_price_list[key] = {
      region: REGION,
      machine_type: mt,
      os,
      price_per_hour: price,
      vcpu,
      memory_gb: ram,
      __src: "catalog"
    };
  }

  // 3) Fallback: compose Linux prices using CPU/RAM unit rates + machineTypes.list
  // Determine which Linux families are missing from the per-instance pass.
  const entries = Object.values(gcp_price_list).filter(v => v.os === "Linux");
  const haveLinuxGeneral = entries.some(v => {
    const tok = v.machine_type.replace(/-/g, "_").toUpperCase();
    return classifyGcpInstance(tok) === "general";
  });
  const haveLinuxCompute = entries.some(v => {
    const tok = v.machine_type.replace(/-/g, "_").toUpperCase();
    return classifyGcpInstance(tok) === "compute";
  });
  const haveLinuxMemory = entries.some(v => {
    const tok = v.machine_type.replace(/-/g, "_").toUpperCase();
    return classifyGcpInstance(tok) === "memory";
  });

  // If per-instance produced nothing, compose ALL families.
  // Else compose only the families that are missing.
  const composeGeneral = FORCE_COMPOSE || (entries.length === 0 ? true : !haveLinuxGeneral);
  const composeCompute = FORCE_COMPOSE || (entries.length === 0 ? true : !haveLinuxCompute);
  const composeMemory  = FORCE_COMPOSE || (entries.length === 0 ? true : !haveLinuxMemory);

  const NEED_COMPOSE = composeGeneral || composeCompute || composeMemory;

  if (NEED_COMPOSE) {
    if (!PROJECT) {
      console.warn("[GCP] Fallback needed but GCP_PROJECT_ID not set; skipping composition.");
    } else {
      const token = await getAccessTokenFromADC(); // reads GCLOUD_ACCESS_TOKEN env
      if (!token) throw new Error("[GCP] Missing OIDC access token in env (GCLOUD_ACCESS_TOKEN).");

      const zones = await listRegionZones(PROJECT, REGION, token);
      if (!zones.length) {
        console.warn(`[GCP] No zones found under region prefix '${REGION}-' for project '${PROJECT}'.`);
      }
      const mtMap = new Map(); // machine_type -> { vcpu, ramGiB }

      for (const z of zones) {
        const mts = await listZoneMachineTypes(PROJECT, z, token);
        for (const mt of mts) {
          const name = String(mt.name).toLowerCase(); // e.g., n2-standard-4, m2-ultramem-208
          if (!mtMap.has(name)) {
            const vcpu   = Number(mt.guestCpus || 0);
            const ramGiB = Number(mt.memoryMb || 0) / 1024;
            if (vcpu > 0 && ramGiB > 0) mtMap.set(name, { vcpu, ramGiB });
          }
        }
      }

      for (const [mt, hw] of mtMap.entries()) {
        const instTok = mt.replace(/-/g, "_").toUpperCase();
        const fam = classifyGcpInstance(instTok);
        if (!fam) continue;
        if (fam === "general" && !composeGeneral) continue;
        if (fam === "compute" && !composeCompute) continue;
        if (fam === "memory"  && !composeMemory)  continue;

        // series = token before first dash (e.g., 'n2', 'c3d', 'm2')
        const series = mt.split("-")[0];
        const rates  = linuxSeriesRates[series];
        if (!rates || !rates.core || !rates.ram) continue;

        const price = hw.vcpu * rates.core + hw.ramGiB * rates.ram;
        if (!(price > 0)) continue;

        const key = `sku_${++counter}`;
        gcp_price_list[key] = {
          region: REGION,
          machine_type: mt,
          os: "Linux",
          price_per_hour: price,
          vcpu: hw.vcpu,
          memory_gb: hw.ramGiB,
          __src: "composed"
        };
      }
    }
  }

  // 4) Synthesize Windows rows from Linux base + per-vCPU Windows license (x86 only)
  if (windowsCoreRate) {
    const linuxEntries = Object.values(gcp_price_list).filter(v => v.os === "Linux");
    // map of existing per-instance Windows rows (avoid adding duplicate synthesized if desired)
    const existingWindows = new Set(
      Object.values(gcp_price_list)
        .filter(v => v.os === "Windows")
        .map(v => `${v.machine_type}__${v.region}`)
    );

    let added = 0;
    for (const base of linuxEntries) {
      // Skip Arm machine types entirely for Windows (e.g., t2a-*, c4a-*, n4a-*, a4x-*)
      if (isGcpArmMachineType(base.machine_type)) continue;

      // If a Catalog Windows row already exists for the same mt+region, you can skip synthesis
      const winKey = `${base.machine_type}__${base.region}`;
      if (existingWindows.has(winKey)) continue;

      const vcpu = Number(base.vcpu || 0);
      const basePrice = Number(base.price_per_hour || 0);
      if (!Number.isFinite(vcpu) || vcpu <= 0) continue;
      if (!Number.isFinite(basePrice) || basePrice <= 0) continue;

      const winPrice = basePrice + (vcpu * windowsCoreRate);
      if (!Number.isFinite(winPrice) || winPrice <= 0) continue;

      const key = `sku_${++counter}`;
      gcp_price_list[key] = {
        region: REGION,
        machine_type: base.machine_type,
        os: "Windows",
        price_per_hour: winPrice,
        vcpu: base.vcpu,
        memory_gb: base.memory_gb,
        __src: (base.__src || "catalog") + "+win"
      };
      added++;
    }
    console.log(`[GCP] Synthesized Windows rows: ${added}`);
  }

  // 5) Synthesize RHEL rows from Linux base + per-instance RHEL image adder (preferred)
  {
    const linuxEntries = Object.values(gcp_price_list).filter(v => v.os === "Linux");
    const existingRhel = new Set(
      Object.values(gcp_price_list)
        .filter(v => v.os === "RHEL")
        .map(v => `${v.machine_type}__${v.region}`)
    );

    let addedRhel = 0;
    let missingAdders = 0;

    for (const base of linuxEntries) {
      const rhelKey = `${base.machine_type}__${base.region}`;
      if (existingRhel.has(rhelKey)) continue;

      // Normalize lookup key to lowercase-hyphenated form
      const mtKey = String(base.machine_type).toLowerCase().replace(/_/g, "-");
      let adder = rhelAdders[mtKey];

      // Also try underscore form just in case (defensive)
      if (adder === undefined) {
        const mtKeyUnderscore = mtKey.replace(/-/g, "_");
        adder = rhelAdders[mtKeyUnderscore];
      }

      if (Number.isFinite(adder) && adder > 0) {
        const basePrice = Number(base.price_per_hour || 0);
        if (!(basePrice > 0)) continue;
        const rhelPrice = basePrice + adder;
        if (!Number.isFinite(rhelPrice) || rhelPrice <= 0) continue;

        const key = `sku_${++counter}`;
        gcp_price_list[key] = {
          region: REGION,
          machine_type: base.machine_type,
          os: "RHEL",
          price_per_hour: rhelPrice,
          vcpu: base.vcpu,
          memory_gb: base.memory_gb,
          __src: (base.__src || "catalog") + "+rhel(addon)"
        };
        addedRhel++;
        if (process.env.GCP_DEBUG_RHEL === "1") {
          console.log(`[GCP][RHEL] using adder ${adder} for ${base.machine_type} (${base.vcpu} vCPU) -> $${rhelPrice.toFixed(6)}/hr`);
        }
        continue;
      }

      // No per-instance adder found for this machine type
      missingAdders++;
    }

    console.log(`[GCP] Synthesized RHEL rows (addon): ${addedRhel}, missing-adders:${missingAdders}`);

    // Optional fallback: if you explicitly set GCP_RHEL_RATE_PER_VCPU or library default is present, synthesize for missing adders
    if (RHEL_FALLBACK_VCPU > 0 && missingAdders > 0) {
      let addedFb = 0;
      for (const base of linuxEntries) {
        const rhelKey = `${base.machine_type}__${base.region}`;
        if (existingRhel.has(rhelKey)) continue;

        const mtKey = String(base.machine_type).toLowerCase().replace(/_/g, "-");
        if (Number.isFinite(rhelAdders[mtKey]) && rhelAdders[mtKey] > 0) continue; // already handled

        const vcpu = Number(base.vcpu || 0);
        const basePrice = Number(base.price_per_hour || 0);
        if (!(vcpu > 0 && basePrice > 0)) continue;

        const rhelPrice = basePrice + (vcpu * RHEL_FALLBACK_VCPU);
        if (!Number.isFinite(rhelPrice) || rhelPrice <= 0) continue;

        const key = `sku_${++counter}`;
        gcp_price_list[key] = {
          region: REGION,
          machine_type: base.machine_type,
          os: "RHEL",
          price_per_hour: rhelPrice,
          vcpu: base.vcpu,
          memory_gb: base.memory_gb,
          __src: (base.__src || "catalog") + `+rhel(fallback:${RHEL_FALLBACK_VCPU})`
        };
        addedFb++;
        if (process.env.GCP_DEBUG_RHEL === "1") {
          console.log(`[GCP][RHEL] using fallback ${RHEL_FALLBACK_VCPU.toFixed(6)}/vCPU for ${base.machine_type} (${vcpu} vCPU) -> $${rhelPrice.toFixed(6)}/hr`);
        }
      }
      console.log(`[GCP] Synthesized RHEL rows via FALLBACK per‑vCPU: ${addedFb}`);
    }
  }

  if (Object.keys(gcp_price_list).length === 0) {
    const sample = allSkus
      .filter(s => (s.category?.resourceFamily === "Compute") && regionMatches(s.serviceRegions, REGION))
      .slice(0, 15)
      .map(s => s.description || s.displayName || null);
    console.warn(
      `[GCP] DEBUG: 0 rows after per-instance and composition in '${REGION}'. ` +
      `Sample:\n${JSON.stringify(sample, null, 2)}`
    );
  }

  logDone("[GCP] Pricing file loaded");
  return { gcp_price_list };
}

async function main() {
  const json = await fetchGcpPrices();

  const rows = [];
  const skus = json.gcp_price_list || {};

  for (const key in skus) {
    const item = skus[key];
    if (!item || typeof item !== "object") continue;
    if (!item.region || item.region !== REGION) continue;
    if (!item.machine_type) continue;

    // Keep hyphenated machine_type for display and storage
    const instance = String(item.machine_type); // e.g., "c4-highcpu-2"

    // classifyGcpInstance expects the tokenized form SERIES_CLASS_COUNT (underscores + uppercase)
    const instTok = instance.replace(/-/g, "_").toUpperCase(); // e.g., "C4_HIGHCPU_2"
    const category = classifyGcpInstance(instTok);
    if (!category) continue;

    // Preserve 'Windows' and 'RHEL' labels; default to Linux otherwise
    let os = "Linux";
    if (typeof item.os === "string") {
      const tag = item.os.toLowerCase();
      if (tag.includes("win")) os = "Windows";
      else if (tag.includes("rhel")) os = "RHEL";
    }

    const price = Number(item.price_per_hour);
    if (!Number.isFinite(price) || price <= 0) continue;

    const vcpu = Number(item.vcpu);
    const ram  = Number(item.memory_gb);
    if (!vcpu || !ram) continue;

    // Enrichments for UI/troubleshooting
    const series = String(item.machine_type).split("-")[0].toLowerCase(); // e.g., n2, c3d, m2
    const arch = isGcpArmMachineType(item.machine_type) ? "arm" : "x86";
    const source = item.__src || "catalog";

    rows.push({
      instance,           // hyphenated for UI: "c4-highcpu-2"
      category,
      vcpu,
      ram,
      pricePerHourUSD: price,
      region: REGION,
      os,
      series,
      arch,
      source
    });
  }

  const cheapest = dedupeCheapestByKey(
    rows,
    r => `${r.instance}-${r.region}-${r.os}`
  );

  // Quick category counts (nice for logs)
  const counts = cheapest.reduce((acc, r) => {
    acc[r.category] = (acc[r.category] || 0) + 1;
    return acc;
  }, {});
  console.log("[GCP] category-counts:", counts, "region:", REGION);

  console.log(`[GCP] collected=${rows.length}, cheapest=${cheapest.length}`);
  if (warnAndSkipWriteOnEmpty("GCP", cheapest)) return;

  const meta = {
    os: ["Linux", "Windows", "RHEL"],
    vcpu: uniqSortedNums(cheapest.map(x => x.vcpu)),
    ram:  uniqSortedNums(cheapest.map(x => x.ram))
  };

  // Storage (public list prices converted to hourly in UI)
  const storage = {
    region: REGION,
    ssd_per_gb_month: 0.17,
    hdd_per_gb_month: 0.04
  };

  const out = { meta, compute: cheapest, storage };
  atomicWrite(OUT, out);
  console.log(`✅ Wrote ${OUT}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
