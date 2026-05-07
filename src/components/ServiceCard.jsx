const ICONS = {
  school:         '🏫',
  police:         '👮',
  nurse:          '🏥',
  agedCare:       '🧓',
  hospitalBedDay: '🛏️',
  socialHousing:  '🏠',
  university:     '🎓',
  solarMW:        '☀️',
}

const NUM = new Intl.NumberFormat('en-AU')

export default function ServiceCard({ id, label, unit, cost, totalAUD }) {
  const count = Math.floor(totalAUD / cost)
  const plural = count === 1 ? unit : unit + 's'

  return (
    <div className="service-card">
      <span className="card-icon" aria-hidden="true">{ICONS[id]}</span>
      <div className="card-count">{NUM.format(count)}</div>
      <div className="card-unit">{plural}</div>
      <div className="card-label">{label}</div>
    </div>
  )
}
