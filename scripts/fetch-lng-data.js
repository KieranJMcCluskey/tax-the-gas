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

// ABS Data Explorer API
// URL changed Nov 2024: api.data.abs.gov.au/data → data.api.abs.gov.au/rest/data
// Dataflow ID format changed: ABS,MERCH_EXP → possibly ABS_MERCH_EXP or renamed entirely
const ABS_REST_BASE = 'https://data.api.abs.gov.au/rest'
const COMMON_PARAMS = 'startPeriod=2023&format=jsondata'

// Candidates: (dataflow, sitcRevision, commodityCode) — tried in order until one works
const CANDIDATES = [
  // New-style dataflow IDs (Nov 2024 API) — underscore replaces comma between agency+flow
  ['ABS_MERCH_EXP', 'M4', '3431'], // SITC Rev 4 (used by ABS from July 2005)
  ['ABS_MERCH_EXP', 'M3', '3413'], // SITC Rev 3 fallback
  ['ABS_MERCH_EXP,1.0.0', 'M4', '3431'],
  ['ABS_MERCH_EXP,1.0.0', 'M3', '3413'],
  // Old-style dataflow IDs (pre-Nov 2024 API)
  ['ABS,MERCH_EXP', 'M4', '3431'],
  ['ABS,MERCH_EXP', 'M3', '3413'],
  ['ABS,MERCH_EXP,1.0.0', 'M4', '3431'],
  ['ABS,MERCH_EXP,1.0.0', 'M3', '3413'],
]

function buildUrl(dataflow, sitcRev, commodity, measure) {
  return `${ABS_REST_BASE}/data/${dataflow}/${sitcRev}.${commodity}.${measure}.AUS.Q?${COMMON_PARAMS}`
}

async function fetchJSON(url) {
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.sdmx.data+json;version=1.0' },
  })
  if (!res.ok) throw new Error(`ABS API ${res.status}: ${url}`)
  return res.json()
}

async function fetchPair() {
  for (const [dataflow, sitcRev, commodity] of CANDIDATES) {
    const valueUrl = buildUrl(dataflow, sitcRev, commodity, '1')
    try {
      const valueData = await fetchJSON(valueUrl)
      console.log(`  ✓ value fetched (${dataflow}, ${sitcRev}.${commodity})`)
      const volumeUrl = buildUrl(dataflow, sitcRev, commodity, '2')
      const volumeData = await fetchJSON(volumeUrl)
      console.log(`  ✓ volume fetched`)
      return { valueData, volumeData }
    } catch (err) {
      console.warn(`  ✗ ${err.message}`)
    }
  }

  // All candidates failed — run discovery to help diagnose
  await discoverDataflows()
  throw new Error('All ABS URL candidates failed — see discovery output above')
}

async function discoverDataflows() {
  console.log('\n--- ABS dataflow discovery (to identify correct ID) ---')
  const discoveryUrls = [
    `${ABS_REST_BASE}/dataflow/ABS?format=jsondata`,
    `${ABS_REST_BASE}/dataflow?format=jsondata`,
  ]
  for (const url of discoveryUrls) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } })
      if (!res.ok) { console.warn(`  discovery ${res.status}: ${url}`); continue }
      const data = await res.json()
      const flows = data?.Structures?.Dataflows ?? data?.data?.dataflows ?? []
      const tradeFlows = flows.filter(f => {
        const id = (f.id || f.agencyID || '').toLowerCase()
        const name = JSON.stringify(f.names || f.name || '').toLowerCase()
        return id.includes('merch') || id.includes('trade') || id.includes('export') ||
               name.includes('merch') || name.includes('trade') || name.includes('export')
      })
      console.log(`  Found ${tradeFlows.length} trade-related dataflows from ${url}:`)
      tradeFlows.forEach(f => console.log(`    ${f.id || JSON.stringify(f)}`))
      return
    } catch (err) {
      console.warn(`  discovery error: ${err.message}`)
    }
  }
  console.log('  Discovery failed — please check https://data.api.abs.gov.au/rest/dataflow/ABS manually')
  console.log('--- end discovery ---\n')
}

function sumLatestFourQuarters(data) {
  const seriesMap = data?.dataSets?.[0]?.series
  if (!seriesMap) throw new Error('Unexpected ABS response shape — missing dataSets[0].series')

  const seriesKey = Object.keys(seriesMap)[0]
  const obs = seriesMap[seriesKey]?.observations
  if (!obs) throw new Error(`No observations under series key "${seriesKey}"`)

  const periods = Object.keys(obs)
    .map(Number)
    .sort((a, b) => a - b)
    .slice(-4)

  if (periods.length === 0) throw new Error('ABS returned no observation periods')
  return periods.reduce((sum, k) => sum + (obs[k][0] ?? 0), 0)
}

async function main() {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))

  try {
    console.log('Fetching ABS LNG export data...')
    const { valueData, volumeData } = await fetchPair()

    const annualValueAUD = sumLatestFourQuarters(valueData) * 1_000_000 // ABS reports in $M
    const annualVolumeTonnes = sumLatestFourQuarters(volumeData) * 1_000 // ABS reports in '000 tonnes

    if (annualValueAUD <= 0 || annualVolumeTonnes <= 0) {
      throw new Error('ABS returned zero values — data may not be published yet')
    }

    const today = new Date().toISOString().split('T')[0]
    config.annualExportValueAUD = Math.round(annualValueAUD)
    config.annualExportVolumeTonnes = Math.round(annualVolumeTonnes)
    config.lastUpdated = today
    config.dataSource = `ABS International Merchandise Exports (auto-updated ${today})`

    console.log(`✓ Value: AUD $${(annualValueAUD / 1e9).toFixed(1)}B`)
    console.log(`✓ Volume: ${(annualVolumeTonnes / 1e6).toFixed(1)}M tonnes`)
  } catch (err) {
    console.error('ABS fetch failed:', err.message)
    console.log('Falling back to existing config — no changes written')
    process.exit(1)
  }

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n')
  console.log('✓ lng-config.json updated')
}

main()
