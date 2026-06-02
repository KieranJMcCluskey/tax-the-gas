/**
 * Fetches the latest Australian LNG export data from the ABS and updates
 * src/data/lng-config.json.
 *
 * Primary:  ABS bulk CSV download for MERCH_EXP (International Merchandise Exports)
 *           https://data.api.abs.gov.au/files/ABS_MERCH_EXP_1.0.0.csv
 * Fallback: ABS SDMX REST API (data.api.abs.gov.au/rest)
 *
 * SITC commodity 3431 (Rev 4) / 3413 (Rev 3) = Liquefied natural gas
 *
 * Runs via GitHub Actions quarterly — see .github/workflows/update-lng-data.yml
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = path.resolve(__dirname, '../src/data/lng-config.json')

const FETCH_HEADERS = {
  Accept: '*/*',
  'User-Agent': 'tax-the-gas/1.0 (https://github.com/KieranJMcCluskey/tax-the-gas; automated data update)',
}

// LNG SITC codes — 3431 is the primary Rev 4 code, 3413 is the Rev 3 fallback
const LNG_SITC_CODES = ['3431', '3413']

// --- CSV approach (primary) ---

const CSV_URL = 'https://data.api.abs.gov.au/files/ABS_MERCH_EXP_1.0.0.csv'

function parseCSV(text) {
  const lines = text.trim().split('\n')
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''))
  return lines.slice(1).map(line => {
    // Handle quoted fields containing commas
    const values = []
    let current = ''
    let inQuote = false
    for (const ch of line) {
      if (ch === '"') { inQuote = !inQuote }
      else if (ch === ',' && !inQuote) { values.push(current.trim()); current = '' }
      else { current += ch }
    }
    values.push(current.trim())
    return Object.fromEntries(headers.map((h, i) => [h, values[i] ?? '']))
  })
}

async function fetchFromCSV() {
  console.log(`  Downloading CSV: ${CSV_URL}`)
  const res = await fetch(CSV_URL, { headers: FETCH_HEADERS })
  if (!res.ok) throw new Error(`CSV download ${res.status}: ${CSV_URL}`)
  const text = await res.text()
  console.log(`  CSV downloaded (${(text.length / 1024).toFixed(0)} KB)`)

  const rows = parseCSV(text)
  if (rows.length === 0) throw new Error('CSV is empty')

  // Log column names to help diagnose if the format ever changes
  const cols = Object.keys(rows[0])
  console.log(`  CSV columns: ${cols.join(', ')}`)

  // Find the column names (case-insensitive) we care about
  const col = name => cols.find(c => c.toUpperCase() === name.toUpperCase())
  const sitcCol   = col('COMMODITY_SITC') ?? col('SITC') ?? col('COMMODITY')
  const countryCol = col('COUNTRY_DEST') ?? col('COUNTRY')
  const stateCol   = col('STATE_ORIGIN') ?? col('STATE')
  const freqCol    = col('FREQ') ?? col('FREQUENCY')
  const periodCol  = col('TIME_PERIOD') ?? col('PERIOD') ?? col('DATE')
  const valueCol   = col('OBS_VALUE') ?? col('VALUE') ?? col('OBSERVATION_VALUE')

  if (!sitcCol || !periodCol || !valueCol) {
    throw new Error(`Could not identify required CSV columns. Found: ${cols.join(', ')}`)
  }

  // Filter to LNG rows: matching SITC code, total country/state, monthly
  const lngRows = rows.filter(r => {
    const sitc = r[sitcCol]?.trim()
    if (!LNG_SITC_CODES.includes(sitc)) return false
    if (countryCol && r[countryCol]?.trim() !== 'TOT') return false
    if (stateCol   && r[stateCol]?.trim()   !== 'TOT') return false
    if (freqCol    && r[freqCol]?.trim()    !== 'M')   return false
    return true
  })

  if (lngRows.length === 0) {
    // Log a few sample SITC values to diagnose
    const sampleSitc = [...new Set(rows.slice(0, 200).map(r => r[sitcCol]))].slice(0, 10)
    throw new Error(`No LNG rows found (SITC ${LNG_SITC_CODES.join('/')}). Sample SITC values: ${sampleSitc.join(', ')}`)
  }

  console.log(`  Found ${lngRows.length} LNG rows (SITC ${lngRows[0][sitcCol]})`)

  // Sort by period descending, take the latest 12 months
  const sorted = lngRows
    .map(r => ({ period: r[periodCol]?.trim(), value: parseFloat(r[valueCol]) || 0 }))
    .filter(r => r.period && !isNaN(r.value))
    .sort((a, b) => b.period.localeCompare(a.period))
    .slice(0, 12)

  if (sorted.length === 0) throw new Error('No valid observations in LNG CSV rows')

  const total = sorted.reduce((sum, r) => sum + r.value, 0)
  console.log(`  Latest period: ${sorted[0].period}, earliest of 12: ${sorted[sorted.length - 1].period}`)
  return total
}

// --- SDMX REST fallback ---

const ABS_REST_BASE = 'https://data.api.abs.gov.au/rest'

const REST_CANDIDATES = [
  ['ABS,MERCH_EXP,1.0.0', '3431'],
  ['ABS,MERCH_EXP,1.0.0', '3413'],
  ['ABS,MERCH_EXP,1.0', '3431'],
  ['ABS,MERCH_EXP,1.0', '3413'],
  ['ABS,MERCH_EXP', '3431'],
  ['ABS,MERCH_EXP', '3413'],
]

async function fetchFromREST() {
  for (const [dataflow, sitcCode] of REST_CANDIDATES) {
    const url = `${ABS_REST_BASE}/data/${dataflow}/${sitcCode}.TOT.TOT.M?startPeriod=2023&format=jsondata`
    try {
      const res = await fetch(url, { headers: FETCH_HEADERS })
      if (!res.ok) { console.warn(`  ✗ REST ${res.status}: ${url}`); continue }
      const data = await res.json()
      console.log(`  ✓ REST value fetched (${dataflow}, SITC ${sitcCode})`)

      const seriesMap = data?.dataSets?.[0]?.series
      if (!seriesMap) throw new Error('Unexpected REST response shape')
      const seriesKey = Object.keys(seriesMap)[0]
      const obs = seriesMap[seriesKey]?.observations
      if (!obs) throw new Error('No observations in REST response')

      const periods = Object.keys(obs).map(Number).sort((a, b) => a - b).slice(-12)
      return periods.reduce((sum, k) => sum + (obs[k][0] ?? 0), 0)
    } catch (err) {
      console.warn(`  ✗ REST error (${dataflow}, SITC ${sitcCode}): ${err.message}`)
    }
  }
  throw new Error('All REST candidates failed')
}

// --- main ---

async function main() {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))

  let annualValueAUD
  try {
    console.log('Fetching ABS LNG export data...')
    try {
      annualValueAUD = await fetchFromCSV()
      console.log('  ✓ Used CSV download')
    } catch (csvErr) {
      console.warn(`  CSV failed: ${csvErr.message}`)
      console.log('  Trying SDMX REST fallback...')
      annualValueAUD = await fetchFromREST()
      console.log('  ✓ Used REST API')
    }

    if (annualValueAUD <= 0) {
      throw new Error('ABS returned zero or negative value — data may not be published yet')
    }

    const today = new Date().toISOString().split('T')[0]
    config.annualExportValueAUD = Math.round(annualValueAUD)
    config.lastUpdated = today
    config.dataSource = `ABS International Merchandise Exports (auto-updated ${today})`

    console.log(`✓ Annual LNG export value: AUD $${(annualValueAUD / 1e9).toFixed(1)}B`)
  } catch (err) {
    console.error('ABS fetch failed:', err.message)
    console.log('Falling back to existing config — no changes written')
    process.exit(1)
  }

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n')
  console.log('✓ lng-config.json updated')
}

main()
