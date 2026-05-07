import ServiceCard from './ServiceCard'
import config from '../data/lng-config.json'

export default function ServiceCards({ auTaxAUD }) {
  return (
    <section className="service-cards">
      <h2 className="cards-heading">What it could have paid for</h2>
      <div className="cards-grid">
        {Object.entries(config.cardCosts).map(([id, { label, unit, cost }]) => (
          <ServiceCard
            key={id}
            id={id}
            label={label}
            unit={unit}
            cost={cost}
            totalAUD={auTaxAUD}
          />
        ))}
      </div>
    </section>
  )
}
