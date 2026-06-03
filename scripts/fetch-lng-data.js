/**
 * Fetches the latest Australian LNG export data and updates src/data/lng-config.json.
 *
 * Primary:  DISR Resources and Energy Quarterly historical data Excel
 *           URL pattern: https://www.industry.gov.au/sites/default/files/YYYY-MM/
 *                        resources-and-energy-quarterly-MONTH-YYYY-historical-data.xlsx
 * Fallback: ABS MERCH_EXP bulk CSV (streaming, ~4.5 GB)
 *
 * Runs via GitHub Actions quarterly — see .github/workflows/update-lng-data.yml
 */

import fs from 'fs'
import path from 'path'
import readline from 'readline'
import { fileURLToPath } from 'url'
import { Readable } from 'stream'
import * as XLSX from 'xlsx'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = path.resolve(__dirname, '../src/data/lng-config.json')

const FETCH_HEADERS = {
  Accept: '*/*',
  'User-Agent': 'tax-the-gas/1.0 (https://github.com/KieranJMcCluskey/tax-the-gas; automated data update)',
}

// --- DISR Resources and Energy Quarterly (primary) ---

const QUARTER_MONTHS = [
  { month: 3,  name: 'march' },
  { month: 6,  name: 'june' },
  { month: 9,  name: 'september' },
  { month: 12, name: 'december' },
]

function recentDISRUrls() {
  // Build candidate URLs for the last 3 quarterly releases
  const now = new Date()
  const urls = []
  let year = now.getFullYear()
  let qi = QUARTER_MONTHS.findIndex(q => now.getMonth() + 1 <= q.month)
  if (qi < 0) qi = 3 // past December, start from December this year

  for (let i = 0; i < 3; i++) {
    qi--
    if (qi < 0) { qi = 3; year-- }
    const { month, name } = QUARTER_MONTHS[qi]
    const mm = String(month).padStart(2, '0')
    const base = `https://www.industry.gov.au/sites/default/files/${year}-${mm}`
    urls.push(`${base}/resources-and-energy-quarterly-${name}-${year}-historical-data.xlsx`)
  }
  return urls
}

async function fetchFromDISR() {
  const urls = recentDISRUrls()
  for (const url of urls) {
    console.log(`  Trying DISR: ${url}`)
    try {
      const res = await fetch(url, { headers: FETCH_HEADERS })
      if (!res.ok) { console.warn(`  ✗ DISR ${res.status}: ${url}`); continue }

      const buffer = Buffer.from(await res.arrayBuffer())
      const wb = XLSX.read(buffer, { type: 'buffer' })

      console.log(`  ✓ Downloaded. Sheets: ${wb.SheetNames.join(', ')}`)

      // Find the LNG sheet
      const lngSheet = wb.SheetNames.find(n =>
        /lng/i.test(n) || /liquefied/i.test(n)
      )
      if (!lngSheet) {
        console.warn(`  ✗ No LNG sheet found. Sheets: ${wb.SheetNames.join(', ')}`)
        continue
      }
      console.log(`  Using sheet: "${lngSheet}"`)

      const ws = wb.Sheets[lngSheet]
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null })

      // Log first 10 rows to diagnose structure on first run
      console.log('  Sheet preview (first 10 rows):')
      rows.slice(0, 10).forEach((r, i) => console.log(`    [${i}] ${JSON.stringify(r)}`))

      const result = extractLNGValue(rows)
      if (result) return result

      console.warn('  ✗ Could not extract LNG value from sheet')
    } catch (err) {
      console.warn(`  ✗ DISR error: ${err.message}`)
    }
  }
  throw new Error('All DISR URL candidates failed')
}

function extractLNGValue(rows) {
  // Look for an "Export value" or "Export earnings" row with AUD data
  // DISR REQ sheets typically have:
  //   - A header section with labels in column A
  //   - Years or quarters in row headers
  //   - Values in AUD billion or AUD million

  // Find the row index containing "export value" or "export earnings"
  const exportValueRowIdx = rows.findIndex(r =>
    r.some(cell => typeof cell === 'string' &&
      /(export.*(value|earning|revenue)|value.*export)/i.test(cell))
  )

  if (exportValueRowIdx < 0) {
    // Log all row labels to help diagnose
    const labels = rows.map((r, i) => `[${i}] ${r[0]}`).filter(l => l[l.length-1])
    console.warn(`  Could not find export value row. Row labels: ${labels.slice(0, 30).join(' | ')}`)
    return null
  }

  const exportRow = rows[exportValueRowIdx]
  console.log(`  Export value row [${exportValueRowIdx}]: ${JSON.stringify(exportRow)}`)

  // Find the header row (contains years like 2023, 2024, 2025)
  const headerRowIdx = rows.slice(0, exportValueRowIdx).findLastIndex(r =>
    r.filter(c => typeof c === 'number' && c > 2000 && c < 2040).length >= 3
  )

  let unit = 'billion' // default assumption
  // Look for unit indicator near the export value row
  for (let i = Math.max(0, exportValueRowIdx - 5); i <= exportValueRowIdx; i++) {
    const rowStr = JSON.stringify(rows[i]).toLowerCase()
    if (rowStr.includes('million')) unit = 'million'
    if (rowStr.includes('billion')) unit = 'billion'
  }
  console.log(`  Detected unit: AUD ${unit}`)

  if (headerRowIdx >= 0) {
    const headerRow = rows[headerRowIdx]
    console.log(`  Header row [${headerRowIdx}]: ${JSON.stringify(headerRow)}`)

    // Find the most recent year column
    let bestColIdx = -1
    let bestYear = 0
    headerRow.forEach((cell, i) => {
      const yr = typeof cell === 'number' ? cell : parseInt(cell)
      if (yr > 2020 && yr < 2040 && yr > bestYear) {
        bestYear = yr
        bestColIdx = i
      }
    })

    if (bestColIdx >= 0) {
      const value = parseFloat(exportRow[bestColIdx])
      if (!isNaN(value) && value > 0) {
        console.log(`  ✓ Export value for ${bestYear}: AUD ${value} ${unit}`)
        const multiplier = unit === 'billion' ? 1e9 : 1e6
        return Math.round(value * multiplier)
      }
    }
  }

  // Fallback: take the last non-null numeric value in the export row
  const numericValues = exportRow
    .map((v, i) => ({ v: parseFloat(v), i }))
    .filter(({ v }) => !isNaN(v) && v > 0)
  if (numericValues.length > 0) {
    const last = numericValues[numericValues.length - 1]
    console.log(`  Fallback: last numeric value in export row: ${last.v} (col ${last.i})`)
    const multiplier = unit === 'billion' ? 1e9 : 1e6
    return Math.round(last.v * multiplier)
  }

  return null
}

// --- ABS REST API (secondary) ---
// Short-form URL pattern confirmed from ABS worked examples (no agency prefix needed)
// Dimension order for MERCH_EXP from CSV column order: COMMODITY_SITC.COUNTRY_DEST.STATE_ORIGIN.FREQ

const ABS_REST_BASE = 'https://data.api.abs.gov.au/rest/data'
const ABS_REST_CANDIDATES = [
  'MERCH_EXP/343.TOT.TOT.M',
  'MERCH_EXP/M.343.TOT.TOT',
  'ABS,MERCH_EXP/343.TOT.TOT.M',
  'ABS,MERCH_EXP,1.0.0/343.TOT.TOT.M',
  'ABS,MERCH_EXP/M.343.TOT.TOT',
]

async function fetchFromABSREST() {
  for (const candidate of ABS_REST_CANDIDATES) {
    const url = `${ABS_REST_BASE}/${candidate}?startPeriod=2023&format=jsondata`
    try {
      const res = await fetch(url, { headers: FETCH_HEADERS })
      if (!res.ok) { console.warn(`  ✗ REST ${res.status}: ${url}`); continue }
      const data = await res.json()
      const seriesMap = data?.dataSets?.[0]?.series
      if (!seriesMap || Object.keys(seriesMap).length === 0) {
        console.warn(`  ✗ REST empty response: ${url}`); continue
      }
      const obs = seriesMap[Object.keys(seriesMap)[0]]?.observations
      if (!obs) { console.warn(`  ✗ REST no observations: ${url}`); continue }
      const periods = Object.keys(obs).map(Number).sort((a, b) => a - b).slice(-12)
      const total = periods.reduce((sum, k) => sum + (obs[k][0] ?? 0), 0)
      console.log(`  ✓ REST: ${candidate} (${periods.length} months)`)
      return total
    } catch (err) {
      console.warn(`  ✗ REST error (${candidate}): ${err.message}`)
    }
  }
  throw new Error('All ABS REST candidates failed')
}

// --- ABS CSV fallback (streams ~4.5 GB line by line) ---

const ABS_CSV_URL = 'https://data.api.abs.gov.au/files/ABS_MERCH_EXP_1.0.0.csv'
const LNG_SITC_CODES = ['343'] // SITC Rev 3 div 343 = Natural gas (incl. LNG), 3-digit level

function parseCSVLine(line) {
  const fields = []
  let cur = ''
  let inQuote = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++ }
      else if (ch === '"') { inQuote = false }
      else { cur += ch }
    } else {
      if (ch === '"') { inQuote = true }
      else if (ch === ',') { fields.push(cur.trim()); cur = '' }
      else { cur += ch }
    }
  }
  fields.push(cur.trim())
  return fields
}

async function fetchFromABSCSV() {
  console.log(`  Streaming ABS CSV: ${ABS_CSV_URL}`)
  const res = await fetch(ABS_CSV_URL, { headers: FETCH_HEADERS })
  if (!res.ok) throw new Error(`ABS CSV ${res.status}: ${ABS_CSV_URL}`)

  const rl = readline.createInterface({ input: Readable.fromWeb(res.body), crlfDelay: Infinity })

  let headers = null
  let sitcIdx, countryIdx, stateIdx, freqIdx, periodIdx, valueIdx, unitMultIdx
  const lngObs = {}
  let rowCount = 0
  const allSitcCodes = new Set()

  for await (const line of rl) {
    if (!line.trim()) continue
    const cols = parseCSVLine(line)

    if (!headers) {
      headers = cols.map(h => h.toUpperCase())
      sitcIdx    = headers.findIndex(h => h === 'COMMODITY_SITC')
      countryIdx = headers.findIndex(h => h === 'COUNTRY_DEST')
      stateIdx   = headers.findIndex(h => h === 'STATE_ORIGIN')
      freqIdx    = headers.findIndex(h => h === 'FREQ')
      periodIdx  = headers.findIndex(h => h === 'TIME_PERIOD')
      valueIdx   = headers.findIndex(h => h === 'OBS_VALUE')
      unitMultIdx = headers.findIndex(h => h === 'UNIT_MULT')
      console.log(`  CSV columns: ${cols.join(', ')}`)
      if (sitcIdx < 0 || periodIdx < 0 || valueIdx < 0) {
        throw new Error(`Missing required CSV columns. Headers: ${cols.join(', ')}`)
      }
      continue
    }

    rowCount++
    const sitc = cols[sitcIdx]
    if (allSitcCodes.size < 500) allSitcCodes.add(sitc)

    if (!LNG_SITC_CODES.includes(sitc)) continue
    if (countryIdx >= 0 && cols[countryIdx] !== 'TOT') continue
    if (stateIdx   >= 0 && cols[stateIdx]   !== 'TOT') continue
    if (freqIdx    >= 0 && cols[freqIdx]     !== 'M')   continue

    const period   = cols[periodIdx]
    const rawValue = parseFloat(cols[valueIdx])
    const unitMult = unitMultIdx >= 0 ? parseInt(cols[unitMultIdx]) || 0 : 0
    const value    = rawValue * Math.pow(10, unitMult)
    if (period && !isNaN(value)) lngObs[period] = value
  }

  console.log(`  Scanned ${rowCount.toLocaleString()} rows, found ${Object.keys(lngObs).length} LNG months`)

  if (Object.keys(lngObs).length === 0) {
    const sitcList = [...allSitcCodes].sort()
    console.log(`  Unique COMMODITY_SITC codes: ${sitcList.join(', ')}`)
    throw new Error('No LNG observations found in ABS CSV')
  }

  const latest12 = Object.entries(lngObs)
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, 12)
  console.log(`  Period range: ${latest12[latest12.length - 1][0]} – ${latest12[0][0]}`)
  return latest12.reduce((sum, [, v]) => sum + v, 0)
}

// --- main ---

async function main() {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))

  let annualValueAUD
  try {
    console.log('Fetching LNG export data...')

    const sources = [
      { name: 'DISR Resources and Energy Quarterly', fn: fetchFromDISR },
      { name: 'ABS MERCH_EXP REST API',              fn: fetchFromABSREST },
      { name: 'ABS MERCH_EXP bulk CSV',              fn: fetchFromABSCSV },
    ]

    let lastErr
    for (const { name, fn } of sources) {
      try {
        annualValueAUD = await fn()
        console.log(`  ✓ Source: ${name}`)
        break
      } catch (err) {
        console.warn(`  ${name} failed: ${err.message}`)
        lastErr = err
      }
    }

    if (annualValueAUD == null) {
      const isTransient = lastErr?.message.includes('403') || lastErr?.message.includes('fetch failed')
      if (isTransient) {
        console.warn('All sources unreachable (transient) — keeping existing config, will retry next quarter')
        process.exit(0)
      }
      throw lastErr
    }

    if (annualValueAUD <= 0) {
      throw new Error('Fetched value is zero or negative — data may not be published yet')
    }

    const today = new Date().toISOString().split('T')[0]
    config.annualExportValueAUD = Math.round(annualValueAUD)
    config.lastUpdated = today
    config.dataSource = `DISR Resources and Energy Quarterly (auto-updated ${today})`

    console.log(`✓ Annual LNG export value: AUD $${(annualValueAUD / 1e9).toFixed(1)}B`)
  } catch (err) {
    console.error('Fetch failed:', err.message)
    console.log('Keeping existing config — no changes written')
    process.exit(1)
  }

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n')
  console.log('✓ lng-config.json updated')
}

main()
