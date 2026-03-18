// scripts/providers/azure.fetch.js
// Fetch Azure retail VM prices and enrich with vCPU/RAM + architecture
// Output: docs/data/azure/azure.prices.json

const fs = require('fs');
const path = require('path');
const https = require('https');

const {
  isWindowsRetailEligible,
  isLinuxRetailEligible,
  extractRetailHourlyUSD,
  isAzureArmInstance,
  isBurstableAzure,
  normalizeAzureInstanceName,
  fullInstanceFromRetail,
  isPrimaryOnDemandRetailItem,
  getResourceSkusMap,
  azureDisplayNameFromNormalized,
  azureSeriesFromNormalized,
  azureSeriesNameFromNormalized,
  pickAzureRhelUpliftPerVcpu,
  synthesizeAzureRhelRows,
  widenAzureSeries,
} = require('../lib/azure');

const REGION = process.env.AZURE_REGION || 'eastus';
const SUBSCRIPTION_ID = process.env.AZURE_SUBSCRIPTION_ID || '';
const ARM_TOKEN = process.env.ARM_TOKEN || '';
const OUTPUT_PATH = process.env.OUTPUT_PATH || path.join('docs','data','azure','azure.prices.json');

function fetchJson(url, headers={}){
  return new Promise((resolve, reject)=>{
    const req = https.get(url, { headers }, (res)=>{
      let data='';
      res.on('data', d=> data+=d);
      res.on('end', ()=>{
        try { resolve(JSON.parse(data)); } catch(e){ reject(e); }
      });
    });
    req.on('error', reject);
  });
}

async function fetchRetailPrices(region){
  const base = 'https://prices.azure.com/api/retail/prices';
  let next = `${base}?$filter=serviceFamily eq 'Compute'
  and contains(productName,'Virtual Machines') 
  and (armRegionName eq '${region}' or armRegionName eq '' or armRegionName eq null)`;
  const rows = [];
  let pages = 0; const MAXP=60;
  while(next && pages<MAXP){
    const j = await fetchJson(next);
    for(const it of (j.Items||[])){
      if(!isPrimaryOnDemandRetailItem(it)) continue;
      const price = extractRetailHourlyUSD(it);
      if(price==null) continue;
      const instance = fullInstanceFromRetail(it);
      if(!instance) continue;
      if(!widenAzureSeries(instance)) continue;
      if(isBurstableAzure(instance)) continue; // exclude B-series

      // OS filter: keep Linux (free distros) and Windows (license-included)
      const okLinux = isLinuxRetailEligible(it);
      const okWindows = isWindowsRetailEligible(it);
      if(!(okLinux || okWindows)) continue;
      const os = okWindows ? 'Windows' : 'Linux';

      rows.push({
        instance: normalizeAzureInstanceName(instance),
        pricePerHourUSD: price,
        region: region,
        os,
        source: 'retail'
      });
    }
    next = j.NextPageLink || null;
    pages++;
  }
  return rows;
}

function inferArchitecture(name, capsArch){
  // capsArch like 'Arm64' | 'x64' from ResourceSkus capabilities
  if (typeof capsArch === 'string'){
    const s = capsArch.toLowerCase();
    if (s.includes('arm')) return 'arm';
  }
  return isAzureArmInstance(name) ? 'arm' : 'x86';
}

async function enrichWithSkus(rows){
  if(!SUBSCRIPTION_ID || !ARM_TOKEN){
    console.warn('[Azure] Missing SUBSCRIPTION_ID/ARM_TOKEN. vCPU/RAM/arch may be null.');
    return rows.map(r=> ({...r, architecture: inferArchitecture(r.instance)}));
  }
  const skuMap = await getResourceSkusMap({ subscriptionId: SUBSCRIPTION_ID, region: REGION, armToken: ARM_TOKEN });
  return rows.map(r=>{
    const caps = skuMap.get(r.instance) || null;
    const vcpu = caps?.vcpu ?? null;
    const ram = caps?.ram ?? null;
    const arch = inferArchitecture(r.instance, caps?.CpuArchitecture || caps?.cpuArchitecture);
    return {
      ...r,
      vcpu,
      ram,
      architecture: arch,
      displayInstance: azureDisplayNameFromNormalized(r.instance),
      series: azureSeriesFromNormalized(r.instance),
      seriesName: azureSeriesNameFromNormalized(r.instance),
      category: null // filled later
    };
  });
}

function categorize(row){
  const inst = String(row.instance||'');
  const lead = inst.startsWith('standard_') ? inst[9] : inst[0];
  if(lead==='e') return 'memory';
  if(lead==='f') return 'compute';
  if(lead==='d') return 'general';
  return 'other';
}

function dedupeBy(keys){
  const seen = new Set();
  return (arr)=>{
    const out = [];
    for(const x of arr){
      const k = keys.map(k=>String(x[k]??'')).join('|');
      if(seen.has(k)) continue;
      seen.add(k);
      out.push(x);
    }
    return out;
  };
}

async function main(){
  const baseRows = await fetchRetailPrices(REGION);
  let enriched = await enrichWithSkus(baseRows);

  // Fill category + architecture fallback (for missing caps)
  enriched = enriched.map(r=> ({
    ...r,
    category: r.category || categorize(r),
    architecture: r.architecture || inferArchitecture(r.instance)
  }));

  // Synthesize RHEL from Linux (optional)
  const added = synthesizeAzureRhelRows(enriched);
  if (added>0) console.log(`[Azure] RHEL synthesized rows: ${added}`);

  // Sort stable
  enriched.sort((a,b)=> (a.instance.localeCompare(b.instance) || a.os.localeCompare(b.os)) );

  // Dedupe by instance+os+region
  const dedupe = dedupeBy(['instance','os','region']);
  const finalRows = dedupe(enriched);

  const payload = {
    meta: {
      os: ['Linux','RHEL','Windows'],
      vcpu: Array.from(new Set(finalRows.map(r=>r.vcpu).filter(x=>x!=null))).sort((a,b)=>a-b),
      ram: Array.from(new Set(finalRows.map(r=>r.ram).filter(x=>x!=null))).sort((a,b)=>a-b),
    },
    compute: finalRows
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2));
  console.log(`[Azure] Wrote ${finalRows.length} rows -> ${OUTPUT_PATH}`);
}

main().catch(e=>{
  console.error(e);
  process.exit(1);
});
