import { useState, useEffect } from 'react'
import config from '../data/lng-config.json'

const SECONDS_PER_YEAR = 365.25 * 24 * 60 * 60
const START_DATE = new Date(config.counterStartDate)

function deriveRates() {
  const annualTax = config.annualExportValueAUD * (config.taxRatePercent / 100)
  const taxPerSecond = annualTax / SECONDS_PER_YEAR

  const annualJapanTonnes = config.annualExportVolumeTonnes * (config.japanSharePercent / 100)
  const japanAnnualYen = annualJapanTonnes * config.japanLngTaxYenPerTonne
  const japanPerSecond = japanAnnualYen / SECONDS_PER_YEAR

  return { taxPerSecond, japanPerSecond }
}

export function useTicker(audPerJpy) {
  const { taxPerSecond, japanPerSecond } = deriveRates()

  function calcValues() {
    const secondsElapsed = (Date.now() - START_DATE.getTime()) / 1000
    const auTaxAUD = secondsElapsed * taxPerSecond
    const japanYen = secondsElapsed * japanPerSecond
    const rate = audPerJpy || config.fallbackAudPerJpy
    const japanAUD = japanYen * rate
    return { auTaxAUD, japanYen, japanAUD, secondsElapsed }
  }

  const [values, setValues] = useState(calcValues)

  useEffect(() => {
    const interval = setInterval(() => setValues(calcValues()), 100)
    return () => clearInterval(interval)
  }, [audPerJpy])

  return { ...values, taxPerSecond, japanPerSecond }
}
