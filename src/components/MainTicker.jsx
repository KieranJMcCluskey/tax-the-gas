import config from '../data/lng-config.json'

const AUD = new Intl.NumberFormat('en-AU', {
  style: 'currency',
  currency: 'AUD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
})

const START = new Date(config.counterStartDate).toLocaleDateString('en-AU', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
})

export default function MainTicker({ auTaxAUD }) {
  return (
    <section className="main-ticker">
      <p className="ticker-label">
        What a 25% tax on Australian LNG exports would have raised
      </p>
      <div className="ticker-amount" aria-live="polite" aria-atomic="true">
        {AUD.format(Math.floor(auTaxAUD))}
      </div>
      <p className="ticker-since">since {START}</p>
      <p className="ticker-source">
        Based on 2024–25 export volumes of 79.2 million tonnes valued at AUD $65 billion.{' '}
        <a
          href={config.dataSourceUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          DISR source ↗
        </a>
      </p>
    </section>
  )
}
