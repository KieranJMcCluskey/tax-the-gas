import config from '../data/lng-config.json'

const JPY = new Intl.NumberFormat('ja-JP', {
  style: 'currency',
  currency: 'JPY',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
})

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

export default function JapanTicker({ japanYen, japanAUD }) {
  return (
    <section className="japan-ticker">
      <div className="japan-ticker-inner">
        <p className="japan-label">
          Meanwhile — Japan has collected this much in Petroleum &amp; Coal Tax
          on Australian LNG imports since {START}
        </p>
        <div className="japan-amounts">
          <span className="japan-yen">{JPY.format(Math.floor(japanYen))}</span>
          <span className="japan-divider">≈</span>
          <span className="japan-aud">{AUD.format(Math.floor(japanAUD))} AUD</span>
        </div>
        <p className="japan-note">
          Japan levies ¥1,860 per tonne on every LNG import under its Petroleum
          and Coal Tax (climate change mitigation levy, est. 2012). Australia
          charges nothing.
        </p>
      </div>
    </section>
  )
}
