import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const CLEARANCE_URL =
  'https://www.rona.ca/webapp/wcs/stores/servlet/RonaPromoClearanceView?catalogId=10051&storeId=10151&langId=-2&pageSize=infinite&content=PromoClearance&page=1';

const DEFAULT_TIMEOUT = 30000;

const SELECTORS = {
  productTiles:
    'article[data-product], article.product-tile, .product-tile, .product-item, [data-automation="product-tile"], [data-testid*="product"], li:has(a[href*="/product/"])',
};

const CLICK_SELECTORS = {
  loadMore: [
    'button:has-text("Load more")',
    'button:has-text("Afficher plus")',
    'button:has-text("Charger plus")',
  ],
};

function logStoreSummary({ slug, storeName, tiles, parsed, kept, ms, reason }) {
  const parts = [
    `[rona] store=${slug}`,
    storeName ? `name="${storeName}"` : null,
    `tiles=${tiles}`,
    `parsed=${parsed}`,
    `kept50=${kept}`,
    ms != null ? `ms=${ms}` : null,
    reason ? `note="${reason}"` : null,
  ].filter(Boolean);
  console.log(parts.join(' '));
}

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

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function writeJson(filePath, data) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function toCsv(rows) {
  if (!rows?.length) {
    return 'name,image,regularPrice,salePrice,discountPct,url\n';
  }
  const esc = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const header = [
    'name',
    'image',
    'regularPrice',
    'salePrice',
    'discountPct',
    'url',
  ].join(',');
  const lines = rows.map((row) =>
    [
      esc(row.name),
      esc(row.image),
      row.regularPrice ?? '',
      row.salePrice ?? '',
      row.discountPct ?? '',
      esc(row.url),
    ].join(',')
  );
  return [header, ...lines].join('\n') + '\n';
}

async function writeCsv(filePath, rows) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, toCsv(rows), 'utf8');
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
  let parsedCount = 0;
  let keptCount = 0;

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

    if (item.name && Number.isFinite(salePrice)) {
      parsedCount += 1;
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

    if (discountPct !== null && discountPct >= 50) {
      keptCount += 1;
    }
  }

  return {
    products: normalized.filter(
      (item) => item.discountPct !== null && item.discountPct >= 50
    ),
    parsedCount,
    keptCount,
  };
}

async function writeOutput({ store, items, stats, debug }) {
  const baseDir = path.join('data', 'rona', store.slug);
  const jsonPath = path.join(baseDir, 'data.json');
  const csvPath = path.join(baseDir, 'data.csv');

  await writeJson(jsonPath, {
    store: { slug: store.slug, name: store.name },
    scrapedAt: new Date().toISOString(),
    count: items.length,
    items,
    stats,
  });
  await writeCsv(csvPath, items);

  if (debug?.html) {
    await ensureDir(baseDir);
    await fs.writeFile(path.join(baseDir, 'debug.html'), debug.html, 'utf8');
  }
  if (debug?.screenshot) {
    await ensureDir(baseDir);
    await fs.writeFile(path.join(baseDir, 'debug.png'), debug.screenshot);
  }
}

export async function scrapeStore(store) {
  const t0 = Date.now();
  console.log(`[rona] START store=${store.slug} name="${store.name}"`);
  let tilesCount = 0;
  let parsedCount = 0;
  let keptCount = 0;
  let products = [];
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
    const tilesLocator = page.locator(SELECTORS.productTiles);
    tilesCount = await tilesLocator.count();

    if (tilesCount === 0) {
      console.log(`[rona] tiles=0 url=${page.url()}`);
      const baseDir = path.join('data', 'rona', store.slug);
      await ensureDir(baseDir);
      await fs.writeFile(
        path.join(baseDir, 'debug.html'),
        await page.content(),
        'utf8'
      );
      await page.screenshot({
        path: path.join(baseDir, 'debug.png'),
        fullPage: true,
      });
    }

    const extracted = await extractProducts(page);
    products = extracted.products;
    const { parsedCount: parsed, keptCount: kept } = extracted;
    parsedCount = parsed;
    keptCount = kept;

    await writeOutput({
      store,
      items: products,
      stats: { tiles: tilesCount, parsedCount, keptCount },
    });

    const ms = Date.now() - t0;
    logStoreSummary({
      slug: store.slug,
      storeName: store.name,
      tiles: tilesCount,
      parsed: parsedCount,
      kept: keptCount,
      ms,
    });
    console.log(`[rona] END store=${store.slug}`);
    return products;
  } catch (error) {
    const ms = Date.now() - t0;
    logStoreSummary({
      slug: store.slug,
      storeName: store.name,
      tiles: tilesCount,
      parsed: parsedCount,
      kept: keptCount,
      ms,
      reason: error.message,
    });
    const debug = { html: null, screenshot: null };
    try {
      debug.html = await page.content();
      debug.screenshot = await page.screenshot({ fullPage: true });
    } catch (debugError) {
      // ignore debug capture errors
    }
    await writeOutput({
      store,
      items: products,
      stats: { tiles: tilesCount, parsedCount, keptCount },
      debug,
    });
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
