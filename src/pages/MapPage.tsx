import { useEffect, useMemo, useRef, useState } from 'react'
import { MapContainer, TileLayer, Marker, Popup, Polygon, Polyline, useMap, useMapEvents } from 'react-leaflet'
import { Map as MapIcon, LocateFixed, Square, Circle as CircleIcon, PenTool, X, Check, Pencil, Trash2 } from 'lucide-react'
import { CenterModal } from '../components/Drawer'
import L from 'leaflet'
import { Lead, STATUS_META } from '../lib/types'

interface Props {
  leads: Lead[]
  sectors: any[]
  managers: any[]
  onGeocodeMissing: (leadIds: string[]) => Promise<any>
  onCreateSector: (sector: any) => Promise<any>
  onUpdateSector: (sectorId: string, sector: any) => Promise<any>
  onDeleteSector: (sectorId: string) => Promise<any>
}

type DrawMode = 'rectangle' | 'circle' | 'polygon'

interface PendingShape {
  shapeType: DrawMode
  ring: [number, number][]
}

function DrawController({ mode, onPoint }: { mode: DrawMode | null; onPoint: (point: L.LatLng) => void }) {
  const map = useMapEvents({
    click(event) {
      if (mode) onPoint(event.latlng)
    },
  })

  useEffect(() => {
    if (mode) {
      map.doubleClickZoom.disable()
      map.getContainer().style.cursor = 'crosshair'
    } else {
      map.doubleClickZoom.enable()
      map.getContainer().style.cursor = ''
    }
    return () => {
      map.doubleClickZoom.enable()
      map.getContainer().style.cursor = ''
    }
  }, [map, mode])

  return null
}

function closedRing(points: L.LatLng[]): [number, number][] {
  const coords = points.map(point => [point.lng, point.lat] as [number, number])
  if (coords.length && (coords[0][0] !== coords[coords.length - 1][0] || coords[0][1] !== coords[coords.length - 1][1])) {
    coords.push([...coords[0]])
  }
  return coords
}

function rectangleRing(first: L.LatLng, second: L.LatLng): [number, number][] {
  const west = Math.min(first.lng, second.lng), east = Math.max(first.lng, second.lng)
  const south = Math.min(first.lat, second.lat), north = Math.max(first.lat, second.lat)
  return [[west, south], [east, south], [east, north], [west, north], [west, south]]
}

function circleRing(center: L.LatLng, edge: L.LatLng, steps = 48): [number, number][] {
  const radius = center.distanceTo(edge)
  const latScale = radius / 111320
  const cosLatitude = Math.max(0.1, Math.cos(center.lat * Math.PI / 180))
  const lngScale = radius / (111320 * cosLatitude)
  const ring: [number, number][] = []
  for (let i = 0; i < steps; i++) {
    const angle = (2 * Math.PI * i) / steps
    ring.push([center.lng + lngScale * Math.cos(angle), center.lat + latScale * Math.sin(angle)])
  }
  ring.push([...ring[0]])
  return ring
}

function FitToLeads({ leads }: { leads: Lead[] }) {
  const map = useMap()

  useEffect(() => {
    const points = leads.map(lead => [lead.coordinates!.lat, lead.coordinates!.lng] as [number, number])
    if (points.length === 0) return
    if (points.length === 1) {
      map.setView(points[0], 13)
      return
    }
    map.fitBounds(L.latLngBounds(points), { padding: [32, 32], maxZoom: 13 })
  }, [map, leads])

  return null
}

export default function MapPage({ leads, sectors, managers, onGeocodeMissing, onCreateSector, onUpdateSector, onDeleteSector }: Props) {
  const mapRef = useRef<L.Map | null>(null)
  const [cityFilter, setCityFilter] = useState('all')
  const [industryFilter, setIndustryFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [drawMode, setDrawMode] = useState<DrawMode | null>(null)
  const [drawPoints, setDrawPoints] = useState<L.LatLng[]>([])
  const [pendingShape, setPendingShape] = useState<PendingShape | null>(null)
  const [sectorDraft, setSectorDraft] = useState({ name: '', manager_id: '', color: '#6366F1' })
  const [sectorBusy, setSectorBusy] = useState(false)
  const [sectorError, setSectorError] = useState('')
  const [sectorEditingId, setSectorEditingId] = useState<string | null>(null)
  const [geocodeBusy, setGeocodeBusy] = useState(false)
  const [geocodeError, setGeocodeError] = useState('')
  const cities = useMemo(() => [...new Set(leads.map(lead => lead.city?.trim()).filter((value): value is string => Boolean(value)))].sort((a, b) => a.localeCompare(b, 'ru')), [leads])
  const industries = useMemo(() => [...new Set(leads.map(lead => lead.industry?.trim()).filter((value): value is string => Boolean(value)))].sort((a, b) => a.localeCompare(b, 'ru')), [leads])
  const filteredLeads = useMemo(() => leads.filter(lead =>
    (cityFilter === 'all' || lead.city?.trim() === cityFilter) &&
    (industryFilter === 'all' || lead.industry?.trim() === industryFilter) &&
    (statusFilter === 'all' || lead.status === statusFilter)
  ), [leads, cityFilter, industryFilter, statusFilter])
  const hasCoordinates = (lead: Lead) => Boolean(lead.coordinates && Number.isFinite(lead.coordinates.lat) && Number.isFinite(lead.coordinates.lng) && Math.abs(lead.coordinates.lat) <= 90 && Math.abs(lead.coordinates.lng) <= 180)
  const withCoords = useMemo(() => filteredLeads.filter(hasCoordinates), [filteredLeads])
  const withoutGeocoding = filteredLeads.length - withCoords.length
  const missingLeadIds = filteredLeads.filter(lead => !hasCoordinates(lead)).map(lead => lead.id)
  const geocodeBatchIds = missingLeadIds.slice(0, 50)

  const startDrawing = (mode: DrawMode) => {
    setPendingShape(null)
    setSectorEditingId(null)
    setDrawPoints([])
    setDrawMode(mode)
    setSectorError('')
  }

  const handleDrawingPoint = (point: L.LatLng) => {
    if (!drawMode) return
    const next = [...drawPoints, point]
    if (drawMode === 'polygon') {
      setDrawPoints(next)
      return
    }
    if (next.length < 2) {
      setDrawPoints(next)
      return
    }
    const ring = drawMode === 'rectangle'
      ? rectangleRing(next[0], next[1])
      : circleRing(next[0], next[1])
    setPendingShape({ shapeType: drawMode, ring })
    setSectorDraft({ name: '', manager_id: '', color: '#6366F1' })
    setDrawMode(null)
    setDrawPoints([])
  }

  const finishPolygon = () => {
    if (drawPoints.length < 3) {
      setSectorError('Отметьте на карте минимум 3 вершины области')
      return
    }
    setPendingShape({ shapeType: 'polygon', ring: closedRing(drawPoints) })
    setSectorDraft({ name: '', manager_id: '', color: '#6366F1' })
    setDrawMode(null)
    setDrawPoints([])
    setSectorError('')
  }

  const cancelDrawing = () => { setDrawMode(null); setDrawPoints([]); setSectorError('') }

  const handleEditSector = (sector: any) => {
    const ring = sector.polygon?.geometry?.coordinates?.[0]
    if (!Array.isArray(ring) || ring.length < 4) {
      setSectorError('У сектора нет корректной области для редактирования')
      return
    }
    setSectorEditingId(sector.id)
    setPendingShape({
      shapeType: sector.polygon?.properties?.shape_type || 'polygon',
      ring: ring.map((point: any) => [Number(point[0]), Number(point[1])] as [number, number]),
    })
    setSectorDraft({ name: sector.name || '', manager_id: sector.manager_id || '', color: sector.color || '#6366F1' })
    setSectorError('')
  }

  const handleDeleteSectorClick = async (sector: any) => {
    if (!window.confirm(`Удалить сектор «${sector.name}»? Лиды останутся в базе, привязка к этому сектору будет снята.`)) return
    try {
      await onDeleteSector(sector.id)
    } catch (error: any) {
      setSectorError(error?.message || 'Не удалось удалить сектор')
    }
  }

  const handleGeocodeClick = async () => {
    setGeocodeBusy(true); setGeocodeError('')
    try {
      await onGeocodeMissing(geocodeBatchIds)
    } catch (error: any) {
      setGeocodeError(error?.message || 'Не удалось найти координаты')
    } finally { setGeocodeBusy(false) }
  }

  const handleSaveSector = async () => {
    if (!pendingShape || !sectorDraft.name.trim()) {
      setSectorError('Введите название сектора')
      return
    }
    setSectorBusy(true); setSectorError('')
    try {
      const payload = {
        name: sectorDraft.name.trim(),
        manager_id: sectorDraft.manager_id || undefined,
        color: sectorDraft.color,
        polygon: {
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [pendingShape.ring] },
          properties: { shape_type: pendingShape.shapeType },
        },
      }
      if (sectorEditingId) await onUpdateSector(sectorEditingId, payload)
      else await onCreateSector(payload)
      setPendingShape(null)
      setSectorEditingId(null)
      setSectorDraft({ name: '', manager_id: '', color: '#6366F1' })
    } catch (error: any) {
      setSectorError(error?.message || 'Не удалось сохранить сектор')
    } finally { setSectorBusy(false) }
  }

  useEffect(() => {
    const t = setTimeout(() => { mapRef.current?.invalidateSize() }, 150)
    return () => clearTimeout(t)
  }, [])

  return (
    <div className="space-y-4 h-[calc(100vh-140px)] md:h-[calc(100vh-90px)] flex flex-col">
      <div className="card px-5 py-4 space-y-3 shrink-0">
        <div>
          <h1 className="text-lg font-extrabold text-white tracking-tight flex items-center gap-2">
            <MapIcon size={18} className="text-indigo-400" /> Карта лидов и секторов
          </h1>
          <p className="text-[13px] text-slate-500 mt-0.5">
            {sectors.length} секторов · {withCoords.length} из {filteredLeads.length} лидов с координатами · {withoutGeocoding} без координат
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <select aria-label="Фильтр города" value={cityFilter} onChange={e => setCityFilter(e.target.value)} className="input !w-auto !py-2 text-[13px]">
            <option value="all">Все города</option>
            {cities.map(city => <option key={city} value={city}>{city}</option>)}
          </select>
          <select aria-label="Фильтр вида деятельности" value={industryFilter} onChange={e => setIndustryFilter(e.target.value)} className="input !w-auto !py-2 text-[13px]">
            <option value="all">Все виды деятельности</option>
            {industries.map(industry => <option key={industry} value={industry}>{industry}</option>)}
          </select>
          <select aria-label="Фильтр статуса" value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="input !w-auto !py-2 text-[13px]">
            <option value="all">Все статусы</option>
            {Object.entries(STATUS_META).map(([status, meta]) => <option key={status} value={status}>{meta.label}</option>)}
          </select>
          {(cityFilter !== 'all' || industryFilter !== 'all' || statusFilter !== 'all') && (
            <button onClick={() => { setCityFilter('all'); setIndustryFilter('all'); setStatusFilter('all') }} className="btn-ghost !py-2 text-[13px]">Сбросить</button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          {missingLeadIds.length > 0 && (
            <button onClick={() => void handleGeocodeClick()} disabled={geocodeBusy} className="btn-ghost !py-2 text-[13px]">
              <LocateFixed size={14} /> {geocodeBusy ? 'Ищу координаты…' : 'Найти координаты (' + geocodeBatchIds.length + ' из ' + missingLeadIds.length + ')'}
            </button>
          )}
          <span className="text-xs text-slate-600">Нарисовать сектор:</span>
          <button onClick={() => startDrawing('rectangle')} className="btn-ghost !py-2 text-[13px]"><Square size={14} /> Прямоугольник</button>
          <button onClick={() => startDrawing('circle')} className="btn-ghost !py-2 text-[13px]"><CircleIcon size={14} /> Круг</button>
          <button onClick={() => startDrawing('polygon')} className="btn-ghost !py-2 text-[13px]"><PenTool size={14} /> Ломаная область</button>
          {drawMode === 'polygon' && (
            <button onClick={finishPolygon} disabled={drawPoints.length < 3} className="btn-primary !py-2 text-[13px]">
              <Check size={14} /> Замкнуть и продолжить
            </button>
          )}
          {drawMode && <button onClick={cancelDrawing} className="btn-ghost !py-2 text-[13px]"><X size={14} /> Отмена</button>}
        </div>
        {drawMode && <p className="text-xs text-indigo-300">
          {drawMode === 'rectangle' && 'Кликните две противоположные точки прямоугольника.'}
          {drawMode === 'circle' && 'Кликните центр круга, затем точку на его границе.'}
          {drawMode === 'polygon' && 'Отметьте вершины области кликами (' + drawPoints.length + '/3 минимум), затем нажмите «Замкнуть и продолжить».'}
        </p>}
        {geocodeError && <p className="text-xs text-rose-300">{geocodeError}</p>}
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
          <FitToLeads leads={withCoords} />
          <DrawController mode={drawMode} onPoint={handleDrawingPoint} />
          {drawMode === 'polygon' && drawPoints.length >= 2 && <Polyline positions={drawPoints} pathOptions={{ color: '#A78BFA', weight: 3, dashArray: '6 6' }} />}
          {drawMode === 'polygon' && drawPoints.length >= 3 && <Polygon positions={drawPoints} pathOptions={{ color: '#A78BFA', fillColor: '#8B5CF6', fillOpacity: 0.12, weight: 1 }} />}
          {pendingShape && <Polygon positions={pendingShape.ring.map(([lng, lat]) => [lat, lng] as [number, number])} pathOptions={{ color: sectorDraft.color, fillColor: sectorDraft.color, fillOpacity: 0.18, weight: 3, dashArray: '6 5' }} />}
          {sectors.map((sec: any) => (
            <Polygon
              key={sec.id}
              pathOptions={{ color: sec.color || '#6366F1', fillColor: sec.color || '#6366F1', fillOpacity: 0.15, weight: 2 }}
              positions={sec.polygon?.geometry?.coordinates?.[0]?.map((c: any) => [c[1], c[0]]) || []}
            >
              <Popup>
                <b>{sec.name}</b><br />
                Менеджер: {managers.find((m: any) => m.id === sec.manager_id)?.name || 'Не назначен'}<br />
                <div className="flex gap-2 mt-2">
                  <button type="button" onClick={() => handleEditSector(sec)} className="text-indigo-600 underline text-xs">Редактировать</button>
                  <button type="button" onClick={() => void handleDeleteSectorClick(sec)} className="text-rose-600 underline text-xs">Удалить</button>
                </div>
              </Popup>
            </Polygon>
          ))}
          {withCoords.map(lead => (
            <Marker key={lead.id} position={[lead.coordinates!.lat, lead.coordinates!.lng]}>
              <Popup>
                <b>{lead.company_name}</b><br />
                {lead.city}{lead.industry ? ` · ${lead.industry}` : ''}<br />
                {lead.address && <>{lead.address}<br /></>}
                {lead.phone && <>Телефон: {lead.phone}<br /></>}
                {lead.lpr?.[0]?.name && <>Контакт: {lead.lpr[0].name}{lead.lpr[0].position ? ` · ${lead.lpr[0].position}` : ''}<br /></>}
                {lead.lpr_emails?.[0] && <>Email: {lead.lpr_emails[0]}<br /></>}
                Статус: {STATUS_META[lead.status]?.label || lead.status}<br />
                Скор: {lead.lead_score} · Tier {lead.lead_tier}
              </Popup>
            </Marker>
          ))}
        </MapContainer>
        {withCoords.length === 0 && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-[1000] rounded-xl border border-line bg-ink-900/95 px-4 py-3 text-sm text-slate-300 shadow-lg text-center">
            Нет лидов с координатами по выбранным фильтрам
            {filteredLeads.length > 0 && <div className="text-xs text-slate-500 mt-1">{filteredLeads.length} записей без координат</div>}
          </div>
        )}
      </div>
      <CenterModal open={Boolean(pendingShape)} onClose={() => { if (!sectorBusy) { setPendingShape(null); setSectorEditingId(null); setSectorError('') } }} title={sectorEditingId ? 'Редактирование сектора' : 'Новый сектор'} width="max-w-lg">
        {pendingShape && (
          <div className="space-y-4">
            <p className="text-sm text-slate-400">
              Форма: {pendingShape.shapeType === 'rectangle' ? 'прямоугольник' : pendingShape.shapeType === 'circle' ? 'круг' : 'замкнутая ломаная область'}.
              {pendingShape.shapeType === 'circle' && ' Круг сохраняется как приближённая граница области.'}
            </p>
            <div>
              <label className="label">Название сектора</label>
              <input value={sectorDraft.name} onChange={e => setSectorDraft({ ...sectorDraft, name: e.target.value })} className="input" placeholder="Например, Север города" />
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <label className="label">Ответственный менеджер</label>
                <select value={sectorDraft.manager_id} onChange={e => setSectorDraft({ ...sectorDraft, manager_id: e.target.value })} className="input">
                  <option value="">Не назначен</option>
                  {managers.map(manager => <option key={manager.id} value={manager.id}>{manager.name}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Цвет сектора</label>
                <input type="color" value={sectorDraft.color} onChange={e => setSectorDraft({ ...sectorDraft, color: e.target.value })} className="input h-11 p-1" />
              </div>
            </div>
            {sectorError && <div className="text-sm text-rose-300">{sectorError}</div>}
            <div className="flex justify-end gap-2">
              <button onClick={() => { setPendingShape(null); setSectorEditingId(null); setSectorError('') }} disabled={sectorBusy} className="btn-ghost">Отмена</button>
              <button onClick={() => void handleSaveSector()} disabled={sectorBusy} className="btn-primary">{sectorBusy ? 'Сохраняю…' : sectorEditingId ? 'Сохранить изменения' : 'Сохранить сектор'}</button>
            </div>
          </div>
        )}
      </CenterModal>
    </div>
  )
}
