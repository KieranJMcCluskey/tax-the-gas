import { useState, useEffect } from 'react'
import config from '../data/lng-config.json'

const CACHE_KEY = 'taxthegas_jpyaud'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

export function useExchangeRate() {
  const [audPerJpy, setAudPerJpy] = useState(config.fallbackAudPerJpy)

  useEffect(() => {
    const cached = sessionStorage.getItem(CACHE_KEY)
    if (cached) {
      const { rate, ts } = JSON.parse(cached)
      if (Date.now() - ts < CACHE_TTL_MS) {
        setAudPerJpy(rate)
        return
      }
    }

    fetch('https://api.frankfurter.app/latest?from=JPY&to=AUD')
      .then(r => r.json())
      .then(data => {
        const rate = data?.rates?.AUD
        if (rate) {
          setAudPerJpy(rate)
          sessionStorage.setItem(CACHE_KEY, JSON.stringify({ rate, ts: Date.now() }))
        }
      })
      .catch(() => {})
  }, [])

  return audPerJpy
}
