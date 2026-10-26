import { useEffect, useRef } from 'react'
import { MapContainer, TileLayer, Marker, Popup, Polygon } from 'react-leaflet'
import { Map as MapIcon } from 'lucide-react'
import L from 'leaflet'
import { Lead } from '../lib/types'

interface Props {
  leads: Lead[]
  sectors: any[]
  managers: any[]
}

export default function MapPage({ leads, sectors, managers }: Props) {
  const mapRef = useRef<L.Map | null>(null)
  const withCoords = leads.filter(l => l.coordinates)

  useEffect(() => {
    const t = setTimeout(() => { mapRef.current?.invalidateSize() }, 150)
    return () => clearTimeout(t)
  }, [])

  return (
    <div className="space-y-4 h-[calc(100vh-140px)] md:h-[calc(100vh-90px)] flex flex-col">
      <div className="card px-5 py-4 flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-lg font-extrabold text-white tracking-tight flex items-center gap-2">
            <MapIcon size={18} className="text-indigo-400" /> Карта лидов и секторов
          </h1>
          <p className="text-[13px] text-slate-500 mt-0.5">
            {sectors.length} секторов · {withCoords.length} лидов с координатами
          </p>
        </div>
      </div>
      <div className="card overflow-hidden flex-1 relative">
        <MapContainer
          center={[56.838011, 60.597474]}
          zoom={12}
          className="w-full h-full"
          ref={mapRef}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          {sectors.map((sec: any) => (
            <Polygon
              key={sec.id}
              pathOptions={{ color: sec.color || '#6366F1', fillColor: sec.color || '#6366F1', fillOpacity: 0.15, weight: 2 }}
              positions={sec.polygon?.geometry?.coordinates?.[0]?.map((c: any) => [c[1], c[0]]) || []}
            >
              <Popup>
                <b>{sec.name}</b><br />
                Менеджер: {managers.find((m: any) => m.id === sec.manager_id)?.name || 'Не назначен'}
              </Popup>
            </Polygon>
          ))}
          {withCoords.map(lead => (
            <Marker key={lead.id} position={[lead.coordinates!.lat, lead.coordinates!.lng]}>
              <Popup>
                <b>{lead.company_name}</b><br />
                {lead.city}<br />
                Скор: {lead.lead_score} · Tier {lead.lead_tier}
              </Popup>
            </Marker>
          ))}
        </MapContainer>
      </div>
    </div>
  )
}
