const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const REGION = 'East US';
const OUTPUT_PATH = process.env.OUTPUT_PATH || 'docs/data/azure/azure.calculator.prices.json';

const OS_TYPES = [
  { os: 'Linux', type: 'Ubuntu', osLabel: 'Linux' },
  { os: 'Linux', type: 'Red Hat Enterprise Linux', osLabel: 'RHEL' },
  { os: 'Windows', type: '(OS Only)', osLabel: 'Windows' }
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });

  await page.goto('https://azure.microsoft.com/en-us/pricing/calculator/', {
    waitUntil: 'domcontentloaded'
  });

  // 1️⃣ Scroll – VM estimator is below the fold
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(2000);

  // 2️⃣ Safety check – VM must exist
  const vmRows = await page.$$(`text=Virtual Machines`);
  if (!vmRows.length) {
    throw new Error('Virtual Machines estimator not found after scroll');
  }

  // 3️⃣ Locators (NO waitFor)
  const regionSel = page.locator('select[name="region"]');
  const osSel = page.locator('select[name="operatingSystem"]');
  const typeSel = page.locator('select[name="type"]');
  const tierSel = page.locator('select[name="tier"]');
  const sizeSel = page.locator('select[name="size"]');

  const rows = [];

  for (const { os, type, osLabel } of OS_TYPES) {
    // ✅ selectOption implicitly waits – this fixes the timeout
    await regionSel.selectOption({ label: REGION });
    await osSel.selectOption({ label: os });
    await typeSel.selectOption({ label: type });
    await tierSel.selectOption({ label: 'Standard' });

    await page.waitForTimeout(800);

    const options = await page.$$eval(
      'select[name="size"] option',
      opts => opts.map(o => ({ value: o.value, text: o.textContent.trim() }))
    );

    for (const opt of options) {
      if (!opt.value || opt.value === 'none') continue;

      await sizeSel.selectOption(opt.value);
      await page.waitForTimeout(400);

      let price = null, vcpu = null, ram = null;

      try {
        const p = await page.$eval('.price', el => el.textContent);
        price = parseFloat(p.replace(/[^0-9.]/g, '')) || null;
      } catch {}

      try {
        const s = await page.$eval('.specs', el => el.textContent);
        vcpu = Number(s.match(/(\d+)\s*vCPU/i)?.[1] ?? null);
        ram = Number(s.match(/(\d+)\s*GB RAM/i)?.[1] ?? null);
      } catch {}

      const seriesMatch = opt.text.match(/^([A-Z]+)[0-9]/i);
      const series = seriesMatch ? seriesMatch[1] : '';

      rows.push({
        instance: opt.value.toLowerCase().replace(/\s+/g, '_'),
        displayInstance: opt.text,
        pricePerHourUSD: price,
        region: 'eastus',
        os: osLabel,
        source: 'retail',
        vcpu,
        ram,
        architecture: /arm|ampere/i.test(opt.text) ? 'arm' : 'x86',
        series,
        seriesName: series ? `${series}-series` : 'other-series',
        category: 'other'
      });
    }
  }

  await browser.close();

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify({ compute: rows }, null, 2));
  console.log(`[Azure Calculator] ✅ Wrote ${rows.length} rows`);
})();
