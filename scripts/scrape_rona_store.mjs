import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const CLEARANCE_URL =
  'https://www.rona.ca/webapp/wcs/stores/servlet/RonaPromoClearanceView?catalogId=10051&storeId=10151&langId=-2&pageSize=infinite&content=PromoClearance&page=1';

const DEFAULT_TIMEOUT = 30000;

const SELECTORS = {
  productTiles:
    'article[data-product], article.product-tile, .product-tile, [data-automation="product-tile"], [data-testid*="product"]',
};

const CLICK_SELECTORS = {
  loadMore: [
    'button:has-text("Load more")',
    'button:has-text("Afficher plus")',
    'button:has-text("Charger plus")',
  ],
};

function parsePrice(raw) {
  if (!raw) return null;
  let cleaned = raw.replace(/[^0-9.,]/g, '');
  if (!cleaned) return null;
  if (cleaned.includes(',') && cleaned.includes('.')) {
    if (cleaned.lastIndexOf('.') > cleaned.lastIndexOf(',')) {
      cleaned = cleaned.replace(/,/g, '');
    } else {
      cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    }
  } else if (cleaned.includes(',')) {
    cleaned = cleaned.replace(',', '.');
  }
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : null;
}

function extractPricesFromText(text) {
  if (!text) return [];
  const matches = text.match(/\d+[\d.,]*/g) || [];
  return matches
    .map((match) => parsePrice(match))
    .filter((value) => Number.isFinite(value));
}

function computeDiscountPct(regularPrice, salePrice) {
  if (!regularPrice || !salePrice) return null;
  if (regularPrice <= 0 || salePrice <= 0) return null;
  if (salePrice >= regularPrice) return null;
  return Math.round(((regularPrice - salePrice) / regularPrice) * 100);
}

async function clickFirstVisible(page, selectors, options = {}) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if (await locator.isVisible({ timeout: options.timeout ?? 5000 })) {
        await locator.click({ timeout: options.timeout ?? 10000 });
        return true;
      }
    } catch (error) {
      // ignore and try next selector
    }
  }
  return false;
}

async function handleOneTrust(page) {
  const selectors = [
    '#onetrust-accept-btn-handler',
    'button:has-text("Accept All")',
    'button:has-text("Accept all")',
    'button:has-text("Tout accepter")',
    'button:has-text("Accepter")',
  ];
  await clickFirstVisible(page, selectors, { timeout: 5000 });
}

async function waitForTiles(page, minimumCount = 1) {
  const tiles = page.locator(SELECTORS.productTiles);
  await tiles.first().waitFor({ timeout: DEFAULT_TIMEOUT }).catch(() => {});
  const count = await tiles.count();
  if (count < minimumCount) {
    await page.waitForTimeout(2000);
  }
}

function resolveClearanceUrl(store) {
  if (store?.clearanceUrl) {
    return store.clearanceUrl;
  }
  return CLEARANCE_URL;
}

async function loadAllProducts(page) {
  await waitForTiles(page, 1);
  let previousCount = 0;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const tiles = page.locator(SELECTORS.productTiles);
    const currentCount = await tiles.count();
    if (currentCount > previousCount) {
      previousCount = currentCount;
    }

    const loadMoreVisible = await clickFirstVisible(page, CLICK_SELECTORS.loadMore, {
      timeout: 5000,
    });

    if (!loadMoreVisible) {
      break;
    }

    await page.waitForTimeout(2000);
    await page.waitForLoadState('networkidle').catch(() => {});
    await waitForTiles(page, previousCount + 1);
  }
}

async function extractProducts(page) {
  const tileData = await page.$$eval(SELECTORS.productTiles, (tiles) =>
    tiles.map((tile) => {
      const textContent = (selector) =>
        tile.querySelector(selector)?.textContent?.trim() || '';
      const anchor = tile.querySelector('a[href]');
      const name =
        textContent('[data-automation="product-title"], .product-title, .product-name') ||
        anchor?.textContent?.trim() ||
        '';
      const url = anchor?.href || anchor?.getAttribute('href') || '';
      const imageElement = tile.querySelector('img');
      const image =
        imageElement?.getAttribute('src') ||
        imageElement?.getAttribute('data-src') ||
        imageElement?.getAttribute('data-lazy') ||
        '';
      const sku =
        tile.getAttribute('data-sku') ||
        tile.getAttribute('data-product-id') ||
        tile.getAttribute('data-product') ||
        tile.querySelector('[data-sku]')?.getAttribute('data-sku') ||
        '';
      const regularPriceText =
        textContent('.price--regular, .price--original, .price--was, .was-price, .regular-price') ||
        textContent('[data-automation="regular-price"]');
      const salePriceText =
        textContent('.price--sale, .price--now, .price--special, .sale-price') ||
        textContent('[data-automation="sale-price"]');
      const priceText = Array.from(
        tile.querySelectorAll('[data-automation*="price"], .price')
      )
        .map((el) => el.textContent?.trim())
        .filter(Boolean)
        .join(' | ');

      return {
        name,
        url,
        image,
        sku,
        regularPriceText: regularPriceText || priceText,
        salePriceText,
      };
    })
  );

  const normalized = [];
  const seen = new Set();

  for (const item of tileData) {
    const priceCandidates = extractPricesFromText(item.regularPriceText);
    const saleCandidates = extractPricesFromText(item.salePriceText);

    let regularPrice = priceCandidates[0] ?? null;
    let salePrice = saleCandidates[0] ?? null;

    if (!salePrice && priceCandidates.length >= 2) {
      regularPrice = Math.max(...priceCandidates);
      salePrice = Math.min(...priceCandidates);
    }

    if (!regularPrice && saleCandidates.length >= 1) {
      regularPrice = saleCandidates[0];
    }

    const discountPct = computeDiscountPct(regularPrice, salePrice);

    const url = item.url
      ? new URL(item.url, 'https://www.rona.ca').toString()
      : '';

    if (!item.name || !url) {
      continue;
    }

    if (seen.has(url)) {
      continue;
    }

    seen.add(url);

    normalized.push({
      name: item.name,
      url,
      image: item.image,
      sku: item.sku,
      regularPrice,
      salePrice,
      discountPct,
    });
  }

  return normalized.filter((item) => item.discountPct !== null && item.discountPct >= 50);
}

function toCsv(rows) {
  const headers = [
    'name',
    'url',
    'image',
    'sku',
    'regularPrice',
    'salePrice',
    'discountPct',
  ];
  const escape = (value) => {
    if (value === null || value === undefined) return '';
    const stringValue = String(value);
    if (/[",\n]/.test(stringValue)) {
      return `"${stringValue.replace(/"/g, '""')}"`;
    }
    return stringValue;
  };

  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((key) => escape(row[key])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

async function writeOutput(store, products, debug) {
  const baseDir = path.join('data', 'rona', store.slug);
  await fs.mkdir(baseDir, { recursive: true });

  const jsonPath = path.join(baseDir, 'data.json');
  const csvPath = path.join(baseDir, 'data.csv');

  await fs.writeFile(jsonPath, JSON.stringify(products, null, 2));
  await fs.writeFile(csvPath, toCsv(products));

  if (debug?.html) {
    await fs.writeFile(path.join(baseDir, 'debug.html'), debug.html);
  }
  if (debug?.screenshot) {
    await fs.writeFile(path.join(baseDir, 'debug.png'), debug.screenshot);
  }
}

export async function scrapeStore(store) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(DEFAULT_TIMEOUT);

  try {
    const targetUrl = resolveClearanceUrl(store);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    await handleOneTrust(page);
    await loadAllProducts(page);

    const products = await extractProducts(page);

    await writeOutput(store, products);

    return products;
  } catch (error) {
    const debug = { html: null, screenshot: null };
    try {
      debug.html = await page.content();
      debug.screenshot = await page.screenshot({ fullPage: true });
    } catch (debugError) {
      // ignore debug capture errors
    }
    await writeOutput(store, [], debug);
    throw error;
  } finally {
    await context.close();
    await browser.close();
  }
}

async function main() {
  const [storeSlug] = process.argv.slice(2);
  if (!storeSlug) {
    throw new Error('Usage: node scripts/scrape_rona_store.mjs <store-slug>');
  }
  const stores = JSON.parse(await fs.readFile('stores.json', 'utf-8'));
  const store = stores.find((entry) => entry.slug === storeSlug);
  if (!store) {
    throw new Error(`Store with slug ${storeSlug} not found in stores.json`);
  }
  await scrapeStore(store);
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
