import { useState, useEffect, useRef } from 'react'
import { MapContainer, TileLayer, Marker, Popup, Polygon } from 'react-leaflet'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { Users, Map as MapIcon, BarChart3, Briefcase, Download, X } from 'lucide-react'
import L from 'leaflet'

delete (L.Icon.Default.prototype as any)._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
})

const API_URL = (import.meta as any).env?.VITE_API_URL || 'http://localhost:3001'

interface Lead {
  id: string
  company_name: string
  domain: string
  city: string
  address?: string
  coordinates?: { lat: number; lng: number }
  lpr: { name: string; position: string }[]
  lpr_emails: string[]
  brands: string[]
  lead_score: number
  lead_tier: 'A' | 'B' | 'C'
  status: string
  pdf_file?: string
  comments?: string[]
  status_history?: any[]
  sector_id?: string
  assigned_manager_id?: string
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'table' | 'map' | 'managers' | 'analytics'>('table')
  const [leads, setLeads] = useState<Lead[]>([])
  const [managers, setManagers] = useState<any[]>([])
  const [sectors, setSectors] = useState<any[]>([])
  const [analytics, setAnalytics] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const mapRef = useRef<L.Map | null>(null)
  
  const [supplier, setSupplier] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('supplier_config')
      if (saved) {
        try { return JSON.parse(saved) } catch (e) { console.error(e) }
      }
    }
    return { name: 'УралАвтоОпт', contact: 'Петров И.С.' }
  })
  
  const [isSupplierModalOpen, setIsSupplierModalOpen] = useState(false)
  const [tempSupplier, setTempSupplier] = useState(supplier)
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null)
  const [newComment, setNewComment] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')

  useEffect(() => { loadData() }, [])

  // Пересчитываем размер карты при переключении на вкладку
  useEffect(() => {
    if (activeTab === 'map' && mapRef.current) {
      setTimeout(() => {
        mapRef.current?.invalidateSize()
      }, 100)
    }
  }, [activeTab])

  const loadData = async () => {
    try {
      const [lRes, mRes, sRes, aRes] = await Promise.all([
        fetch(`${API_URL}/api/leads`),
        fetch(`${API_URL}/api/managers`),
        fetch(`${API_URL}/api/sectors`),
        fetch(`${API_URL}/api/analytics`)
      ])
      setLeads(await lRes.json())
      setManagers(await mRes.json())
      setSectors(await sRes.json())
      setAnalytics(await aRes.json())
      setLoading(false)
    } catch (e) {
      console.error('Error loading data:', e)
      setLoading(false)
    }
  }

  const handleStatusChange = async (leadId: string, newStatus: string) => {
    const lead = leads.find(l => l.id === leadId)
    await fetch(`${API_URL}/api/leads/${leadId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: newStatus,
        status_history: [...(lead?.status_history || []), { status: newStatus, date: new Date().toLocaleString('ru-RU') }]
      })
    })
    loadData()
    if (selectedLead?.id === leadId) setSelectedLead({ ...lead, status: newStatus } as Lead)
  }

  const handleSaveSupplier = () => {
    setSupplier(tempSupplier)
    if (typeof window !== 'undefined') {
      localStorage.setItem('supplier_config', JSON.stringify(tempSupplier))
    }
    setIsSupplierModalOpen(false)
    alert('✅ Данные поставщика обновлены')
  }

  const handleCopyEmail = (email: string) => {
    navigator.clipboard.writeText(email)
    alert(`Email ${email} скопирован`)
  }

  const handleDownloadPDF = async (lead: Lead) => {
    if (!lead.pdf_file) { alert('PDF не сгенерирован'); return }
    try {
      const res = await fetch(`${API_URL}/api/leads/${lead.id}/pdf`)
      if (res.ok) {
        const blob = await res.blob()
        window.open(URL.createObjectURL(blob), '_blank')
      } else {
        alert('PDF не найден')
      }
    } catch (e) { alert('Ошибка скачивания PDF') }
  }

  const handleAddComment = async () => {
    if (!newComment.trim() || !selectedLead) return
    await fetch(`${API_URL}/api/leads/${selectedLead.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comments: [...(selectedLead.comments || []), newComment] })
    })
    setNewComment('')
    loadData()
    const updated = { ...selectedLead, comments: [...(selectedLead.comments || []), newComment] }
    setSelectedLead(updated)
  }

  const filteredLeads = leads.filter(l =>
    (statusFilter === 'all' || l.status === statusFilter) &&
    (searchQuery === '' || l.company_name.toLowerCase().includes(searchQuery.toLowerCase()))
  )

  if (loading) return <div style={{ color: 'white', padding: 40, textAlign: 'center' }}>Загрузка системы...</div>

  const getStatusColor = (s: string) => ({
    new: '#64748B', contacted: '#3B82F6', in_progress: '#8B5CF6',
    not_target: '#F59E0B', blacklisted: '#EF4444', converted: '#10B981'
  }[s] || '#64748B')

  const getStatusText = (s: string) => ({
    new: 'Новый', contacted: 'КП отправлено', in_progress: 'В работе',
    not_target: 'Не целевой', blacklisted: 'Черный список', converted: 'Клиент'
  }[s] || s)

  return (
    <div style={{ minHeight: '100vh', backgroundColor: '#0F172A', color: '#F8FAFC', fontFamily: 'sans-serif', padding: '20px' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px' }}>
        <div>
          <h1 style={{ fontSize: '24px', fontWeight: 'bold', marginBottom: '4px' }}>B2B Lead Pipeline</h1>
          <p style={{ color: '#94A3B8', fontSize: '14px' }}>Генератор целевых лидов и персональных КП</p>
        </div>
        <button
          onClick={() => { setTempSupplier(supplier); setIsSupplierModalOpen(true) }}
          style={{ backgroundColor: '#334155', border: '1px solid #475569', color: 'white', padding: '8px 16px', borderRadius: '6px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px' }}
        >
          <Briefcase size={16} /> Поставщик: {supplier.name}
        </button>
      </header>

      <div style={{ display: 'flex', gap: '8px', marginBottom: '24px', borderBottom: '1px solid #334155', paddingBottom: '12px' }}>
        {[
          { id: 'table', label: 'Таблица лидов', icon: Users },
          { id: 'map', label: 'Карта и сектора', icon: MapIcon },
          { id: 'managers', label: 'Менеджеры', icon: Briefcase },
          { id: 'analytics', label: 'Аналитика', icon: BarChart3 }
        ].map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id as any)} style={{
            backgroundColor: activeTab === tab.id ? '#3B82F6' : 'transparent',
            border: 'none', color: 'white', padding: '8px 16px', borderRadius: '6px',
            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '14px'
          }}>
            <tab.icon size={16} /> {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'table' && (
        <div style={{ backgroundColor: '#1E293B', borderRadius: '12px', padding: '24px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '16px', marginBottom: '24px' }}>
            <div style={{ backgroundColor: '#0F172A', padding: '16px', borderRadius: '8px', border: '2px solid #6366F1' }}>
              <div style={{ fontSize: '12px', color: '#94A3B8', marginBottom: '4px' }}>ВСЕГО В БАЗЕ</div>
              <div style={{ fontSize: '24px', fontWeight: 'bold' }}>{leads.length}</div>
            </div>
            <div style={{ backgroundColor: '#0F172A', padding: '16px', borderRadius: '8px' }}>
              <div style={{ fontSize: '12px', color: '#3B82F6', marginBottom: '4px' }}>НОВЫЕ</div>
              <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#3B82F6' }}>{leads.filter(l => l.status === 'new').length}</div>
            </div>
            <div style={{ backgroundColor: '#0F172A', padding: '16px', borderRadius: '8px' }}>
              <div style={{ fontSize: '12px', color: '#F59E0B', marginBottom: '4px' }}>В РАБОТЕ</div>
              <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#F59E0B' }}>{leads.filter(l => l.status === 'in_progress').length}</div>
            </div>
            <div style={{ backgroundColor: '#0F172A', padding: '16px', borderRadius: '8px' }}>
              <div style={{ fontSize: '12px', color: '#10B981', marginBottom: '4px' }}>КЛИЕНТЫ</div>
              <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#10B981' }}>{leads.filter(l => l.status === 'converted').length}</div>
            </div>
          </div>

          <div style={{ marginBottom: '24px' }}>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Поиск по компании, сайту, ЛПР или брендам..."
              style={{ width: '100%', backgroundColor: '#0F172A', border: '1px solid #334155', borderRadius: '8px', padding: '12px 16px', color: '#F8FAFC', fontSize: '14px', outline: 'none', marginBottom: '16px' }}
            />
            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: '200px' }}>
                <label style={{ fontSize: '12px', color: '#94A3B8', marginBottom: '4px', display: 'block' }}>Статус</label>
                <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ width: '100%', backgroundColor: '#0F172A', border: '1px solid #334155', borderRadius: '6px', padding: '8px 12px', color: '#F8FAFC', fontSize: '13px', outline: 'none' }}>
                  <option value="all">Все статусы</option>
                  <option value="new">Новые</option>
                  <option value="contacted">КП отправлено</option>
                  <option value="in_progress">В работе</option>
                  <option value="not_target">Не целевые</option>
                  <option value="blacklisted">Черный список</option>
                  <option value="converted">Клиенты</option>
                </select>
              </div>
            </div>
            <div style={{ fontSize: '13px', color: '#94A3B8', marginTop: '12px' }}>Найдено: {filteredLeads.length} из {leads.length} лидов</div>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #334155' }}>
                  {['КОМПАНИЯ & САЙТ', 'ЛПР & КОНТАКТЫ', 'БРЕНДЫ', 'СКОР', 'СТАТУС', 'ДЕЙСТВИЯ'].map(h => (
                    <th key={h} style={{ textAlign: 'left', padding: '12px', color: '#94A3B8', fontSize: '12px' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredLeads.length === 0 ? (
                  <tr><td colSpan={6} style={{ padding: '32px', textAlign: 'center', color: '#64748B' }}>Лиды не найдены</td></tr>
                ) : (
                  filteredLeads.map((lead) => (
                    <tr key={lead.id} style={{ borderBottom: '1px solid #334155' }}>
                      <td style={{ padding: '16px 12px' }}>
                        <div style={{ fontWeight: '600', marginBottom: '4px' }}>{lead.company_name}</div>
                        <div style={{ color: '#64748B', fontSize: '13px' }}>{lead.domain}</div>
                        <div style={{ color: '#64748B', fontSize: '12px' }}>{lead.city}</div>
                      </td>
                      <td style={{ padding: '16px 12px' }}>
                        {lead.lpr.map((p, idx) => (
                          <div key={idx} style={{ marginBottom: '8px' }}>
                            <div style={{ fontSize: '13px', marginBottom: '2px' }}>{p.name}</div>
                            <div style={{ display: 'inline-block', backgroundColor: '#334155', padding: '2px 8px', borderRadius: '4px', fontSize: '11px', color: '#94A3B8', marginRight: '8px' }}>{p.position}</div>
                            {lead.lpr_emails[idx] && (
                              <div style={{ fontSize: '12px', color: '#64748B', marginTop: '4px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <span>{lead.lpr_emails[idx]}</span>
                                <button onClick={() => handleCopyEmail(lead.lpr_emails[idx])} style={{ backgroundColor: '#334155', border: 'none', borderRadius: '4px', padding: '2px 6px', cursor: 'pointer', color: '#94A3B8', fontSize: '11px' }}>Copy</button>
                              </div>
                            )}
                          </div>
                        ))}
                      </td>
                      <td style={{ padding: '16px 12px' }}>
                        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                          {lead.brands.slice(0, 3).map((brand, idx) => (
                            <span key={idx} style={{ backgroundColor: '#334155', padding: '4px 8px', borderRadius: '4px', fontSize: '12px' }}>{brand}</span>
                          ))}
                          {lead.brands.length > 3 && <span style={{ fontSize: '12px', color: '#94A3B8' }}>+{lead.brands.length - 3}</span>}
                        </div>
                      </td>
                      <td style={{ padding: '16px 12px' }}>
                        <div style={{ fontWeight: 'bold', fontSize: '16px' }}>{lead.lead_score}</div>
                        <div style={{ display: 'inline-block', backgroundColor: lead.lead_tier === 'A' ? '#10B981' : lead.lead_tier === 'B' ? '#F59E0B' : '#EF4444', padding: '2px 8px', borderRadius: '4px', fontSize: '11px', marginTop: '4px' }}>Tier {lead.lead_tier}</div>
                      </td>
                      <td style={{ padding: '16px 12px' }}>
                        <select value={lead.status} onChange={(e) => handleStatusChange(lead.id, e.target.value)} style={{ backgroundColor: getStatusColor(lead.status) + '20', color: getStatusColor(lead.status), border: `1px solid ${getStatusColor(lead.status)}`, borderRadius: '6px', padding: '6px 12px', fontSize: '13px', fontWeight: '500', cursor: 'pointer', outline: 'none' }}>
                          <option value="new">Новый</option>
                          <option value="contacted">КП отправлено</option>
                          <option value="in_progress">В работе</option>
                          <option value="not_target">Не целевой</option>
                          <option value="blacklisted">Черный список</option>
                          <option value="converted">Клиент</option>
                        </select>
                      </td>
                      <td style={{ padding: '16px 12px' }}>
                        <div style={{ display: 'flex', gap: '8px' }}>
                          <button onClick={() => setSelectedLead(lead)} style={{ backgroundColor: '#3B82F6', border: 'none', borderRadius: '6px', padding: '8px 12px', color: 'white', cursor: 'pointer', fontSize: '12px', fontWeight: '500' }}>Открыть</button>
                          <button onClick={() => handleDownloadPDF(lead)} style={{ backgroundColor: lead.pdf_file ? '#10B981' : '#64748B', border: 'none', borderRadius: '6px', padding: '8px 12px', color: 'white', cursor: 'pointer', fontSize: '12px', fontWeight: '500', display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <Download size={14} /> КП
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'map' && (
        <div style={{ height: 'calc(100vh - 200px)', minHeight: '600px' }}>
          <div style={{ backgroundColor: '#1E293B', borderRadius: '12px', padding: '16px', marginBottom: '16px' }}>
            <h3 style={{ fontSize: '16px', fontWeight: '600', marginBottom: '8px' }}>Карта лидов и секторов</h3>
            <p style={{ color: '#94A3B8', fontSize: '13px' }}>
              Показано {sectors.length} секторов и {filteredLeads.filter(l => l.coordinates).length} лидов на карте
            </p>
          </div>
          <div style={{ height: 'calc(100% - 80px)', borderRadius: '12px', overflow: 'hidden', border: '1px solid #334155' }}>
            <MapContainer 
              center={[56.838011, 60.597474]} 
              zoom={12} 
              style={{ height: '100%', width: '100%' }}
              ref={mapRef}
            >
              <TileLayer 
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              {sectors.map((sec: any) => (
                <Polygon 
                  key={sec.id} 
                  pathOptions={{ color: sec.color || '#3B82F6', fillColor: sec.color || '#3B82F6', fillOpacity: 0.2, weight: 2 }} 
                  positions={sec.polygon?.geometry?.coordinates?.[0]?.map((c: any) => [c[1], c[0]]) || []}
                >
                  <Popup>
                    <b>{sec.name}</b><br />
                    Менеджер: {managers.find((m: any) => m.id === sec.manager_id)?.name || 'Не назначен'}
                  </Popup>
                </Polygon>
              ))}
              {filteredLeads.map(lead => lead.coordinates && (
                <Marker 
                  key={lead.id} 
                  position={[lead.coordinates.lat, lead.coordinates.lng]}
                >
                  <Popup>
                    <b>{lead.company_name}</b><br />
                    {lead.city}<br />
                    Скор: {lead.lead_score} | Tier: {lead.lead_tier}<br />
                    Статус: {getStatusText(lead.status)}
                  </Popup>
                </Marker>
              ))}
            </MapContainer>
          </div>
        </div>
      )}

      {activeTab === 'managers' && (
        <div style={{ backgroundColor: '#1E293B', borderRadius: '12px', padding: '24px' }}>
          <h2 style={{ marginBottom: '20px' }}>Управление менеджерами</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '16px' }}>
            {managers.map(m => {
              const stats = analytics?.managers?.find((am: any) => am.id === m.id)
              return (
                <div key={m.id} style={{ backgroundColor: '#0F172A', padding: '16px', borderRadius: '8px', border: '1px solid #334155' }}>
                  <div style={{ fontWeight: 'bold', fontSize: '16px', marginBottom: '8px' }}>{m.name}</div>
                  <div style={{ color: '#94A3B8', fontSize: '13px', marginBottom: '4px' }}>{m.position}</div>
                  <div style={{ color: '#94A3B8', fontSize: '13px', marginBottom: '4px' }}>{m.email}</div>
                  <div style={{ color: '#94A3B8', fontSize: '13px', marginBottom: '12px' }}>{m.phone}</div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <span style={{ backgroundColor: '#334155', padding: '4px 8px', borderRadius: '4px', fontSize: '12px' }}>Лидов: {stats?.leadsCount || 0}</span>
                    <span style={{ backgroundColor: '#10B981', padding: '4px 8px', borderRadius: '4px', fontSize: '12px', color: 'white' }}>Клиентов: {stats?.convertedCount || 0}</span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {activeTab === 'analytics' && analytics && (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '16px', marginBottom: '24px' }}>
            <div style={{ backgroundColor: '#1E293B', padding: '16px', borderRadius: '8px' }}>
              <div style={{ fontSize: '12px', color: '#94A3B8', marginBottom: '4px' }}>ВСЕГО ЛИДОВ</div>
              <div style={{ fontSize: '24px', fontWeight: 'bold' }}>{analytics.total}</div>
            </div>
            <div style={{ backgroundColor: '#1E293B', padding: '16px', borderRadius: '8px' }}>
              <div style={{ fontSize: '12px', color: '#94A3B8', marginBottom: '4px' }}>НОВЫЕ</div>
              <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#3B82F6' }}>{analytics.new}</div>
            </div>
            <div style={{ backgroundColor: '#1E293B', padding: '16px', borderRadius: '8px' }}>
              <div style={{ fontSize: '12px', color: '#94A3B8', marginBottom: '4px' }}>В РАБОТЕ</div>
              <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#F59E0B' }}>{analytics.in_progress}</div>
            </div>
            <div style={{ backgroundColor: '#1E293B', padding: '16px', borderRadius: '8px' }}>
              <div style={{ fontSize: '12px', color: '#94A3B8', marginBottom: '4px' }}>КЛИЕНТЫ</div>
              <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#10B981' }}>{analytics.converted}</div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
            <div style={{ backgroundColor: '#1E293B', borderRadius: '12px', padding: '24px' }}>
              <h3 style={{ marginBottom: '16px' }}>Воронка по статусам</h3>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={[
                  { name: 'Новые', value: analytics.new },
                  { name: 'В работе', value: analytics.in_progress },
                  { name: 'Клиенты', value: analytics.converted }
                ]}>
                  <XAxis dataKey="name" stroke="#94A3B8" />
                  <YAxis stroke="#94A3B8" />
                  <Tooltip contentStyle={{ backgroundColor: '#0F172A', border: '1px solid #334155', color: 'white' }} />
                  <Bar dataKey="value" fill="#3B82F6" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div style={{ backgroundColor: '#1E293B', borderRadius: '12px', padding: '24px' }}>
              <h3 style={{ marginBottom: '16px' }}>Эффективность менеджеров</h3>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={analytics.managers} layout="vertical">
                  <XAxis type="number" stroke="#94A3B8" />
                  <YAxis dataKey="name" type="category" stroke="#94A3B8" width={150} />
                  <Tooltip contentStyle={{ backgroundColor: '#0F172A', border: '1px solid #334155', color: 'white' }} />
                  <Bar dataKey="leadsCount" fill="#8B5CF6" radius={[0, 4, 4, 0]} name="Всего лидов" />
                  <Bar dataKey="convertedCount" fill="#10B981" radius={[0, 4, 4, 0]} name="Клиенты" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}

      {selectedLead && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={() => setSelectedLead(null)}>
          <div style={{ backgroundColor: '#1E293B', borderRadius: '12px', padding: '32px', maxWidth: '700px', width: '100%', maxHeight: '80vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px' }}>
              <h2 style={{ fontSize: '20px', fontWeight: 'bold' }}>{selectedLead.company_name}</h2>
              <button onClick={() => setSelectedLead(null)} style={{ background: 'none', border: 'none', color: '#94A3B8', cursor: 'pointer' }}><X size={24} /></button>
            </div>

            <div style={{ marginBottom: '24px' }}>
              <h3 style={{ fontSize: '14px', color: '#94A3B8', marginBottom: '12px', textTransform: 'uppercase' }}>Основная информация</h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                <div><div style={{ fontSize: '12px', color: '#64748B', marginBottom: '4px' }}>Сайт</div><div style={{ fontSize: '14px' }}>{selectedLead.domain}</div></div>
                <div><div style={{ fontSize: '12px', color: '#64748B', marginBottom: '4px' }}>Город</div><div style={{ fontSize: '14px' }}>{selectedLead.city}</div></div>
                <div><div style={{ fontSize: '12px', color: '#64748B', marginBottom: '4px' }}>Lead Score</div><div style={{ fontSize: '14px', fontWeight: 'bold' }}>{selectedLead.lead_score}</div></div>
                <div><div style={{ fontSize: '12px', color: '#64748B', marginBottom: '4px' }}>Tier</div><div style={{ display: 'inline-block', backgroundColor: selectedLead.lead_tier === 'A' ? '#10B981' : '#F59E0B', padding: '4px 12px', borderRadius: '4px', fontSize: '12px', fontWeight: 'bold' }}>Tier {selectedLead.lead_tier}</div></div>
              </div>
            </div>

            <div style={{ marginBottom: '24px' }}>
              <h3 style={{ fontSize: '14px', color: '#94A3B8', marginBottom: '12px', textTransform: 'uppercase' }}>ЛПР</h3>
              {selectedLead.lpr.map((p, i) => (
                <div key={i} style={{ backgroundColor: '#0F172A', padding: '12px', borderRadius: '8px', marginBottom: '8px' }}>
                  <div style={{ fontWeight: '600', marginBottom: '4px' }}>{p.name}</div>
                  <div style={{ fontSize: '12px', color: '#94A3B8', marginBottom: '8px' }}>{p.position}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '13px', color: '#64748B' }}>{selectedLead.lpr_emails[i]}</span>
                    <button onClick={() => handleCopyEmail(selectedLead.lpr_emails[i])} style={{ backgroundColor: '#334155', border: 'none', borderRadius: '4px', padding: '4px 8px', cursor: 'pointer', color: '#94A3B8', fontSize: '11px' }}>Copy</button>
                  </div>
                </div>
              ))}
            </div>

            <div style={{ marginBottom: '24px' }}>
              <h3 style={{ fontSize: '14px', color: '#94A3B8', marginBottom: '12px', textTransform: 'uppercase' }}>Бренды</h3>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {selectedLead.brands.map((brand, idx) => (
                  <span key={idx} style={{ backgroundColor: '#334155', padding: '6px 12px', borderRadius: '6px', fontSize: '13px' }}>{brand}</span>
                ))}
              </div>
            </div>

            <div style={{ marginBottom: '24px' }}>
              <h3 style={{ fontSize: '14px', color: '#94A3B8', marginBottom: '12px', textTransform: 'uppercase' }}>История статусов</h3>
              <div style={{ maxHeight: '150px', overflowY: 'auto' }}>
                {(selectedLead.status_history || []).map((item: any, idx: number) => (
                  <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #334155', fontSize: '13px' }}>
                    <span style={{ color: getStatusColor(item.status) }}>{getStatusText(item.status)}</span>
                    <span style={{ color: '#64748B', fontSize: '12px' }}>{item.date}</span>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ marginBottom: '24px' }}>
              <h3 style={{ fontSize: '14px', color: '#94A3B8', marginBottom: '12px', textTransform: 'uppercase' }}>Комментарии</h3>
              <div style={{ maxHeight: '150px', overflowY: 'auto', marginBottom: '12px' }}>
                {(selectedLead.comments || []).length === 0 ? <div style={{ color: '#64748B', fontStyle: 'italic' }}>Нет комментариев</div> :
                  (selectedLead.comments || []).map((c: string, i: number) => <div key={i} style={{ backgroundColor: '#0F172A', padding: '10px', borderRadius: '6px', marginBottom: '6px', fontSize: '13px' }}>{c}</div>)}
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <input value={newComment} onChange={e => setNewComment(e.target.value)} placeholder="Новый комментарий..."
                  style={{ flex: 1, backgroundColor: '#0F172A', border: '1px solid #334155', borderRadius: '6px', padding: '8px', color: 'white', outline: 'none' }}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleAddComment() }}
                />
                <button onClick={handleAddComment} style={{ backgroundColor: '#3B82F6', border: 'none', borderRadius: '6px', padding: '8px 16px', color: 'white', cursor: 'pointer', fontSize: '13px', fontWeight: '500' }}>Добавить</button>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
              <button onClick={() => handleDownloadPDF(selectedLead)} style={{ backgroundColor: selectedLead.pdf_file ? '#10B981' : '#64748B', border: 'none', borderRadius: '6px', padding: '10px 20px', color: 'white', cursor: 'pointer', fontSize: '13px', fontWeight: '500' }}>Скачать КП</button>
              <button onClick={() => setSelectedLead(null)} style={{ backgroundColor: '#334155', border: 'none', borderRadius: '6px', padding: '10px 20px', color: '#F8FAFC', cursor: 'pointer', fontSize: '13px', fontWeight: '500' }}>Закрыть</button>
            </div>
          </div>
        </div>
      )}

      {isSupplierModalOpen && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={() => setIsSupplierModalOpen(false)}>
          <div style={{ backgroundColor: '#1E293B', borderRadius: '12px', padding: '32px', width: '400px' }} onClick={e => e.stopPropagation()}>
            <h2 style={{ marginBottom: '20px' }}>Настройки поставщика</h2>
            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', color: '#94A3B8', fontSize: '12px', marginBottom: '4px' }}>Название компании</label>
              <input value={tempSupplier.name} onChange={e => setTempSupplier({ ...tempSupplier, name: e.target.value })} style={{ width: '100%', backgroundColor: '#0F172A', border: '1px solid #334155', borderRadius: '6px', padding: '8px', color: 'white', outline: 'none' }} />
            </div>
            <div style={{ marginBottom: '24px' }}>
              <label style={{ display: 'block', color: '#94A3B8', fontSize: '12px', marginBottom: '4px' }}>Контактное лицо</label>
              <input value={tempSupplier.contact} onChange={e => setTempSupplier({ ...tempSupplier, contact: e.target.value })} style={{ width: '100%', backgroundColor: '#0F172A', border: '1px solid #334155', borderRadius: '6px', padding: '8px', color: 'white', outline: 'none' }} />
            </div>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
              <button onClick={() => setIsSupplierModalOpen(false)} style={{ backgroundColor: '#334155', border: 'none', borderRadius: '6px', padding: '8px 16px', color: 'white', cursor: 'pointer' }}>Отмена</button>
              <button onClick={handleSaveSupplier} style={{ backgroundColor: '#3B82F6', border: 'none', borderRadius: '6px', padding: '8px 16px', color: 'white', cursor: 'pointer' }}>Сохранить</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}