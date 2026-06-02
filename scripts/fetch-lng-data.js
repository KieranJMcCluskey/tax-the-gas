/**
 * Fetches the latest Australian LNG export data from the ABS API
 * and updates src/data/lng-config.json.
 *
 * ABS dataset: International Trade in Goods (MERCH_EXP)
 * SITC commodity 3413 (Rev 3) / 3431 (Rev 4) = Liquefied natural gas
 *
 * Runs via GitHub Actions quarterly — see .github/workflows/update-lng-data.yml
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = path.resolve(__dirname, '../src/data/lng-config.json')

// ABS Data Explorer API (data.api.abs.gov.au/rest)
// Dataflow: MERCH_EXP (agencyID=ABS, version=1.0.0)
// Dimensions: COMMODITY_SITC . COUNTRY_DEST . STATE_ORIGIN . FREQ
// SITC codes for LNG: 3431 (primary) or 3413 (fallback)
// Dataset reports AUD value only (no separate volume series)
// Frequency is monthly (M), not quarterly
const ABS_REST_BASE = 'https://data.api.abs.gov.au/rest'
const COMMON_PARAMS = 'startPeriod=2023&format=jsondata'

// Candidates: (dataflow, sitcCode) — tried in order until one works
// Version in the REST API uses "1.0" format (not "1.0.0" as in the XML catalog)
const CANDIDATES = [
  ['ABS,MERCH_EXP,1.0', '3431'],
  ['ABS,MERCH_EXP,1.0', '3413'],
  ['ABS,MERCH_EXP,1.0.0', '3431'],
  ['ABS,MERCH_EXP,1.0.0', '3413'],
  ['ABS,MERCH_EXP', '3431'],
  ['ABS,MERCH_EXP', '3413'],
  ['MERCH_EXP', '3431'],
  ['MERCH_EXP', '3413'],
]

function buildUrl(dataflow, sitcCode) {
  // Key: COMMODITY_SITC.COUNTRY_DEST.STATE_ORIGIN.FREQ
  return `${ABS_REST_BASE}/data/${dataflow}/${sitcCode}.TOT.TOT.M?${COMMON_PARAMS}`
}

const FETCH_HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'tax-the-gas/1.0 (https://github.com/KieranJMcCluskey/tax-the-gas; automated data update)',
}

async function fetchJSON(url) {
  const res = await fetch(url, { headers: FETCH_HEADERS })
  if (!res.ok) throw new Error(`ABS API ${res.status}: ${url}`)
  return res.json()
}

async function fetchValue() {
  for (const [dataflow, sitcCode] of CANDIDATES) {
    const url = buildUrl(dataflow, sitcCode)
    try {
      const data = await fetchJSON(url)
      console.log(`  ✓ value fetched (${dataflow}, SITC ${sitcCode})`)
      return data
    } catch (err) {
      console.warn(`  ✗ ${err.message}`)
    }
  }

  // All candidates failed — run discovery to help diagnose
  await discoverDataflows()
  throw new Error('All ABS URL candidates failed — see discovery output above')
}

async function discoverDataflows() {
  console.log('\n--- ABS dataflow discovery ---')
  try {
    const res = await fetch(`${ABS_REST_BASE}/dataflow/ABS?format=jsondata`, {
      headers: FETCH_HEADERS,
    })
    if (!res.ok) { console.warn(`  discovery ${res.status}`); return }
    const json = await res.json()

    // Search for any MERCH_EXP dataflow in the references map
    const refs = json.references ?? {}
    const matches = Object.values(refs).filter(df => df.id?.includes('MERCH'))
    if (matches.length > 0) {
      console.log('  MERCH-related dataflows found:')
      for (const df of matches) {
        console.log(`    id=${df.id} version=${df.version} agencyID=${df.agencyID}`)
      }
    } else {
      console.log('  No MERCH dataflows found in ABS catalog')
      // Log a sample of what IS available
      const sample = Object.values(refs).slice(0, 5).map(df => `${df.agencyID},${df.id},${df.version}`)
      console.log('  Sample dataflows:', sample.join(' | '))
    }
  } catch (err) {
    console.warn(`  discovery error: ${err.message}`)
  }
  console.log('--- end discovery ---\n')
}

function sumLatestTwelveMonths(data) {
  const seriesMap = data?.dataSets?.[0]?.series
  if (!seriesMap) throw new Error('Unexpected ABS response shape — missing dataSets[0].series')

  const seriesKey = Object.keys(seriesMap)[0]
  const obs = seriesMap[seriesKey]?.observations
  if (!obs) throw new Error(`No observations under series key "${seriesKey}"`)

  const periods = Object.keys(obs)
    .map(Number)
    .sort((a, b) => a - b)
    .slice(-12)

  if (periods.length === 0) throw new Error('ABS returned no observation periods')
  return periods.reduce((sum, k) => sum + (obs[k][0] ?? 0), 0)
}

async function main() {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))

  try {
    console.log('Fetching ABS LNG export data...')
    const valueData = await fetchValue()

    // MERCH_EXP reports in AUD (not millions) — monthly data, sum 12 months for annual
    const annualValueAUD = sumLatestTwelveMonths(valueData)

    if (annualValueAUD <= 0) {
      throw new Error('ABS returned zero values — data may not be published yet')
    }

    const today = new Date().toISOString().split('T')[0]
    config.annualExportValueAUD = Math.round(annualValueAUD)
    config.lastUpdated = today
    config.dataSource = `ABS International Merchandise Exports (auto-updated ${today})`

    console.log(`✓ Value: AUD $${(annualValueAUD / 1e9).toFixed(1)}B`)
  } catch (err) {
    console.error('ABS fetch failed:', err.message)
    console.log('Falling back to existing config — no changes written')
    process.exit(1)
  }

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n')
  console.log('✓ lng-config.json updated')
}

main()
