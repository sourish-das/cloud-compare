const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const REGION = process.env.AZURE_REGION || 'East US';
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

  /* --------------------------------------------------
   * 🔽 CRITICAL: SCROLL TO ESTIMATOR AREA
   * -------------------------------------------------- */
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(2000);

  /* --------------------------------------------------
   * ✅ ENSURE VM ESTIMATOR EXISTS
   * -------------------------------------------------- */
  const regionSelect = await page.$('select[name="region"]');
  if (!regionSelect) {
    // Click first visible "Add to estimate" (VM is first card)
    const buttons = await page.$$('button:has-text("Add to estimate")');
    if (!buttons.length) {
      throw new Error('No "Add to estimate" buttons found');
    }
    await buttons[0].click();

    // Scroll again after adding
    await page.waitForTimeout(1000);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);
  }

  /* --------------------------------------------------
   * ✅ WAIT FOR ESTIMATOR CONTROLS (VISIBLE)
   * -------------------------------------------------- */
  await page.waitForSelector('select[name="region"]', { timeout: 30000 });
  await page.waitForSelector('select[name="operatingSystem"]', { timeout: 30000 });
  await page.waitForSelector('select[name="type"]', { timeout: 30000 });
  await page.waitForSelector('select[name="tier"]', { timeout: 30000 });
  await page.waitForSelector('select[name="size"]', { timeout: 30000 });

  const allRows = [];

  for (const { os, type, osLabel } of OS_TYPES) {
    /* ---------- Fixed inputs ---------- */
    await page.selectOption('select[name="region"]', { label: REGION });
    await page.selectOption('select[name="operatingSystem"]', { label: os });
    await page.selectOption('select[name="type"]', { label: type });
    await page.selectOption('select[name="tier"]', { label: 'Standard' });

    // Force repaint
    await page.waitForTimeout(1000);

    const vmOptions = await page.$$eval(
      'select[name="size"] option',
      opts => opts.map(o => ({ value: o.value, text: o.textContent.trim() }))
    );

    for (const vm of vmOptions) {
      if (!vm.value || vm.value === 'none') continue;

      await page.selectOption('select[name="size"]', vm.value);
      await page.waitForTimeout(500);

      let pricePerHourUSD = null, vcpu = null, ram = null;

      try {
        const priceText = await page.$eval('.price', el => el.textContent);
        pricePerHourUSD = parseFloat(priceText.replace(/[^0-9.]/g, '')) || null;
      } catch {}

      try {
        const specsText = await page.$eval('.specs', el => el.textContent);
        const vcpuMatch = specsText.match(/(\d+)\s*vCPU/i);
        const ramMatch = specsText.match(/(\d+)\s*GB RAM/i);
        vcpu = vcpuMatch ? Number(vcpuMatch[1]) : null;
        ram = ramMatch ? Number(ramMatch[1]) : null;
      } catch {}

      const architecture = /arm|ampere/i.test(vm.text) ? 'arm' : 'x86';
      const instance = vm.value.toLowerCase().replace(/\s+/g, '_');
      const seriesMatch = vm.text.match(/^([A-Z]+)[0-9]/i);
      const series = seriesMatch ? seriesMatch[1] : '';

      allRows.push({
        instance,
        pricePerHourUSD,
        region: 'eastus',
        os: osLabel,
        source: 'retail',
        vcpu,
        ram,
        architecture,
        displayInstance: vm.text,
        series,
        seriesName: series ? `${series}-series` : 'other-series',
        category: 'other'
      });
    }
  }

  await browser.close();

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify({ compute: allRows }, null, 2));
  console.log(`[Azure Calculator] ✅ Wrote ${allRows.length} rows -> ${OUTPUT_PATH}`);
})();
