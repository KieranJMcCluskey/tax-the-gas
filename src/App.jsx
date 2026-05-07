import { useExchangeRate } from './hooks/useExchangeRate'
import { useTicker } from './hooks/useTicker'
import MainTicker from './components/MainTicker'
import ServiceCards from './components/ServiceCards'
import JapanTicker from './components/JapanTicker'
import config from './data/lng-config.json'
import './App.css'

export default function App() {
  const audPerJpy = useExchangeRate()
  const { auTaxAUD, japanYen, japanAUD } = useTicker(audPerJpy)

  return (
    <div className="app">
      <header className="site-header">
        <div className="header-inner">
          <div className="logo-wrap">
            <span className="logo-icon">⛽</span>
            <span className="logo-text">Tax the Gas</span>
          </div>
          <a
            className="data-link"
            href={config.dataSourceUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Data source ↗
          </a>
        </div>
      </header>

      <main>
        <div className="hero">
          <h1 className="hero-title">What Australia is missing out on</h1>
          <p className="hero-sub">
            Since the current government took power on 3 May 2025, Australia has
            continued exporting billions in LNG without a meaningful resource
            tax — while multinational oil and gas companies pocket the profits.
            Here's what a 25% export tax would have raised.
          </p>
        </div>

        <MainTicker auTaxAUD={auTaxAUD} />
        <ServiceCards auTaxAUD={auTaxAUD} />
        <JapanTicker japanYen={japanYen} japanAUD={japanAUD} />
      </main>

      <footer className="site-footer">
        <p>
          Figures are illustrative estimates based on official DISR export data
          and a modelled 25% export value tax. Data last updated:{' '}
          {config.lastUpdated}. Not financial or political advice.
        </p>
        <p>
          <a
            href="https://sugarollymountain.com"
            target="_blank"
            rel="noopener noreferrer"
          >
            sugarollymountain.com
          </a>
        </p>
      </footer>
    </div>
  )
}
