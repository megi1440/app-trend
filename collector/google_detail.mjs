/** Fetch exactly one public Google Play app detail. No authentication required. */
import { createClient } from '@mradex77/google-play-scraper';

const [appId, country, lang] = process.argv.slice(2);
if (!appId || !/^[A-Za-z0-9_.]+$/.test(appId) || !['US', 'JP', 'KR'].includes(country)) {
  console.error('INVALID_APP_DETAIL_ARGUMENTS');
  process.exit(2);
}
const locale = { US: 'en', JP: 'ja', KR: 'ko' }[country];
const client = createClient({ lang: locale, country: country.toLowerCase(), throttle: 1 });
try {
  const result = await client.app({ appId, country: country.toLowerCase(), lang: lang || locale });
  console.log(JSON.stringify({
    source_id: appId,
    name: String(result?.title ?? ''),
    description: String(result?.description ?? ''),
    developer: String(result?.developer ?? ''),
    primary_category: String(result?.genre ?? ''),
  }));
} catch (error) {
  console.error('GOOGLE_DETAIL_FAILED:', String(error?.message ?? error).slice(0, 180));
  process.exitCode = 2;
}
