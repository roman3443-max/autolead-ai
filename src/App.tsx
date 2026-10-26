import { useState, useEffect, useRef } from 'react'
import 'leaflet/dist/leaflet.css'
import { MapContainer, TileLayer, Marker, Popup, Polygon } from 'react-leaflet'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { Users, Map as MapIcon, BarChart3, Briefcase, Download, X, Search, Mail, Copy, Send } from 'lucide-react'
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
  business_size?: 'small' | 'medium' | 'large' | 'unknown'
  wholesale?: boolean
  reason?: string
  status: string
  pdf_file?: string | null
  comments?: string[]
  status_history?: any[]
  sector_id?: string
  assigned_manager_id?: string
  search_task_id?: string
  search_task_name?: string
}

interface Toast { id: number; text: string; type: 'success' | 'error' | 'info' }

interface PipelineJob {
  id: string
  status: string
  stage: string
  processed: number
  total: number
  added: number
  totalFound: number
  message: string
  error?: string
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'search' | 'table' | 'map' | 'managers' | 'analytics'>('table')
  const [leads, setLeads] = useState<Lead[]>([])
  const [managers, setManagers] = useState<any[]>([])
  const [sectors, setSectors] = useState<any[]>([])
  const [analytics, setAnalytics] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [isPipelineRunning, setIsPipelineRunning] = useState(false)
  const mapRef = useRef<L.Map | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const [toasts, setToasts] = useState<Toast[]>([])
  const [job, setJob] = useState<PipelineJob | null>(null)
  const [copiedLetters, setCopiedLetters] = useState<Record<string, boolean>>(() => {
    if (typeof window === 'undefined') return {}
    try { return JSON.parse(localStorage.getItem('copied_letters') || '{}') } catch { return {} }
  })
  const markLetterCopied = (id: string) => {
    setCopiedLetters(c => {
      const next = { ...c, [id]: true }
      try { localStorage.setItem('copied_letters', JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
  }
  const [searchTasks, setSearchTasks] = useState<any[]>([])
  const [taskForm, setTaskForm] = useState<any | null>(null)

  const toast = (text: string, type: Toast['type'] = 'info') => {
    const id = Date.now() + Math.random()
    setToasts(t => [...t, { id, text, type }])
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 5000)
  }

  // --- Доступ к API по ключу (если на сервере задан API_TOKEN) ---
  const [authRequired, setAuthRequired] = useState(false)
  const [tokenInput, setTokenInput] = useState('')

  const apiFetch = async (url: string, options: RequestInit = {}) => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('api_token') || '' : ''
    const res = await fetch(url, {
      ...options,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { 'x-api-token': token } : {}),
        ...(options.headers || {})
      }
    })
    if (res.status === 401) setAuthRequired(true)
    return res
  }

  const handleSaveToken = () => {
    if (!tokenInput.trim()) return
    localStorage.setItem('api_token', tokenInput.trim())
    setAuthRequired(false)
    setTokenInput('')
    loadData()
    loadTasks()
  }

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

  useEffect(() => { loadData(); loadTasks(); loadSupplierConfig() }, [])

  useEffect(() => {
    if (activeTab === 'map' && mapRef.current) {
      setTimeout(() => { mapRef.current?.invalidateSize() }, 100)
    }
  }, [activeTab])

  const loadData = async () => {
    try {
      const [lRes, mRes, sRes, aRes] = await Promise.all([
        apiFetch(`${API_URL}/api/leads`),
        apiFetch(`${API_URL}/api/managers`),
        apiFetch(`${API_URL}/api/sectors`),
        apiFetch(`${API_URL}/api/analytics`)
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

  const loadTasks = async () => {
    try {
      const res = await apiFetch(`${API_URL}/api/search-tasks`)
      if (res.ok) setSearchTasks(await res.json())
    } catch (e) { console.error('Error loading tasks:', e) }
  }

  // Настройки поставщика: сервер — источник истины, localStorage — кэш
  const loadSupplierConfig = async () => {
    try {
      const res = await apiFetch(`${API_URL}/api/supplier-config`)
      if (!res.ok) return
      const cfg = await res.json()
      if (cfg?.name) {
        setSupplier(cfg)
        try { localStorage.setItem('supplier_config', JSON.stringify(cfg)) } catch { /* ignore */ }
      }
    } catch (e) { console.error('Error loading supplier config:', e) }
  }

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
  }

  const pollJob = (jobId: string) => {
    stopPolling()
    pollRef.current = setInterval(async () => {
      try {
        const res = await apiFetch(`${API_URL}/api/pipeline-status/${jobId}`)
        if (!res.ok) return
        const data: PipelineJob = await res.json()
        setJob(data)
        if (data.status === 'done') {
          stopPolling()
          setIsPipelineRunning(false)
          toast(data.message, 'success')
          loadData()
          loadTasks()
        } else if (data.status === 'error') {
          stopPolling()
          setIsPipelineRunning(false)
          toast(data.error || 'Ошибка пайплайна', 'error')
          loadTasks()
        }
      } catch { /* сервер недоступен — продолжаем опрос */ }
    }, 2000)
  }

  useEffect(() => () => stopPolling(), [])

  // --- Сущность "Поиск лидов": задачи с параметрами ---
  const startJobPolling = async (res: Response) => {
    const data = await res.json()
    if (!res.ok || !data.jobId) {
      toast(data.error || 'Не удалось запустить поиск', 'error')
      setIsPipelineRunning(false)
      loadTasks()
      return
    }
    if (data.alreadyRunning) {
      toast('Поиск уже выполняется, показываю прогресс', 'info')
    } else {
      toast('Поиск запущен. Это займёт 1–3 минуты...', 'info')
    }
    setTaskForm(null)
    pollJob(data.jobId)
  }

  const handleRunTask = async (task: any) => {
    if (isPipelineRunning) { toast('Дождитесь завершения текущего поиска', 'error'); return }
    setIsPipelineRunning(true)
    setJob(null)
    try {
      const res = await apiFetch(`${API_URL}/api/search-tasks/${task.id}/run`, { method: 'POST' })
      await startJobPolling(res)
    } catch (e) {
      toast('Ошибка соединения с сервером', 'error')
      setIsPipelineRunning(false)
    }
  }

  const handleSaveTask = async () => {
    if (!taskForm) return
    if (!taskForm.name?.trim() || !taskForm.city?.trim() || !taskForm.industry?.trim()) {
      toast('Заполните название, город и отрасль', 'error')
      return
    }
    try {
      const isNew = !taskForm.id
      const res = await fetch(isNew ? `${API_URL}/api/search-tasks` : `${API_URL}/api/search-tasks/${taskForm.id}`, {
        method: isNew ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: taskForm.name,
          city: taskForm.city,
          industry: taskForm.industry,
          limit: taskForm.limit || 5,
          scoring: taskForm.scoring || null,
          use_ai: taskForm.use_ai !== false,
          use_geocode: taskForm.use_geocode !== false
        })
      })
      if (res.ok) {
        toast(isNew ? 'Задача поиска создана' : 'Задача обновлена', 'success')
        setTaskForm(null)
        loadTasks()
      } else {
        toast('Не удалось сохранить задачу', 'error')
      }
    } catch (e) { toast('Ошибка соединения с сервером', 'error') }
  }

  const handleDeleteTask = async (task: any) => {
    if (!window.confirm(`Удалить задачу "${task.name}"?`)) return
    await apiFetch(`${API_URL}/api/search-tasks/${task.id}`, { method: 'DELETE' })
    toast('Задача удалена', 'success')
    loadTasks()
  }

  const handleStatusChange = async (leadId: string, newStatus: string) => {
    const lead = leads.find(l => l.id === leadId)
    await apiFetch(`${API_URL}/api/leads/${leadId}`, {
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

  const handleSaveSupplier = async () => {
    setSupplier(tempSupplier)
    if (typeof window !== 'undefined') {
      localStorage.setItem('supplier_config', JSON.stringify(tempSupplier))
    }
    setIsSupplierModalOpen(false)
    try {
      await apiFetch(`${API_URL}/api/supplier-config`, {
        method: 'PUT',
        body: JSON.stringify({ name: tempSupplier.name, contact: tempSupplier.contact })
      })
      toast('Данные поставщика обновлены', 'success')
    } catch (e) {
      toast('Сохранено локально, но сервер недоступен', 'error')
    }
  }

  const handleCopyEmail = (email: string) => {
    navigator.clipboard.writeText(email)
    toast(`Email ${email} скопирован`, 'success')
  }

  const buildLetter = (lead: Lead) => {
    const topBrands = lead.brands.slice(0, 3).join(', ')
    const subject = `Коммерческое предложение для ${lead.company_name}${topBrands ? ' | ' + topBrands : ''}`
    const body = [
      `Добрый день, ${lead.lpr[0]?.name || 'коллеги'}!`,
      '',
      `Меня зовут ${supplier.contact}, я представляю компанию ${supplier.name}.`,
      `Мы проанализировали ваш ассортимент и подготовили персонализированное предложение${topBrands ? ' по брендам: ' + topBrands : ''}.`,
      '',
      'Во вложении — коммерческое предложение с ценами и условиями сотрудничества.',
      '',
      'С уважением,',
      `${supplier.contact}`,
      supplier.name
    ].join('\n')
    return { subject, body }
  }

  const handleCopyLetter = (lead: Lead) => {
    const { subject, body } = buildLetter(lead)
    navigator.clipboard.writeText(`Тема: ${subject}\n\n${body}`)
    markLetterCopied(lead.id)
    toast('Текст письма скопирован. Вставьте в почту и прикрепите КП', 'success')
  }

  const handleMailto = (lead: Lead) => {
    const { subject, body } = buildLetter(lead)
    window.location.href = `mailto:${lead.lpr_emails[0] || ''}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
    markLetterCopied(lead.id)
  }

  const handleDownloadPDF = async (lead: Lead) => {
    if (!lead.pdf_file) { toast('КП ещё не сгенерировано', 'error'); return }
    try {
      const res = await apiFetch(`${API_URL}/api/leads/${lead.id}/pdf`)
      if (res.ok) {
        const blob = await res.blob()
        window.open(URL.createObjectURL(blob), '_blank')
      } else {
        toast('Файл КП не найден на сервере', 'error')
      }
    } catch (e) { toast('Ошибка скачивания КП', 'error') }
  }

  const handleExportCSV = async () => {
    try {
      const res = await apiFetch(`${API_URL}/api/leads/export`)
      if (!res.ok) { toast('Не удалось выгрузить CSV', 'error'); return }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `leads_${new Date().toISOString().slice(0, 10)}.csv`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      toast(`Выгружено ${leads.length} лидов в CSV`, 'success')
    } catch (e) { toast('Ошибка соединения с сервером', 'error') }
  }

  const handleDeleteLead = async (lead: Lead) => {
    if (!window.confirm(`Удалить лид «${lead.company_name}»? Действие необратимо.`)) return
    try {
      const res = await apiFetch(`${API_URL}/api/leads/${lead.id}`, { method: 'DELETE' })
      if (res.ok) {
        toast('Лид удалён', 'success')
        setSelectedLead(null)
        loadData()
      } else {
        toast('Не удалось удалить лид', 'error')
      }
    } catch (e) { toast('Ошибка соединения с сервером', 'error') }
  }

  const handleAddComment = async () => {
    if (!newComment.trim() || !selectedLead) return
    await apiFetch(`${API_URL}/api/leads/${selectedLead.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comments: [...(selectedLead.comments || []), newComment] })
    })
    setNewComment('')
    loadData()
    const updated = { ...selectedLead, comments: [...(selectedLead.comments || []), newComment] }
    setSelectedLead(updated)
  }

  const filteredLeads = leads.filter(l => {
    if (statusFilter !== 'all' && l.status !== statusFilter) return false
    if (!searchQuery.trim()) return true
    const q = searchQuery.toLowerCase()
    return (
      l.company_name.toLowerCase().includes(q) ||
      l.domain.toLowerCase().includes(q) ||
      (l.city || '').toLowerCase().includes(q) ||
      (l.address || '').toLowerCase().includes(q) ||
      (l.lpr || []).some(p => `${p.name} ${p.position}`.toLowerCase().includes(q)) ||
      (l.lpr_emails || []).some(e => e.toLowerCase().includes(q)) ||
      (l.brands || []).some(b => b.toLowerCase().includes(q))
    )
  })

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
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px', flexWrap: 'wrap', gap: '16px' }}>
        <div>
          <h1 style={{ fontSize: '24px', fontWeight: 'bold', marginBottom: '4px' }}>B2B Lead Pipeline</h1>
          <p style={{ color: '#94A3B8', fontSize: '14px' }}>AI-генератор целевых лидов и персональных КП</p>
        </div>
        <div style={{ display: 'flex', gap: '12px' }}>
          <button
            onClick={() => setActiveTab('search')}
            disabled={isPipelineRunning}
            style={{ 
              backgroundColor: isPipelineRunning ? '#64748B' : '#10B981', 
              border: 'none', color: 'white', padding: '8px 16px', borderRadius: '6px', 
              cursor: isPipelineRunning ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: '8px', fontWeight: '600' 
            }}
          >
            <Search size={16} /> {isPipelineRunning ? 'Поиск выполняется...' : 'Запустить поиск'}
          </button>
          <button
            onClick={() => { setTempSupplier(supplier); setIsSupplierModalOpen(true) }}
            style={{ backgroundColor: '#334155', border: '1px solid #475569', color: 'white', padding: '8px 16px', borderRadius: '6px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px' }}
          >
            <Briefcase size={16} /> Поставщик: {supplier.name}
          </button>
        </div>
      </header>

      <div style={{ display: 'flex', gap: '8px', marginBottom: '24px', borderBottom: '1px solid #334155', paddingBottom: '12px', overflowX: 'auto' }}>
        {[
          { id: 'search', label: 'Поиск лидов', icon: Search },
          { id: 'table', label: 'Работа с лидами', icon: Users },
          { id: 'map', label: 'Карта и сектора', icon: MapIcon },
          { id: 'managers', label: 'Менеджеры', icon: Briefcase },
          { id: 'analytics', label: 'Аналитика', icon: BarChart3 }
        ].map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id as any)} style={{
            backgroundColor: activeTab === tab.id ? '#3B82F6' : 'transparent',
            border: 'none', color: 'white', padding: '8px 16px', borderRadius: '6px',
            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '14px', whiteSpace: 'nowrap'
          }}>
            <tab.icon size={16} /> {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'search' && (
        <div style={{ backgroundColor: '#1E293B', borderRadius: '12px', padding: '24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', flexWrap: 'wrap', gap: '12px' }}>
            <div>
              <h2 style={{ fontSize: '18px', fontWeight: 'bold' }}>Задачи поиска лидов</h2>
              <p style={{ color: '#94A3B8', fontSize: '13px' }}>Задайте, что и где искать, параметры скоринга и обогащения — затем запускайте в один клик</p>
            </div>
            <button
              onClick={() => setTaskForm({ name: '', city: 'Екатеринбург', industry: 'автозапчасти', limit: 5, scoring: null, use_ai: true, use_geocode: true })}
              style={{ backgroundColor: '#10B981', border: 'none', borderRadius: '6px', padding: '8px 16px', color: 'white', cursor: 'pointer', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              <Search size={16} /> Новая задача
            </button>
          </div>

          {taskForm && (
            <div style={{ backgroundColor: '#0F172A', border: '1px solid #334155', borderRadius: '12px', padding: '20px', marginBottom: '24px' }}>
              <h3 style={{ fontSize: '15px', fontWeight: '600', marginBottom: '16px' }}>{taskForm.id ? 'Редактирование задачи' : 'Новая задача поиска'}</h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px', marginBottom: '16px' }}>
                <div>
                  <label style={{ display: 'block', color: '#94A3B8', fontSize: '12px', marginBottom: '4px' }}>Название задачи</label>
                  <input value={taskForm.name} onChange={e => setTaskForm({ ...taskForm, name: e.target.value })} placeholder="Напр.: Опт Екб — крупные" style={{ width: '100%', backgroundColor: '#1E293B', border: '1px solid #334155', borderRadius: '6px', padding: '8px', color: 'white', outline: 'none', fontSize: '13px' }} />
                </div>
                <div>
                  <label style={{ display: 'block', color: '#94A3B8', fontSize: '12px', marginBottom: '4px' }}>Город</label>
                  <input value={taskForm.city} onChange={e => setTaskForm({ ...taskForm, city: e.target.value })} style={{ width: '100%', backgroundColor: '#1E293B', border: '1px solid #334155', borderRadius: '6px', padding: '8px', color: 'white', outline: 'none', fontSize: '13px' }} />
                </div>
                <div>
                  <label style={{ display: 'block', color: '#94A3B8', fontSize: '12px', marginBottom: '4px' }}>Отрасль</label>
                  <input value={taskForm.industry} onChange={e => setTaskForm({ ...taskForm, industry: e.target.value })} style={{ width: '100%', backgroundColor: '#1E293B', border: '1px solid #334155', borderRadius: '6px', padding: '8px', color: 'white', outline: 'none', fontSize: '13px' }} />
                </div>
                <div>
                  <label style={{ display: 'block', color: '#94A3B8', fontSize: '12px', marginBottom: '4px' }}>Сколько компаний (1–20)</label>
                  <input type="number" min={1} max={20} value={taskForm.limit} onChange={e => setTaskForm({ ...taskForm, limit: Math.min(20, Math.max(1, parseInt(e.target.value) || 5)) })} style={{ width: '100%', backgroundColor: '#1E293B', border: '1px solid #334155', borderRadius: '6px', padding: '8px', color: 'white', outline: 'none', fontSize: '13px' }} />
                </div>
              </div>

              <div style={{ marginBottom: '16px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px', marginBottom: '8px' }}>
                  <input type="checkbox" checked={taskForm.scoring !== null} onChange={e => setTaskForm({ ...taskForm, scoring: e.target.checked ? { weights: { lpr: 25, emails: 15, brands: 20, businessSize: 15, wholesale: 10, content: 15 } } : null })} />
                  Индивидуальные веса скоринга (иначе — scoring_config.json)
                </label>
                {taskForm.scoring && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '8px', padding: '12px', backgroundColor: '#1E293B', borderRadius: '8px' }}>
                    {[
                      ['lpr', 'ЛПР'], ['emails', 'Email'], ['brands', 'Бренды'],
                      ['businessSize', 'Размер'], ['wholesale', 'Опт'], ['content', 'Контент']
                    ].map(([key, label]) => (
                      <div key={key}>
                        <label style={{ display: 'block', color: '#94A3B8', fontSize: '11px', marginBottom: '2px' }}>{label}</label>
                        <input type="number" min={0} max={100} value={taskForm.scoring.weights[key]}
                          onChange={e => setTaskForm({ ...taskForm, scoring: { weights: { ...taskForm.scoring.weights, [key]: Math.max(0, parseInt(e.target.value) || 0) } } })}
                          style={{ width: '100%', backgroundColor: '#0F172A', border: '1px solid #334155', borderRadius: '6px', padding: '6px', color: 'white', outline: 'none', fontSize: '13px' }} />
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', gap: '20px', marginBottom: '20px', flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px' }}>
                  <input type="checkbox" checked={taskForm.use_ai !== false} onChange={e => setTaskForm({ ...taskForm, use_ai: e.target.checked })} />
                  AI-обогащение (ЛПР, размер бизнеса через Gemini)
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px' }}>
                  <input type="checkbox" checked={taskForm.use_geocode !== false} onChange={e => setTaskForm({ ...taskForm, use_geocode: e.target.checked })} />
                  Геокодинг адресов (Nominatim)
                </label>
              </div>

              <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
                <button onClick={() => setTaskForm(null)} style={{ backgroundColor: '#334155', border: 'none', borderRadius: '6px', padding: '8px 16px', color: 'white', cursor: 'pointer' }}>Отмена</button>
                <button onClick={handleSaveTask} style={{ backgroundColor: '#3B82F6', border: 'none', borderRadius: '6px', padding: '8px 16px', color: 'white', cursor: 'pointer', fontWeight: '600' }}>Сохранить задачу</button>
              </div>
            </div>
          )}

          {searchTasks.length === 0 ? (
            <div style={{ padding: '40px', textAlign: 'center', color: '#64748B' }}>Задач поиска пока нет. Создайте первую — задайте, что и где искать.</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '16px' }}>
              {searchTasks.map(task => {
                const statusStyle: any = {
                  draft: { bg: '#334155', color: '#94A3B8', text: 'Черновик' },
                  running: { bg: '#1E3A5F', color: '#93C5FD', text: 'Выполняется...' },
                  done: { bg: '#14532D', color: '#86EFAC', text: 'Выполнена' },
                  error: { bg: '#7F1D1D', color: '#FCA5A5', text: 'Ошибка' }
                }
                const st = statusStyle[task.status] || statusStyle.draft
                return (
                  <div key={task.id} style={{ backgroundColor: '#0F172A', border: '1px solid #334155', borderRadius: '12px', padding: '16px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px' }}>
                      <div style={{ fontWeight: '600', fontSize: '15px' }}>{task.name}</div>
                      <span style={{ backgroundColor: st.bg, color: st.color, padding: '3px 10px', borderRadius: '10px', fontSize: '11px', whiteSpace: 'nowrap' }}>{st.text}</span>
                    </div>
                    <div style={{ color: '#94A3B8', fontSize: '12px', marginBottom: '4px' }}>{task.city} · {task.industry} · до {task.limit} компаний</div>
                    <div style={{ color: '#64748B', fontSize: '12px', marginBottom: '10px' }}>
                      {task.scoring ? 'Индивидуальные веса скоринга' : 'Скоринг по scoring_config.json'}
                      {task.use_ai === false ? ' · без AI' : ''}{task.use_geocode === false ? ' · без геокодинга' : ''}
                    </div>
                    {task.last_run && (
                      <div style={{ color: '#64748B', fontSize: '12px', marginBottom: '10px' }}>
                        Последний запуск: {new Date(task.last_run).toLocaleString('ru-RU')} — найдено {task.leads_found ?? 0}, добавлено {task.leads_added ?? 0}
                        {task.last_error ? <div style={{ color: '#FCA5A5' }}>{task.last_error}</div> : null}
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                      <button onClick={() => handleRunTask(task)} disabled={isPipelineRunning} style={{ backgroundColor: isPipelineRunning ? '#334155' : '#10B981', border: 'none', borderRadius: '6px', padding: '7px 14px', color: 'white', cursor: isPipelineRunning ? 'not-allowed' : 'pointer', fontSize: '12px', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <Search size={13} /> Запустить
                      </button>
                      <button onClick={() => setActiveTab('table')} style={{ backgroundColor: '#334155', border: 'none', borderRadius: '6px', padding: '7px 14px', color: 'white', cursor: 'pointer', fontSize: '12px' }}>К лидам</button>
                      <button onClick={() => setTaskForm({ ...task, scoring: task.scoring || null })} style={{ backgroundColor: '#334155', border: 'none', borderRadius: '6px', padding: '7px 14px', color: 'white', cursor: 'pointer', fontSize: '12px' }}>Изменить</button>
                      <button onClick={() => handleDeleteTask(task)} style={{ backgroundColor: '#7F1D1D', border: 'none', borderRadius: '6px', padding: '7px 14px', color: 'white', cursor: 'pointer', fontSize: '12px' }}>Удалить</button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

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
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '12px', flexWrap: 'wrap', gap: '8px' }}>
              <div style={{ fontSize: '13px', color: '#94A3B8' }}>Найдено: {filteredLeads.length} из {leads.length} лидов</div>
              <button onClick={handleExportCSV} style={{ backgroundColor: '#334155', border: '1px solid #475569', borderRadius: '6px', padding: '6px 14px', color: 'white', cursor: 'pointer', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Download size={13} /> Экспорт CSV
              </button>
            </div>
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
                        <div style={{ color: '#64748B', fontSize: '12px', marginBottom: '4px' }}>{lead.city}</div>
                        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                          {lead.search_task_name && (
                            <span style={{ backgroundColor: '#3B2F5B', color: '#C4B5FD', padding: '2px 6px', borderRadius: '4px', fontSize: '11px' }} title={`Задача поиска: ${lead.search_task_name}`}>🔍 {lead.search_task_name}</span>
                          )}
                          {lead.business_size && lead.business_size !== 'unknown' && (
                            <span style={{ backgroundColor: '#1E3A5F', color: '#93C5FD', padding: '2px 6px', borderRadius: '4px', fontSize: '11px' }}>
                              {{ small: 'Малый бизнес', medium: 'Средний бизнес', large: 'Крупный бизнес' }[lead.business_size]}
                            </span>
                          )}
                          {lead.wholesale && (
                            <span style={{ backgroundColor: '#14532D', color: '#86EFAC', padding: '2px 6px', borderRadius: '4px', fontSize: '11px' }}>Опт</span>
                          )}
                        </div>
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
                        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                          <button onClick={() => setSelectedLead(lead)} style={{ backgroundColor: '#3B82F6', border: 'none', borderRadius: '6px', padding: '8px 12px', color: 'white', cursor: 'pointer', fontSize: '12px', fontWeight: '500' }}>Открыть</button>
                          <button onClick={() => handleCopyLetter(lead)} title="Скопировать текст письма" style={{ backgroundColor: '#8B5CF6', border: 'none', borderRadius: '6px', padding: '8px 12px', color: 'white', cursor: 'pointer', fontSize: '12px', fontWeight: '500', display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <Copy size={14} /> Письмо
                          </button>
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
                <div><div style={{ fontSize: '12px', color: '#64748B', marginBottom: '4px' }}>Tier</div><div style={{ display: 'inline-block', backgroundColor: selectedLead.lead_tier === 'A' ? '#10B981' : selectedLead.lead_tier === 'B' ? '#F59E0B' : '#EF4444', padding: '4px 12px', borderRadius: '4px', fontSize: '12px', fontWeight: 'bold' }}>Tier {selectedLead.lead_tier}</div></div>
                <div><div style={{ fontSize: '12px', color: '#64748B', marginBottom: '4px' }}>Размер бизнеса</div><div style={{ fontSize: '14px' }}>{{ small: 'Малый', medium: 'Средний', large: 'Крупный', unknown: 'Не определён' }[selectedLead.business_size || 'unknown']}{selectedLead.wholesale ? ' · опт' : ''}</div></div>
                <div><div style={{ fontSize: '12px', color: '#64748B', marginBottom: '4px' }}>Статус</div><div style={{ fontSize: '14px' }}>{getStatusText(selectedLead.status)}</div></div>
                <div><div style={{ fontSize: '12px', color: '#64748B', marginBottom: '4px' }}>Источник</div><div style={{ fontSize: '14px' }}>{selectedLead.search_task_name || 'Ручной импорт'}</div></div>
              </div>
              {selectedLead.reason && (
                <div style={{ marginTop: '12px', backgroundColor: '#0F172A', borderLeft: '3px solid #3B82F6', padding: '10px 12px', borderRadius: '0 6px 6px 0', fontSize: '13px', color: '#94A3B8' }}>
                  <b style={{ color: '#F8FAFC' }}>Почему этому лиду стоит продавать:</b> {selectedLead.reason}
                </div>
              )}
            </div>

            <div style={{ marginBottom: '24px' }}>
              <h3 style={{ fontSize: '14px', color: '#94A3B8', marginBottom: '12px', textTransform: 'uppercase' }}>Готовность к отправке</h3>
              <div style={{ backgroundColor: '#0F172A', padding: '12px', borderRadius: '8px' }}>
                {[
                  { label: 'ЛПР найден', done: selectedLead.lpr.length > 0 && selectedLead.lpr[0].name !== 'Руководитель' },
                  { label: 'Email есть', done: (selectedLead.lpr_emails || []).length > 0 },
                  { label: 'КП готово', done: Boolean(selectedLead.pdf_file) },
                  { label: 'Текст письма скопирован', done: Boolean(copiedLetters[selectedLead.id]) },
                  { label: 'КП отправлено', done: ['contacted', 'in_progress', 'converted'].includes(selectedLead.status) }
                ].map((item, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0', fontSize: '13px', color: item.done ? '#86EFAC' : '#64748B' }}>
                    <span style={{ width: '16px', textAlign: 'center' }}>{item.done ? '✓' : '○'}</span> {item.label}
                  </div>
                ))}
              </div>
            </div>

            <div style={{ marginBottom: '24px' }}>
              <h3 style={{ fontSize: '14px', color: '#94A3B8', marginBottom: '12px', textTransform: 'uppercase' }}>ЛПР</h3>
              {selectedLead.lpr.map((p, i) => (
                <div key={i} style={{ backgroundColor: '#0F172A', padding: '12px', borderRadius: '8px', marginBottom: '8px' }}>
                  <div style={{ fontWeight: '600', marginBottom: '4px' }}>{p.name}</div>
                  <div style={{ fontSize: '12px', color: '#94A3B8', marginBottom: '8px' }}>{p.position}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '13px', color: '#64748B' }}>{selectedLead.lpr_emails[i]}</span>
                    {selectedLead.lpr_emails[i] && (
                      <>
                        <button onClick={() => handleCopyEmail(selectedLead.lpr_emails[i])} style={{ backgroundColor: '#334155', border: 'none', borderRadius: '4px', padding: '4px 8px', cursor: 'pointer', color: '#94A3B8', fontSize: '11px' }}>Copy</button>
                        <button onClick={handleMailto.bind(null, selectedLead)} title="Открыть в почтовом клиенте" style={{ backgroundColor: '#334155', border: 'none', borderRadius: '4px', padding: '4px 8px', cursor: 'pointer', color: '#94A3B8', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px' }}><Mail size={11} /> В почту</button>
                      </>
                    )}
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

            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <button onClick={() => handleCopyLetter(selectedLead)} style={{ backgroundColor: '#8B5CF6', border: 'none', borderRadius: '6px', padding: '10px 20px', color: 'white', cursor: 'pointer', fontSize: '13px', fontWeight: '500', display: 'flex', alignItems: 'center', gap: '6px' }}><Copy size={14} /> Скопировать письмо</button>
              <button onClick={() => handleMailto(selectedLead)} disabled={!selectedLead.lpr_emails[0]} style={{ backgroundColor: selectedLead.lpr_emails[0] ? '#3B82F6' : '#64748B', border: 'none', borderRadius: '6px', padding: '10px 20px', color: 'white', cursor: 'pointer', fontSize: '13px', fontWeight: '500', display: 'flex', alignItems: 'center', gap: '6px' }}><Send size={14} /> В почту</button>
              <button onClick={() => handleDownloadPDF(selectedLead)} style={{ backgroundColor: selectedLead.pdf_file ? '#10B981' : '#64748B', border: 'none', borderRadius: '6px', padding: '10px 20px', color: 'white', cursor: 'pointer', fontSize: '13px', fontWeight: '500' }}>Скачать КП</button>
              <button onClick={() => handleDeleteLead(selectedLead)} style={{ backgroundColor: '#7F1D1D', border: 'none', borderRadius: '6px', padding: '10px 20px', color: 'white', cursor: 'pointer', fontSize: '13px', fontWeight: '500' }}>Удалить</button>
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

      {isPipelineRunning && job && (
        <div style={{ position: 'fixed', bottom: '24px', right: '24px', backgroundColor: '#1E293B', border: '1px solid #334155', borderRadius: '12px', padding: '16px 20px', width: '320px', zIndex: 999 }}>
          <div style={{ fontSize: '13px', fontWeight: '600', marginBottom: '8px' }}>{job.message}</div>
          <div style={{ height: '8px', backgroundColor: '#0F172A', borderRadius: '4px', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${Math.min(100, (job.processed / Math.max(job.total, 1)) * 100)}%`, backgroundColor: '#3B82F6', transition: 'width 0.5s' }} />
          </div>
          <div style={{ fontSize: '12px', color: '#64748B', marginTop: '6px' }}>{job.processed} / {job.total}</div>
        </div>
      )}

      {authRequired && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 3000 }}>
          <div style={{ backgroundColor: '#1E293B', borderRadius: '12px', padding: '32px', width: '400px' }}>
            <h2 style={{ marginBottom: '8px' }}>Требуется ключ доступа</h2>
            <p style={{ color: '#94A3B8', fontSize: '13px', marginBottom: '20px' }}>Сервер защищён ключом API. Введите его — он сохранится в этом браузере.</p>
            <input
              type="password"
              value={tokenInput}
              onChange={e => setTokenInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSaveToken() }}
              placeholder="Ключ доступа"
              style={{ width: '100%', backgroundColor: '#0F172A', border: '1px solid #334155', borderRadius: '6px', padding: '10px', color: 'white', outline: 'none', marginBottom: '16px', fontSize: '14px' }}
            />
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
              <button onClick={handleSaveToken} style={{ backgroundColor: '#3B82F6', border: 'none', borderRadius: '6px', padding: '10px 20px', color: 'white', cursor: 'pointer', fontWeight: '600' }}>Войти</button>
            </div>
          </div>
        </div>
      )}

      <div style={{ position: 'fixed', top: '20px', right: '20px', zIndex: 2000, display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {toasts.map(t => (
          <div key={t.id} style={{
            backgroundColor: t.type === 'success' ? '#14532D' : t.type === 'error' ? '#7F1D1D' : '#1E3A5F',
            border: `1px solid ${t.type === 'success' ? '#22C55E' : t.type === 'error' ? '#EF4444' : '#3B82F6'}`,
            borderRadius: '8px', padding: '12px 16px', color: 'white', fontSize: '13px', maxWidth: '360px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.4)'
          }}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  )
}