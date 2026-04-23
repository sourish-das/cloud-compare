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

  // 1️⃣ Scroll – VM estimator is below fold
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(2000);

  // 2️⃣ HARD wait: poll DOM until VM form actually exists
  await page.waitForFunction(() => {
    return document.querySelector('select[name="region"]');
  }, { timeout: 60000 });

  const rows = [];

  for (const { os, type, osLabel } of OS_TYPES) {
    // ✅ page.selectOption works once element exists
    await page.selectOption('select[name="region"]', { label: REGION });
    await page.selectOption('select[name="operatingSystem"]', { label: os });
    await page.selectOption('select[name="type"]', { label: type });
    await page.selectOption('select[name="tier"]', { label: 'Standard' });

    await page.waitForTimeout(800);

    const options = await page.$$eval(
      'select[name="size"] option',
      opts => opts.map(o => ({ value: o.value, text: o.textContent.trim() }))
    );

    for (const opt of options) {
      if (!opt.value || opt.value === 'none') continue;

      await page.selectOption('select[name="size"]', opt.value);
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
