/**
 * Fetches the latest Australian LNG export data from the ABS and updates
 * src/data/lng-config.json.
 *
 * Dataset: MERCH_EXP (ABS International Merchandise Exports)
 * Base URL: https://data.api.abs.gov.au/rest/data/
 * DSD key order: FREQ . COMMODITY_SITC . COUNTRY_DEST . STATE_ORIGIN
 * SITC 3431 (Rev 4) / 3413 (Rev 3) = Liquefied natural gas
 *
 * Runs via GitHub Actions quarterly — see .github/workflows/update-lng-data.yml
 */

import fs from 'fs'
import path from 'path'
import readline from 'readline'
import { fileURLToPath } from 'url'
import { Readable } from 'stream'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = path.resolve(__dirname, '../src/data/lng-config.json')

const FETCH_HEADERS = {
  Accept: '*/*',
  'User-Agent': 'tax-the-gas/1.0 (https://github.com/KieranJMcCluskey/tax-the-gas; automated data update)',
}

const LNG_SITC_CODES = ['3431', '3413']

// --- SDMX REST (primary) ---
// ABS DSD dimension order for MERCH_EXP: FREQ . COMMODITY_SITC . COUNTRY_DEST . STATE_ORIGIN

const ABS_BASE = 'https://data.api.abs.gov.au/rest/data'

const REST_CANDIDATES = [
  // FREQ first (standard ABS DSD ordering)
  'ABS,MERCH_EXP,1.0.0/M.3431.TOT.TOT',
  'ABS,MERCH_EXP,1.0.0/M.3413.TOT.TOT',
  'ABS,MERCH_EXP,1.0/M.3431.TOT.TOT',
  'ABS,MERCH_EXP,1.0/M.3413.TOT.TOT',
  // COMMODITY_SITC first (as per layout annotation)
  'ABS,MERCH_EXP,1.0.0/3431.TOT.TOT.M',
  'ABS,MERCH_EXP,1.0.0/3413.TOT.TOT.M',
  // Wildcard — fetch all series and filter client-side
  'ABS,MERCH_EXP,1.0.0/all',
]

async function fetchFromREST() {
  for (const candidate of REST_CANDIDATES) {
    const url = `${ABS_BASE}/${candidate}?startPeriod=2023&format=jsondata`
    try {
      const res = await fetch(url, { headers: FETCH_HEADERS })
      if (!res.ok) { console.warn(`  ✗ REST ${res.status}: ${url}`); continue }
      const data = await res.json()

      const seriesMap = data?.dataSets?.[0]?.series
      if (!seriesMap || Object.keys(seriesMap).length === 0) {
        console.warn(`  ✗ REST empty series: ${url}`)
        continue
      }

      // If we used the wildcard, find the LNG series by inspecting dimension values
      const dimensions = data?.structure?.dimensions?.series ?? []
      const sitcDimIdx = dimensions.findIndex(d =>
        d.id?.toUpperCase().includes('COMMODITY') || d.id?.toUpperCase().includes('SITC')
      )

      let targetKey = Object.keys(seriesMap)[0]
      if (sitcDimIdx >= 0 && candidate.includes('/all')) {
        const lngEntry = Object.entries(seriesMap).find(([key]) => {
          const parts = key.split(':')
          const sitcValIdx = parseInt(parts[sitcDimIdx] ?? '-1')
          const sitcValues = dimensions[sitcDimIdx]?.values ?? []
          const sitcCode = sitcValues[sitcValIdx]?.id ?? ''
          return LNG_SITC_CODES.includes(sitcCode)
        })
        if (!lngEntry) { console.warn(`  ✗ REST wildcard: no LNG series found`); continue }
        targetKey = lngEntry[0]
        console.log(`  ✓ REST wildcard matched series key: ${targetKey}`)
      }

      const obs = seriesMap[targetKey]?.observations
      if (!obs) { console.warn(`  ✗ REST no observations`); continue }

      const periods = Object.keys(obs).map(Number).sort((a, b) => a - b).slice(-12)
      const total = periods.reduce((sum, k) => sum + (obs[k][0] ?? 0), 0)
      console.log(`  ✓ REST: ${candidate} (${periods.length} months)`)
      return total
    } catch (err) {
      console.warn(`  ✗ REST error (${candidate}): ${err.message}`)
    }
  }
  throw new Error('All REST candidates failed')
}

// --- CSV streaming fallback (file is ~4.5 GB, must stream line by line) ---

const CSV_URL = 'https://data.api.abs.gov.au/files/ABS_MERCH_EXP_1.0.0.csv'

async function fetchFromCSV() {
  console.log(`  Streaming CSV: ${CSV_URL}`)
  const res = await fetch(CSV_URL, { headers: FETCH_HEADERS })
  if (!res.ok) throw new Error(`CSV download ${res.status}: ${CSV_URL}`)

  const rl = readline.createInterface({ input: Readable.fromWeb(res.body), crlfDelay: Infinity })

  let headers = null
  let sitcIdx, countryIdx, stateIdx, freqIdx, periodIdx, valueIdx
  const lngObs = {}
  let rowCount = 0
  const sampleSitc = new Set(), sampleCountry = new Set(), sampleFreq = new Set()

  for await (const line of rl) {
    if (!line.trim()) continue
    const cols = line.split(',').map(c => c.replace(/^"|"$/g, '').trim())

    if (!headers) {
      headers = cols.map(h => h.toUpperCase())
      sitcIdx    = headers.findIndex(h => h.includes('COMMODITY_SITC') || h === 'SITC')
      countryIdx = headers.findIndex(h => h.includes('COUNTRY_DEST') || h === 'COUNTRY')
      stateIdx   = headers.findIndex(h => h.includes('STATE_ORIGIN') || h === 'STATE')
      freqIdx    = headers.findIndex(h => h === 'FREQ' || h === 'FREQUENCY')
      periodIdx  = headers.findIndex(h => h.includes('TIME_PERIOD') || h === 'PERIOD')
      valueIdx   = headers.findIndex(h => h.includes('OBS_VALUE') || h === 'VALUE')
      console.log(`  CSV columns: ${cols.join(', ')}`)
      if (sitcIdx < 0 || periodIdx < 0 || valueIdx < 0) {
        throw new Error(`Missing required CSV columns. Headers: ${cols.join(', ')}`)
      }
      continue
    }

    rowCount++
    const sitc    = cols[sitcIdx]
    const country = countryIdx >= 0 ? cols[countryIdx] : ''
    const state   = stateIdx   >= 0 ? cols[stateIdx]   : ''
    const freq    = freqIdx    >= 0 ? cols[freqIdx]    : ''

    // Collect sample values from the first 500 rows to diagnose code formats
    if (rowCount <= 500) {
      sampleSitc.add(sitc)
      sampleCountry.add(country)
      sampleFreq.add(freq)
    }
    if (rowCount === 500) {
      console.log(`  Sample COMMODITY_SITC values: ${[...sampleSitc].slice(0, 15).join(', ')}`)
      console.log(`  Sample COUNTRY_DEST values:   ${[...sampleCountry].slice(0, 10).join(', ')}`)
      console.log(`  Sample FREQ values:           ${[...sampleFreq].join(', ')}`)
    }

    if (!LNG_SITC_CODES.includes(sitc)) continue
    if (country && country !== 'TOT') continue
    if (state   && state   !== 'TOT') continue
    if (freq    && freq    !== 'M')   continue

    const period = cols[periodIdx]
    const value  = parseFloat(cols[valueIdx])
    if (period && !isNaN(value)) lngObs[period] = value
  }

  console.log(`  Scanned ${rowCount.toLocaleString()} rows, found ${Object.keys(lngObs).length} LNG months`)
  if (Object.keys(lngObs).length === 0) throw new Error('No LNG observations found in CSV')

  const latest12 = Object.entries(lngObs)
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, 12)

  console.log(`  Period range: ${latest12[latest12.length-1][0]} – ${latest12[0][0]}`)
  return latest12.reduce((sum, [, v]) => sum + v, 0)
}

// --- main ---

async function main() {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))

  let annualValueAUD
  try {
    console.log('Fetching ABS LNG export data...')
    try {
      annualValueAUD = await fetchFromREST()
      console.log('  ✓ Source: SDMX REST API')
    } catch (restErr) {
      console.warn(`  REST failed: ${restErr.message}`)
      console.log('  Trying CSV streaming fallback...')
      annualValueAUD = await fetchFromCSV()
      console.log('  ✓ Source: ABS bulk CSV')
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
