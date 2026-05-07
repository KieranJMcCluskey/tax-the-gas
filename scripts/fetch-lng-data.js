/**
 * Fetches the latest Australian LNG export data from the ABS API
 * and updates src/data/lng-config.json.
 *
 * ABS dataset: International Trade in Goods (MERCH_EXP)
 * SITC commodity 3413 = Liquefied natural gas
 *
 * Runs via GitHub Actions quarterly — see .github/workflows/update-lng-data.yml
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = path.resolve(__dirname, '../src/data/lng-config.json')

// ABS Data Explorer API — International Merchandise Exports, SITC Rev 3
// Commodity 3413 = Liquefied natural gas, measure = export value (AUD) + volume (tonnes)
const ABS_VALUE_URL =
  'https://api.data.abs.gov.au/data/ABS,MERCH_EXP,1.0.0/M3.3413.1.AUS.Q?startPeriod=2023&format=jsondata'

const ABS_VOLUME_URL =
  'https://api.data.abs.gov.au/data/ABS,MERCH_EXP,1.0.0/M3.3413.2.AUS.Q?startPeriod=2023&format=jsondata'

async function fetchJSON(url) {
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.sdmx.data+json;version=1.0' },
  })
  if (!res.ok) throw new Error(`ABS API ${res.status}: ${url}`)
  return res.json()
}

function sumLatestFourQuarters(data) {
  // Extract observations sorted by period, take the 4 most recent quarters
  const obs = data?.dataSets?.[0]?.series?.['0:0:0:0:0']?.observations
  if (!obs) throw new Error('Unexpected ABS response shape')

  const periods = Object.keys(obs)
    .map(Number)
    .sort((a, b) => a - b)
    .slice(-4)

  return periods.reduce((sum, k) => sum + (obs[k][0] ?? 0), 0)
}

async function main() {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  let updated = false

  try {
    console.log('Fetching ABS LNG export value...')
    const valueData = await fetchJSON(ABS_VALUE_URL)
    const annualValueAUD = sumLatestFourQuarters(valueData) * 1_000_000 // ABS reports in $M

    console.log('Fetching ABS LNG export volume...')
    const volumeData = await fetchJSON(ABS_VOLUME_URL)
    const annualVolumeTonnes = sumLatestFourQuarters(volumeData) * 1_000 // ABS reports in '000 tonnes

    if (annualValueAUD > 0 && annualVolumeTonnes > 0) {
      const today = new Date().toISOString().split('T')[0]
      config.annualExportValueAUD = Math.round(annualValueAUD)
      config.annualExportVolumeTonnes = Math.round(annualVolumeTonnes)
      config.lastUpdated = today
      config.dataSource = `ABS International Merchandise Exports (auto-updated ${today})`
      updated = true
      console.log(`✓ Value: AUD $${(annualValueAUD / 1e9).toFixed(1)}B`)
      console.log(`✓ Volume: ${(annualVolumeTonnes / 1e6).toFixed(1)}M tonnes`)
    } else {
      throw new Error('ABS returned zero values — data may not be published yet')
    }
  } catch (err) {
    console.error('ABS fetch failed:', err.message)
    console.log('Falling back to existing config — no changes written')
    process.exit(1)
  }

  if (updated) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n')
    console.log('✓ lng-config.json updated')
  }
}

main()
