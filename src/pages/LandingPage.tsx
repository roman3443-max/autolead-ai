import { useEffect, useState } from 'react'
import { CircleMarker, MapContainer, Polygon, Polyline, TileLayer, Marker, Tooltip } from 'react-leaflet'
import L from 'leaflet'
import { ArrowRight, BarChart3, Briefcase, Check, MapPinned, Search, ShieldCheck, Sparkles, X } from 'lucide-react'

type Position = [number, number]

const MOSCOW: Position = [55.75803, 37.62817]
const SUPPLIER: Position = [55.7558, 37.6173]
const SECTOR: Position[] = [
  [55.750, 37.601], [55.765, 37.605], [55.770, 37.626], [55.759, 37.644],
  [55.747, 37.639], [55.741, 37.622],
]
const DEMO_LEADS = [
  { name: 'Пример СТО «Север»', position: [55.749, 37.635] as Position, state: 'priority' },
  { name: 'Пример магазина «Центр»', position: [55.759, 37.604] as Position, state: 'new' },
  { name: 'Пример СТО «Мотор»', position: [55.758, 37.630] as Position, state: 'working' },
  { name: 'Демо-точка 04', position: [55.750, 37.610] as Position, state: 'new' },
  { name: 'Демо-точка 05', position: [55.756, 37.641] as Position, state: 'priority' },
  { name: 'Демо-точка 06', position: [55.752, 37.596] as Position, state: 'working' },
  { name: 'Демо-точка 07', position: [55.765, 37.608] as Position, state: 'new' },
]

// Road-following demo route exported from OSRM; the map tiles and their geography are live OSM data.
const ROUTE: Position[] = [[55.756371,37.616948],[55.756365,37.616789],[55.7566,37.616309],[55.756964,37.615623],[55.75715,37.615747],[55.757663,37.61657],[55.758368,37.617714],[55.758562,37.61844],[55.758797,37.619757],[55.758863,37.620135],[55.759103,37.621594],[55.759391,37.623725],[55.759513,37.625652],[55.759351,37.626095],[55.758507,37.627326],[55.757701,37.628438],[55.756664,37.629876],[55.756853,37.630685],[55.757163,37.631487],[55.757233,37.631699],[55.757426,37.632756],[55.757531,37.633485],[55.757583,37.634131],[55.757659,37.635588],[55.757724,37.63639],[55.757778,37.636826],[55.758046,37.638063],[55.758309,37.63919],[55.758563,37.640277],[55.758794,37.641633],[55.759056,37.643296],[55.759182,37.64446],[55.759222,37.645381],[55.758523,37.645844],[55.758166,37.646071],[55.75737,37.646811],[55.756558,37.647573],[55.755938,37.64804],[55.755707,37.648182],[55.755215,37.648067],[55.754349,37.647682],[55.75356,37.647164],[55.752893,37.646751],[55.751423,37.645662],[55.751085,37.645021],[55.750978,37.644557],[55.750675,37.64294],[55.750594,37.642668],[55.750327,37.642139],[55.749546,37.641423],[55.749075,37.641129],[55.748786,37.640836],[55.745455,37.636072],[55.745252,37.636486],[55.744749,37.637293],[55.744526,37.63771],[55.745477,37.637785],[55.745938,37.638642],[55.746437,37.637881],[55.746955,37.636931],[55.747356,37.635876],[55.747676,37.634752]]

const supplierIcon = L.divIcon({
  className: 'landing-marker-wrap',
  html: '<span class="landing-supplier-marker"><span></span></span>',
  iconSize: [28, 28],
  iconAnchor: [14, 14],
})

function leadIcon(state: string) {
  return L.divIcon({
    className: 'landing-marker-wrap',
    html: `<span class="landing-lead-marker ${state}"><i></i><b></b></span>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  })
}

function AnimatedRoutePoint() {
  const [position, setPosition] = useState<Position>(ROUTE[0])

  useEffect(() => {
    let frame = 0
    let startedAt: number | undefined
    const tick = (now: number) => {
      if (startedAt === undefined) startedAt = now
      const progress = ((now - startedAt) % 15000) / 15000
      const scaled = progress * (ROUTE.length - 1)
      const index = Math.floor(scaled)
      const fraction = scaled - index
      const from = ROUTE[index]
      const to = ROUTE[Math.min(index + 1, ROUTE.length - 1)]
      setPosition([from[0] + (to[0] - from[0]) * fraction, from[1] + (to[1] - from[1]) * fraction])
      frame = requestAnimationFrame(tick)
    }
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [])

  return <CircleMarker center={position} radius={6} pathOptions={{ color: '#fff4dc', weight: 3, fillColor: '#b79af0', fillOpacity: 1, className: 'landing-route-runner' }} />
}

interface Props {
  onDemo: () => void
}

export default function LandingPage({ onDemo }: Props) {
  const [purchaseNote, setPurchaseNote] = useState(false)

  return (
    <div className="landing-page">
      <div className="landing-map" aria-label="Реальная карта центра Москвы">
        <MapContainer center={MOSCOW} zoom={14} zoomControl={false} scrollWheelZoom={false} className="landing-leaflet">
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            maxZoom={19}
          />
          <Polygon positions={SECTOR} pathOptions={{ color: '#d1b7ff', weight: 2, dashArray: '8 7', fillColor: '#8864bf', fillOpacity: 0.2, className: 'landing-sector' }} />
          <Polyline positions={ROUTE} pathOptions={{ color: '#c5a3ff', weight: 4, opacity: 0.95, dashArray: '12 9', className: 'landing-route' }} />
          <AnimatedRoutePoint />
          <Marker position={SUPPLIER} icon={supplierIcon}><Tooltip direction="top">Поставщик · демо</Tooltip></Marker>
          {DEMO_LEADS.map(lead => (
            <Marker key={lead.name} position={lead.position} icon={leadIcon(lead.state)}>
              <Tooltip direction="top">{lead.name} · демонстрационная точка</Tooltip>
            </Marker>
          ))}
          <CircleMarker center={[55.749, 37.635]} radius={12} pathOptions={{ color: '#d8c4ff', weight: 1, fillColor: '#a889e3', fillOpacity: 0.14, className: 'landing-pulse' }} />
        </MapContainer>
      </div>
      <div className="landing-map-shade" />

      <header className="landing-topbar">
        <a className="landing-brand" href="#top" aria-label="Lead Pipeline — главная">
          <span className="landing-brand-icon"><Search size={19} /></span>
          <span>Lead Pipeline<small>AI-генератор лидов</small></span>
        </a>
        <nav className="landing-nav" aria-label="Главная навигация">
          <a className="current" href="#top">Главная</a>
          <a href="#features">Возможности</a>
          <a href="#how-it-works">Как работает</a>
        </nav>
        <button className="landing-login" onClick={onDemo}>Войти <ArrowRight size={15} /></button>
      </header>

      <div className="landing-city-pill"><MapPinned size={15} /> Москва <span>· реальная карта города</span></div>
      <div className="landing-data-pill"><span className="landing-live-dot" /> Демо-данные · 7 компаний · 1 сектор · маршрут</div>

      <main id="top" className="landing-hero-content">
        <div className="landing-kicker"><Sparkles size={14} /> ПРОДАЖИ НА КАРТЕ</div>
        <h1>Ваш рынок —<br /><em>на карте.</em></h1>
        <p className="landing-intro">Находите профильные компании, выделяйте сектора и превращайте карту города в понятный план работы менеджеров.</p>
        <div className="landing-actions">
          <button className="landing-cta landing-cta-primary" onClick={onDemo}>
            <span className="landing-cta-icon"><Search size={20} /></span>
            <span><b>Посмотреть демо</b><small>Открыть рабочее приложение</small></span>
            <ArrowRight size={18} className="landing-arrow" />
          </button>
          <button className="landing-cta landing-cta-secondary" onClick={() => setPurchaseNote(true)}>
            <span className="landing-cta-icon"><Briefcase size={20} /></span>
            <span><b>Купить доступ</b><small>Подключить команду продаж</small></span>
            <ArrowRight size={18} className="landing-arrow" />
          </button>
        </div>
        <div className="landing-trust"><ShieldCheck size={14} /> Сектора, скоринг по ассортименту и единая база лидов</div>
      </main>

      <aside className="landing-map-card">
        <div className="landing-card-heading"><span className="landing-sector-swatch" />Сектор «Центр» <small>демо</small></div>
        <div className="landing-card-stats"><strong>7</strong><span>примерных компаний</span><i /> <strong>1</strong><span>маршрут</span></div>
        <div className="landing-card-note">Точки и граница сектора иллюстративные</div>
      </aside>

      <div className="landing-legend">
        <span><i className="new" /> Новый лид</span><span><i className="priority" /> Приоритетный</span><span><i className="working" /> В работе</span><span><i className="sector" /> Сектор</span><span><i className="route" /> Маршрут</span>
      </div>

      <div className="landing-bottomline">
        <div id="how-it-works"><span>Поиск</span><b>→</b><span>Скоринг</span><b>→</b><span>Работа с лидом</span><b>→</b><span>Коммерческое предложение</span></div>
        <div className="landing-feature-strip" id="features"><span><MapPinned size={14} /> Секторация</span><span><BarChart3 size={14} /> Приоритет по скору</span><span><Check size={14} /> Работа с базой</span></div>
      </div>

      <div className="landing-attribution"><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a></div>

      {purchaseNote && (
        <div className="landing-modal-backdrop" role="presentation" onClick={() => setPurchaseNote(false)}>
          <section className="landing-purchase-modal" role="dialog" aria-modal="true" aria-labelledby="landing-purchase-title" onClick={event => event.stopPropagation()}>
            <button className="landing-modal-close" aria-label="Закрыть" onClick={() => setPurchaseNote(false)}><X size={18} /></button>
            <div className="landing-modal-icon"><Briefcase size={21} /></div>
            <p className="landing-kicker">КОММЕРЧЕСКИЙ ДОСТУП</p>
            <h2 id="landing-purchase-title">Подключение команды</h2>
            <p>Тарифы и онлайн-оплата пока не подключены. Сначала можно пройти демо приложения и оценить рабочий сценарий.</p>
            <button className="landing-cta landing-cta-primary" onClick={onDemo}><span><b>Перейти к демо</b><small>Открыть приложение</small></span><ArrowRight size={18} /></button>
          </section>
        </div>
      )}
    </div>
  )
}
