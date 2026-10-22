/** Google Play top charts, using @mradex77/google-play-scraper (Node >=22.12). */
import { readFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, category as categories, collection } from '@mradex77/google-play-scraper';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(readFileSync(resolve(ROOT, 'config/sources.json'), 'utf8'));
const args = process.argv.slice(2);
const getArg = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const mode = getArg('--mode', 'smoke');
const countryArg = getArg('--country', 'all');
const maxGroupsArg = getArg('--max-groups', '');
const maxGroups = maxGroupsArg === '' ? Infinity : Number(maxGroupsArg);
if (!['smoke', 'full'].includes(mode) || !['US', 'JP', 'KR', 'all'].includes(countryArg) || !Number.isFinite(maxGroups) && maxGroups !== Infinity) {
  console.error('Invalid mode, country, or max-groups'); process.exit(2);
}
const countries = countryArg === 'all' ? Object.keys(cfg.countries) : [countryArg];
const now = () => new Date().toISOString();
const client = createClient({ lang: 'en', country: 'us', throttle: 1 });

function normalize(value, pos, kind, country) {
  const id = String(value?.appId ?? '').trim();
  return { position: pos, app_key: id ? `google:${id}` : '', source_id: id,
    kind, name: value?.title ?? '', developer: value?.developer ?? '',
    primary_category: value?.genre ?? value?.genreId ?? '',
    icon_url: value?.icon ?? '', detail_url: id ? `https://play.google.com/store/apps/details?id=${encodeURIComponent(id)}&hl=${cfg.countries[country]}&gl=${country}` : '',
    release_date: '', rating: value?.score ?? null, rating_count: value?.ratings ?? null,
  };
}
function validated(items, limit) {
  const seen = new Set();
  return items.slice(0, limit).filter((v) => {
    if (!v.app_key || !v.detail_url.startsWith('https://') || seen.has(v.app_key)) return false;
    seen.add(v.app_key); return true;
  });
}
function makeGroup(country, row, status, items=[], message='') {
  return { source: 'google', country, chart: row.chart, category: row.category,
    feed: null, status, attempted_at: now(), item_count: items.length, items, message: String(message).slice(0, 300) };
}
async function run() {
  const groups = [];
  outer: for (const country of countries) {
    const charts = mode === 'full' ? cfg.charts : cfg.charts.filter(row =>
      ['all_apps:top_free', 'all_apps:top_paid', 'game_puzzle:top_free'].includes(`${row.category}:${row.chart}`));
    for (const row of charts) {
      if (groups.length >= maxGroups) break outer;
      const cat = categories[row.google_category];
      if (!cat) {
        groups.push(makeGroup(country, row, 'skipped', [], `GOOGLE_CATEGORY_NOT_MAPPED:${row.google_category}`));
        continue;
      }
      try {
        const limit = mode === 'smoke' ? 5 : row.limit;
        const collected = await client.list({ collection: row.chart === 'top_paid' ? collection.TOP_PAID : collection.TOP_FREE,
          category: cat, num: limit, country: country.toLowerCase(), lang: cfg.countries[country], fullDetail: false });
        if (!Array.isArray(collected) || collected.length === 0) throw new Error('EMPTY_OR_INVALID_CHART');
        const items = validated(collected.map((item, idx) => normalize(item, idx + 1, row.kind, country)), limit);
        if (!items.length) throw new Error('NO_VALID_APP_IDS');
        const bad = Math.min(limit, collected.length) - items.length;
        const entry = makeGroup(country, row, bad ? 'partial' : 'success', items, bad ? `INVALID_ITEMS:${bad}` : '');
        if (mode === 'smoke' && row.category === 'all_apps' && row.chart === 'top_free') {
          try {
            const detail = await client.app({ appId: items[0].source_id, country: country.toLowerCase(), lang: cfg.countries[country] });
            entry.detail_probe = { status: 'success', result: { name: detail.title ?? '',
              description: detail.description ?? '', rating: detail.score ?? null,
              rating_count: detail.ratings ?? null, installs_range: detail.installs ?? '',
              ad_supported: detail.adSupported ?? null, in_app_purchases: detail.offersIAP ?? null,
              primary_category: detail.genre ?? '' } };
          } catch (detailErr) {
            entry.detail_probe = { status: 'failed', message: String(detailErr?.message ?? detailErr).slice(0, 220) };
          }
        }
        groups.push(entry);
      } catch (err) {
        groups.push(makeGroup(country, row, 'failed', [], `${err?.name ?? 'Error'}: ${err?.message ?? err}`));
      }
      await new Promise(r => setTimeout(r, 700));
    }
  }
  const data = { schema_version: 1, source: 'google', mode, generated_at: now(), groups };
  const outPath = resolve(ROOT, 'data/staging/google.json');
  mkdirSync(dirname(outPath), { recursive: true });
  const tmp = `${outPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  renameSync(tmp, outPath);
  console.log(`[google] groups=${groups.length} success=${groups.filter(g=>g.status==='success').length} partial=${groups.filter(g=>g.status==='partial').length} failed=${groups.filter(g=>g.status==='failed').length} skipped=${groups.filter(g=>g.status==='skipped').length} -> ${outPath}`);
  for (const g of groups) console.log(`  ${g.country} ${g.chart.padEnd(8)} ${g.category.padEnd(20)} ${g.status.padEnd(8)} ${g.item_count} ${g.message}`);
  return groups.some(g => ['success', 'partial'].includes(g.status)) ? 0 : 2;
}
process.exitCode = await run();
