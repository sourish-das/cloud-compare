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
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 }
  });

  await page.goto('https://azure.microsoft.com/en-us/pricing/calculator/', {
    waitUntil: 'domcontentloaded'
  });

  /* ==================================================
   * 1️⃣ SCROLL TO "YOUR ESTIMATE"
   * ================================================== */
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1500);

  /* ==================================================
   * 2️⃣ FIND ALL VM ROWS
   * ================================================== */
  let vmRows = await page.$$(`text=Virtual Machines`);
  if (!vmRows.length) {
    throw new Error('Virtual Machines estimator not found after scroll');
  }

  /* ==================================================
   * 3️⃣ DELETE EXTRA VM ROWS (SAFE – ROW LEVEL ONLY)
   * ================================================== */
  if (vmRows.length > 1) {
    for (let i = vmRows.length - 1; i >= 1; i--) {
      const deleteBtn = await vmRows[i].evaluateHandle(el => {
        // Walk up to the VM row container
        let row = el;
        while (row && !row.querySelector) row = row.parentElement;

        // Find row‑local delete button only
        const buttons = Array.from(row.querySelectorAll('button'));
        return buttons.find(b =>
          b.getAttribute('aria-label') &&
          b.getAttribute('aria-label').toLowerCase().includes('delete')
        ) || null;
      });

      if (deleteBtn) {
        await deleteBtn.click();
        await page.waitForTimeout(800);
      }
    }
  }

  /* Re‑query after cleanup */
  vmRows = await page.$$(`text=Virtual Machines`);
  const mainVmRow = vmRows[0];

  /* ==================================================
   * 4️⃣ EXPAND VM ROW IF COLLAPSED
   * ================================================== */
  const expanded = await page.evaluate(() => {
    const size = document.querySelector('select[name="size"]');
    return size && size.offsetParent !== null;
  });

  if (!expanded) {
    const expandBtn = await mainVmRow.evaluateHandle(el => {
      let row = el;
      while (row && !row.querySelector) row = row.parentElement;
      return row.querySelector('button');
    });

    if (expandBtn) {
      await expandBtn.click();
      await page.waitForTimeout(1200);
    }
  }

  /* ==================================================
   * 5️⃣ WAIT FOR CONTROLS
   * ================================================== */
  await page.waitForSelector('select[name="region"]', { timeout: 30000 });
  await page.waitForSelector('select[name="operatingSystem"]', { timeout: 30000 });
  await page.waitForSelector('select[name="type"]', { timeout: 30000 });
  await page.waitForSelector('select[name="tier"]', { timeout: 30000 });
  await page.waitForSelector('select[name="size"]', { timeout: 30000 });

  /* ==================================================
   * 6️⃣ SCRAPE
   * ================================================== */
  const rows = [];

  for (const { os, type, osLabel } of OS_TYPES) {
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
