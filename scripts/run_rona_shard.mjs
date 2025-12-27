import fs from 'node:fs/promises';
import path from 'node:path';
import { scrapeStore } from './scrape_rona_store.mjs';

function getShardConfig() {
  const shardIndex = Number.parseInt(process.env.SHARD_INDEX, 10);
  const totalShards = Number.parseInt(process.env.TOTAL_SHARDS, 10);

  if (!Number.isInteger(shardIndex) || !Number.isInteger(totalShards)) {
    throw new Error('SHARD_INDEX and TOTAL_SHARDS must be integers.');
  }
  if (shardIndex < 1 || shardIndex > totalShards) {
    throw new Error('SHARD_INDEX must be between 1 and TOTAL_SHARDS.');
  }

  return { shardIndex, totalShards };
}

async function main() {
  const { shardIndex, totalShards } = getShardConfig();
  const stores = JSON.parse(await fs.readFile('stores.json', 'utf-8'));

  const shardStores = stores.filter(
    (_, index) => index % totalShards === shardIndex - 1
  );
  const summary = {
    shardIndex,
    totalShards,
    storesTotal: shardStores.length,
    storesOk: 0,
    storesBlocked: 0,
    storesError: 0,
    blockedReasons: {},
    timestamp: new Date().toISOString(),
  };

  console.log(
    `Running shard ${shardIndex}/${totalShards} with ${shardStores.length} stores.`
  );

  for (const store of shardStores) {
    try {
      console.log(`Scraping ${store.name} (${store.slug})...`);
      const result = await scrapeStore(store);
      if (result?.status === 'blocked') {
        summary.storesBlocked += 1;
        const reason = result.blockedReason || 'unknown';
        summary.blockedReasons[reason] =
          (summary.blockedReasons[reason] || 0) + 1;
      } else {
        summary.storesOk += 1;
      }
      console.log(`Finished ${store.slug}`);
    } catch (error) {
      console.error(`Error scraping ${store.slug}:`, error);
      summary.storesError += 1;
    } finally {
      const baseDir = path.join('data', 'rona', store.slug);
      const jsonPath = path.join(baseDir, 'data.json');
      const csvPath = path.join(baseDir, 'data.csv');
      try {
        const jsonStat = await fs.stat(jsonPath);
        console.log(`[rona] wrote ${jsonPath} (${jsonStat.size} bytes)`);
      } catch (statError) {
        // ignore missing json
      }
      try {
        const csvStat = await fs.stat(csvPath);
        console.log(`[rona] wrote ${csvPath} (${csvStat.size} bytes)`);
      } catch (statError) {
        // ignore missing csv
      }
    }
  }

  const summaryDir = path.join('data', 'rona', `shard-${shardIndex}`);
  await fs.mkdir(summaryDir, { recursive: true });
  const summaryPath = path.join(summaryDir, 'summary.json');
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log(
    `[rona] shard summary storesOk=${summary.storesOk} storesBlocked=${summary.storesBlocked} storesError=${summary.storesError}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
