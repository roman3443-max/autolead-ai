import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import 'leaflet/dist/leaflet.css'
import L from 'leaflet'
import {
  Copy, Send, FileDown, Trash2, Mail, KeyRound, Briefcase, CheckCircle2, Circle,
  Settings2, RefreshCw, Plus,
} from 'lucide-react'

import { API_URL, createApiFetch } from './lib/api'
import { Lead, SearchTask, PipelineJob, Toast, STATUS_META, TIER_META, SIZE_LABELS, SCORING_FIELDS } from './lib/types'
import Sidebar, { TabId } from './components/Sidebar'
import Drawer, { CenterModal } from './components/Drawer'
import ToastStack from './components/ToastStack'
import ProgressWidget from './components/ProgressWidget'
import { ReadinessChecklist } from './pages/SearchPage'
import LeadsPage from './pages/LeadsPage'
import SearchPage from './pages/SearchPage'
import MapPage from './pages/MapPage'
import ManagersPage from './pages/ManagersPage'
import AnalyticsPage from './pages/AnalyticsPage'

delete (L.Icon.Default.prototype as any)._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
})

export default function App() {
  // ---------- данные ----------
  const [activeTab, setActiveTab] = useState<TabId>('table')
  const [leads, setLeads] = useState<Lead[]>([])
  const [managers, setManagers] = useState<any[]>([])
  const [sectors, setSectors] = useState<any[]>([])
  const [analytics, setAnalytics] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [isPipelineRunning, setIsPipelineRunning] = useState(false)
  const [job, setJob] = useState<PipelineJob | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const [toasts, setToasts] = useState<Toast[]>([])
  const [searchTasks, setSearchTasks] = useState<SearchTask[]>([])
  const [taskForm, setTaskForm] = useState<any | null>(null)
  const [scoringCfg, setScoringCfg] = useState<any>(null)
  const [settingsDraft, setSettingsDraft] = useState<any>(null)
  const [copiedLetters, setCopiedLetters] = useState<Record<string, boolean>>(() => {
    if (typeof window === 'undefined') return {}
    try { return JSON.parse(localStorage.getItem('copied_letters') || '{}') } catch { return {} }
  })

  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null)
  const [newComment, setNewComment] = useState('')

  const [supplier, setSupplier] = useState<any>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('supplier_config')
      if (saved) { try { return JSON.parse(saved) } catch { /* ignore */ } }
    }
    return { name: 'УралАвтоОпт', contact: 'Петров И.С.' }
  })
  const [supplierDraft, setSupplierDraft] = useState<any>(supplier)
  const [supplierOpen, setSupplierOpen] = useState(false)

  const [authRequired, setAuthRequired] = useState(false)
  const [tokenInput, setTokenInput] = useState('')

  const apiFetch = useMemo(() => createApiFetch(() => setAuthRequired(true)), [])

  // ---------- toast ----------
  const dismissToast = useCallback((id: number) => setToasts(t => t.filter(x => x.id !== id)), [])
  const toast = useCallback((text: string, type: Toast['type'] = 'info') => {
    const id = Date.now() + Math.random()
    setToasts(t => [...t, { id, text, type }])
    setTimeout(() => dismissToast(id), 5000)
  }, [dismissToast])

  // ---------- загрузка ----------
  const loadData = useCallback(async () => {
    try {
      const [lRes, mRes, sRes, aRes] = await Promise.all([
        apiFetch(`${API_URL}/api/leads`),
        apiFetch(`${API_URL}/api/managers`),
        apiFetch(`${API_URL}/api/sectors`),
        apiFetch(`${API_URL}/api/analytics`)
      ])
      if (lRes.ok) setLeads(await lRes.json())
      if (mRes.ok) setManagers(await mRes.json())
      if (sRes.ok) setSectors(await sRes.json())
      if (aRes.ok) setAnalytics(await aRes.json())
      setLoading(false)
    } catch (e) { console.error('Error loading data:', e); setLoading(false) }
  }, [apiFetch])

  const loadTasks = useCallback(async () => {
    try {
      const res = await apiFetch(`${API_URL}/api/search-tasks`)
      if (res.ok) setSearchTasks(await res.json())
    } catch (e) { console.error('Error loading tasks:', e) }
  }, [apiFetch])

  const loadSupplierConfig = useCallback(async () => {
    try {
      const res = await apiFetch(`${API_URL}/api/supplier-config`)
      if (!res.ok) return
      const cfg = await res.json()
      if (cfg?.name) {
        setSupplier(cfg)
        setSupplierDraft(cfg)
        try { localStorage.setItem('supplier_config', JSON.stringify(cfg)) } catch { /* ignore */ }
      }
    } catch (e) { console.error('Error loading supplier config:', e) }
  }, [apiFetch])

  const loadScoringConfig = useCallback(async () => {
    try {
      const res = await apiFetch(`${API_URL}/api/scoring-config`)
      if (res.ok) setScoringCfg(await res.json())
    } catch (e) { console.error('Error loading scoring config:', e) }
  }, [apiFetch])

  useEffect(() => {
    loadData(); loadTasks(); loadSupplierConfig(); loadScoringConfig()
  }, [loadData, loadTasks, loadSupplierConfig, loadScoringConfig])

  // ---------- пайплайн ----------
  const stopPolling = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } }
  useEffect(() => () => stopPolling(), [])

  const pollJob = (jobId: string) => {
    stopPolling()
    pollRef.current = setInterval(async () => {
      try {
        const res = await apiFetch(`${API_URL}/api/pipeline-status/${jobId}`)
        if (!res.ok) return
        const data: PipelineJob = await res.json()
        setJob(data)
        if (data.status === 'done') {
          stopPolling(); setIsPipelineRunning(false)
          toast(data.message, 'success')
          loadData(); loadTasks()
        } else if (data.status === 'error') {
          stopPolling(); setIsPipelineRunning(false)
          toast(data.error || 'Ошибка пайплайна', 'error')
          loadTasks()
        }
      } catch { /* сервер недоступен — продолжаем опрос */ }
    }, 2000)
  }

  const startJobPolling = async (res: Response) => {
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.jobId) {
      toast(data.error || 'Не удалось запустить поиск', 'error')
      setIsPipelineRunning(false); loadTasks()
      return
    }
    toast(data.alreadyRunning ? 'Поиск уже выполняется, показываю прогресс' : 'Поиск запущен. Это займёт 1–3 минуты...', 'info')
    pollJob(data.jobId)
  }

  const handleRunTask = async (task: SearchTask) => {
    if (isPipelineRunning) { toast('Дождитесь завершения текущего поиска', 'error'); return }
    setIsPipelineRunning(true); setJob(null)
    try {
      const res = await apiFetch(`${API_URL}/api/search-tasks/${task.id}/run`, { method: 'POST' })
      await startJobPolling(res)
    } catch { toast('Ошибка соединения с сервером', 'error'); setIsPipelineRunning(false) }
  }

  // ---------- задачи ----------
  const newTaskDefaults = () => ({
    name: '',
    city: scoringCfg?.searchDefaults?.city || 'Екатеринбург',
    industry: scoringCfg?.searchDefaults?.industry || 'автозапчасти',
    limit: scoringCfg?.searchDefaults?.limit || 5,
    scoring: null, use_ai: true, use_geocode: true,
  })

  const handleSaveTask = async () => {
    if (!taskForm) return
    try {
      const isNew = !taskForm.id
      const res = await apiFetch(isNew ? `${API_URL}/api/search-tasks` : `${API_URL}/api/search-tasks/${taskForm.id}`, {
        method: isNew ? 'POST' : 'PUT',
        body: JSON.stringify({
          name: taskForm.name, city: taskForm.city, industry: taskForm.industry,
          limit: taskForm.limit, scoring: taskForm.scoring || null,
          use_ai: taskForm.use_ai !== false, use_geocode: taskForm.use_geocode !== false,
        })
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { toast(data.error || 'Не удалось сохранить задачу', 'error'); return }
      toast(isNew ? 'Задача поиска создана' : 'Задача обновлена', 'success')
      setTaskForm(null); loadTasks()
    } catch { toast('Ошибка соединения с сервером', 'error') }
  }

  const handleDeleteTask = async (task: SearchTask) => {
    if (!window.confirm(`Удалить задачу "${task.name}"?`)) return
    try {
      await apiFetch(`${API_URL}/api/search-tasks/${task.id}`, { method: 'DELETE' })
      toast('Задача удалена', 'success'); loadTasks()
    } catch { toast('Ошибка соединения с сервером', 'error') }
  }

  // ---------- настройки скоринга ----------
  const openSettings = () => {
    const d = scoringCfg || {}
    setSettingsDraft({
      weights: { lpr: 25, emails: 15, brands: 20, businessSize: 15, wholesale: 10, content: 15, ...(d.weights || {}) },
      tiers: { a: 75, b: 50, ...(d.tiers || {}) },
      retailPenalty: typeof d.retailPenalty === 'number' ? d.retailPenalty : 15,
      city: d.searchDefaults?.city || 'Екатеринбург',
      industry: d.searchDefaults?.industry || 'автозапчасти',
      limit: d.searchDefaults?.limit || 5,
    })
  }

  const handleSaveSettings = async () => {
    if (!settingsDraft) return
    try {
      const res = await apiFetch(`${API_URL}/api/scoring-config`, {
        method: 'PUT',
        body: JSON.stringify({
          weights: settingsDraft.weights,
          tiers: settingsDraft.tiers,
          retailPenalty: settingsDraft.retailPenalty,
          searchDefaults: { city: settingsDraft.city, industry: settingsDraft.industry, limit: settingsDraft.limit },
        })
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { toast(data.error || 'Не удалось сохранить настройки', 'error'); return }
      setScoringCfg((prev: any) => ({ ...(prev || {}), ...data }))
      setSettingsDraft(null)
      toast('Настройки скоринга и поиска сохранены', 'success')
    } catch { toast('Ошибка соединения с сервером', 'error') }
  }

  const handleRescoreAll = async () => {
    try {
      const res = await apiFetch(`${API_URL}/api/leads/rescore`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        toast(`Пересчитано ${data.rescored} лидов: A=${data.distribution.A}, B=${data.distribution.B}, C=${data.distribution.C}`, 'success')
        loadData()
      } else toast('Не удалось пересчитать лида', 'error')
    } catch { toast('Ошибка соединения с сервером', 'error') }
  }

  // ---------- лиды ----------
  const handleStatusChange = async (leadId: string, newStatus: string) => {
    const lead = leads.find(l => l.id === leadId)
    try {
      await apiFetch(`${API_URL}/api/leads/${leadId}`, {
        method: 'PUT',
        body: JSON.stringify({
          status: newStatus,
          status_history: [...(lead?.status_history || []), { status: newStatus, date: new Date().toLocaleString('ru-RU') }]
        })
      })
      loadData()
      if (selectedLead?.id === leadId) setSelectedLead({ ...selectedLead, status: newStatus })
    } catch { toast('Ошибка соединения с сервером', 'error') }
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
      supplier.name,
    ].join('\n')
    return { subject, body }
  }

  const markLetterCopied = (id: string) => {
    setCopiedLetters(c => {
      const next = { ...c, [id]: true }
      try { localStorage.setItem('copied_letters', JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
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
      } else toast('Файл КП не найден на сервере', 'error')
    } catch { toast('Ошибка скачивания КП', 'error') }
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
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(url)
      toast(`Выгружено ${leads.length} лидов в CSV`, 'success')
    } catch { toast('Ошибка соединения с сервером', 'error') }
  }

  const handleDeleteLead = async (lead: Lead) => {
    if (!window.confirm(`Удалить лид «${lead.company_name}»? Действие необратимо.`)) return
    try {
      const res = await apiFetch(`${API_URL}/api/leads/${lead.id}`, { method: 'DELETE' })
      if (res.ok) { toast('Лид удалён', 'success'); setSelectedLead(null); loadData() }
      else toast('Не удалось удалить лид', 'error')
    } catch { toast('Ошибка соединения с сервером', 'error') }
  }

  const handleAddComment = async () => {
    if (!newComment.trim() || !selectedLead) return
    const comments = [...(selectedLead.comments || []), newComment]
    try {
      await apiFetch(`${API_URL}/api/leads/${selectedLead.id}`, {
        method: 'PUT',
        body: JSON.stringify({ comments })
      })
      setNewComment('')
      setSelectedLead({ ...selectedLead, comments })
      loadData()
    } catch { toast('Ошибка соединения с сервером', 'error') }
  }

  // ---------- поставщик ----------
  const handleSaveSupplier = async () => {
    setSupplier(supplierDraft)
    try { localStorage.setItem('supplier_config', JSON.stringify(supplierDraft)) } catch { /* ignore */ }
    setSupplierOpen(false)
    try {
      await apiFetch(`${API_URL}/api/supplier-config`, {
        method: 'PUT',
        body: JSON.stringify({ name: supplierDraft.name, contact: supplierDraft.contact })
      })
      toast('Данные поставщика обновлены', 'success')
    } catch { toast('Сохранено локально, но сервер недоступен', 'error') }
  }

  const handleSaveToken = () => {
    if (!tokenInput.trim()) return
    localStorage.setItem('api_token', tokenInput.trim())
    setAuthRequired(false); setTokenInput('')
    loadData(); loadTasks()
  }

  // ---------- фильтр ----------
  const filteredLeads = useMemo(() => leads.filter(l => {
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
  }), [leads, searchQuery, statusFilter])

  const TITLES: Record<TabId, string> = {
    search: 'Поиск лидов', table: 'Работа с лидами', map: 'Карта и сектора',
    managers: 'Менеджеры', analytics: 'Аналитика',
  }

  const checklist = selectedLead ? [
    { label: 'ЛПР найден', done: selectedLead.lpr.length > 0 && selectedLead.lpr[0].name !== 'Руководитель' },
    { label: 'Email есть', done: (selectedLead.lpr_emails || []).length > 0 },
    { label: 'КП готово', done: Boolean(selectedLead.pdf_file) },
    { label: 'Текст письма скопирован', done: Boolean(copiedLetters[selectedLead.id]) },
    { label: 'КП отправлено', done: ['contacted', 'in_progress', 'converted'].includes(selectedLead.status) },
  ] : []

  const sm = selectedLead ? (STATUS_META[selectedLead.status] || STATUS_META.new) : STATUS_META.new
  const tm = selectedLead ? (TIER_META[selectedLead.lead_tier] || TIER_META.C) : TIER_META.C

  return (
    <div className="min-h-screen md:flex">
      <Sidebar active={activeTab} onChange={setActiveTab} pipelineRunning={isPipelineRunning} />

      <main className="flex-1 min-w-0 px-4 md:px-8 py-5 md:py-7">
        {/* Верхняя панель */}
        <div className="hidden md:flex items-center justify-between gap-4 mb-7">
          <h1 className="text-2xl font-extrabold text-white tracking-tight">{TITLES[activeTab]}</h1>
          <button
            onClick={() => { setSupplierDraft(supplier); setSupplierOpen(true) }}
            className="btn-ghost !py-2"
          >
            <Briefcase size={14} />
            <span className="max-w-[220px] truncate">Поставщик: {supplier.name}</span>
          </button>
        </div>

        {activeTab === 'search' && (
          <SearchPage
            tasks={searchTasks}
            isPipelineRunning={isPipelineRunning}
            scoringCfg={scoringCfg}
            onNewTask={() => setTaskForm(newTaskDefaults())}
            onRunTask={handleRunTask}
            onEditTask={(t) => setTaskForm({ ...t, scoring: t.scoring || null })}
            onDeleteTask={handleDeleteTask}
            onGoLeads={() => setActiveTab('table')}
            onOpenSettings={openSettings}
          />
        )}
        {activeTab === 'table' && (
          <LeadsPage
            leads={leads}
            loading={loading}
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            statusFilter={statusFilter}
            setStatusFilter={setStatusFilter}
            filteredLeads={filteredLeads}
            onOpenLead={setSelectedLead}
            onCopyLetter={handleCopyLetter}
            onDownloadPDF={handleDownloadPDF}
            onExportCSV={handleExportCSV}
            onStatusChange={handleStatusChange}
          />
        )}
        {activeTab === 'map' && <MapPage leads={leads} sectors={sectors} managers={managers} />}
        {activeTab === 'managers' && <ManagersPage managers={managers} analytics={analytics} />}
        {activeTab === 'analytics' && <AnalyticsPage analytics={analytics} leads={leads} loading={loading} />}
      </main>

      {/* Drawer лида */}
      <Drawer open={Boolean(selectedLead)} onClose={() => setSelectedLead(null)} title={selectedLead?.company_name}>
        {selectedLead && (
          <div className="space-y-7">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              {[
                ['Сайт', selectedLead.domain],
                ['Город', selectedLead.city],
                ['Lead Score', String(selectedLead.lead_score)],
              ].map(([k, v]) => (
                <div key={k}>
                  <div className="label">{k}</div>
                  <div className="text-sm font-semibold text-slate-100">{v}</div>
                </div>
              ))}
              <div>
                <div className="label">Tier</div>
                <span className={`chip ${tm.bg} ${tm.color} !px-2.5 !py-1`}>Tier {selectedLead.lead_tier}</span>
              </div>
              <div>
                <div className="label">Статус</div>
                <select
                  value={selectedLead.status}
                  onChange={e => handleStatusChange(selectedLead.id, e.target.value)}
                  className={`input !w-auto !py-1.5 !px-2.5 text-[12px] font-semibold !bg-ink-800 ${sm.color}`}
                >
                  {Object.entries(STATUS_META).map(([id, m]) => <option key={id} value={id}>{m.label}</option>)}
                </select>
              </div>
              <div>
                <div className="label">Размер бизнеса</div>
                <div className="text-sm text-slate-200">
                  {SIZE_LABELS[selectedLead.business_size || 'unknown']}{selectedLead.wholesale ? ' · опт' : ''}
                </div>
              </div>
              <div className="col-span-2 sm:col-span-3">
                <div className="label">Источник</div>
                <div className="text-sm text-slate-200">{selectedLead.search_task_name || 'Ручной импорт'}</div>
              </div>
            </div>

            {selectedLead.reason && (
              <div className="rounded-xl border-l-2 border-indigo-500 bg-indigo-500/5 px-4 py-3">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-indigo-300 mb-1">Почему этому лиду стоит продавать</div>
                <div className="text-[13px] text-slate-300 leading-relaxed">{selectedLead.reason}</div>
              </div>
            )}

            <div>
              <div className="label">Готовность к отправке</div>
              <div className="card !bg-ink-800/60 px-4 py-3">
                <ReadinessChecklist items={checklist} />
              </div>
            </div>

            <div>
              <div className="label">ЛПР</div>
              <div className="space-y-2">
                {selectedLead.lpr.map((person, i) => (
                  <div key={i} className="card !bg-ink-800/60 p-3.5">
                    <div className="font-semibold text-slate-100 text-sm">{person.name}</div>
                    <div className="text-[12px] text-slate-500 mb-2">{person.position}</div>
                    {selectedLead.lpr_emails[i] && (
                      <div className="flex items-center gap-2 flex-wrap">
                        <Mail size={12} className="text-slate-600" />
                        <span className="text-[13px] text-slate-300">{selectedLead.lpr_emails[i]}</span>
                        <button
                          onClick={() => { navigator.clipboard.writeText(selectedLead.lpr_emails[i]); toast('Email скопирован', 'success') }}
                          className="text-slate-600 hover:text-white transition-colors" title="Скопировать email"
                        >
                          <Copy size={12} />
                        </button>
                        <button
                          onClick={() => handleMailto(selectedLead)}
                          className="chip bg-indigo-500/15 text-indigo-300 hover:bg-indigo-500/25 transition-colors ml-auto"
                        >
                          <Send size={11} /> В почту
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div>
              <div className="label">Бренды</div>
              <div className="flex flex-wrap gap-1.5">
                {selectedLead.brands.map((b, i) => (
                  <span key={i} className="chip bg-ink-700 text-slate-300 !px-2.5 !py-1">{b}</span>
                ))}
              </div>
            </div>

            <div>
              <div className="label">История статусов</div>
              <div className="card !bg-ink-800/60 divide-y divide-line max-h-44 overflow-y-auto">
                {(selectedLead.status_history || []).map((item, i) => {
                  const m = STATUS_META[item.status] || STATUS_META.new
                  return (
                    <div key={i} className="flex items-center justify-between px-4 py-2.5 text-[13px]">
                      <span className={`flex items-center gap-2 ${m.color}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${m.dot}`} />
                        {m.label}
                      </span>
                      <span className="text-slate-500 text-[12px]">{item.date}</span>
                    </div>
                  )
                })}
              </div>
            </div>

            <div>
              <div className="label">Комментарии</div>
              <div className="space-y-2 mb-3 max-h-44 overflow-y-auto">
                {(selectedLead.comments || []).length === 0 && (
                  <div className="text-slate-600 text-sm italic">Нет комментариев</div>
                )}
                {(selectedLead.comments || []).map((c, i) => (
                  <div key={i} className="card !bg-ink-800/60 px-3.5 py-2.5 text-[13px] text-slate-300">{c}</div>
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  value={newComment}
                  onChange={e => setNewComment(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleAddComment() }}
                  placeholder="Новый комментарий..."
                  className="input"
                />
                <button onClick={handleAddComment} className="btn-primary shrink-0 !px-4">Добавить</button>
              </div>
            </div>

            <div className="flex gap-2.5 flex-wrap pt-2 border-t border-line">
              <button onClick={() => handleCopyLetter(selectedLead)} className="btn-primary text-[13px]">
                <Copy size={14} /> Скопировать письмо
              </button>
              <button
                onClick={() => handleMailto(selectedLead)}
                disabled={!selectedLead.lpr_emails[0]}
                className="btn-ghost text-[13px]"
                title="Открыть в почтовом клиенте"
              >
                <Send size={14} /> В почту
              </button>
              <button
                onClick={() => handleDownloadPDF(selectedLead)}
                disabled={!selectedLead.pdf_file}
                className="btn-ghost text-[13px]"
              >
                <FileDown size={14} /> {selectedLead.pdf_file ? 'Открыть КП' : 'КП нет'}
              </button>
              <button onClick={() => handleDeleteLead(selectedLead)} className="btn-danger text-[13px] ml-auto">
                <Trash2 size={14} /> Удалить
              </button>
            </div>
          </div>
        )}
      </Drawer>

      {/* Форма задачи */}
      <CenterModal open={Boolean(taskForm)} onClose={() => setTaskForm(null)} title={taskForm?.id ? 'Редактирование задачи' : 'Новая задача поиска'} width="max-w-2xl">
        {taskForm && (
          <div className="space-y-5">
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="sm:col-span-2">
                <label className="label">Название задачи</label>
                <input value={taskForm.name} onChange={e => setTaskForm({ ...taskForm, name: e.target.value })} placeholder="Напр.: Опт Екб — крупные сети" className="input" />
              </div>
              <div>
                <label className="label">Город</label>
                <input value={taskForm.city} onChange={e => setTaskForm({ ...taskForm, city: e.target.value })} className="input" />
              </div>
              <div>
                <label className="label">Отрасль</label>
                <input value={taskForm.industry} onChange={e => setTaskForm({ ...taskForm, industry: e.target.value })} className="input" />
              </div>
              <div>
                <label className="label">Сколько компаний (1–20)</label>
                <input type="number" min={1} max={20} value={taskForm.limit} onChange={e => setTaskForm({ ...taskForm, limit: Math.min(20, Math.max(1, parseInt(e.target.value) || 5)) })} className="input" />
              </div>
            </div>

            <div>
              <label className="flex items-center gap-2.5 cursor-pointer text-sm text-slate-300 select-none">
                <input
                  type="checkbox"
                  checked={taskForm.scoring !== null}
                  onChange={e => setTaskForm({ ...taskForm, scoring: e.target.checked ? { weights: { lpr: 25, emails: 15, brands: 20, businessSize: 15, wholesale: 10, content: 15 } } : null })}
                />
                Индивидуальные веса скоринга (иначе — глобальный конфиг)
              </label>
              {taskForm.scoring && (
                <div className="grid grid-cols-3 sm:grid-cols-6 gap-3 mt-3 card !bg-ink-800/60 p-4">
                  {SCORING_FIELDS.map(([key, label]) => (
                    <div key={key}>
                      <label className="label !mb-1">{label}</label>
                      <input
                        type="number" min={0} max={100}
                        value={taskForm.scoring.weights[key]}
                        onChange={e => setTaskForm({ ...taskForm, scoring: { weights: { ...taskForm.scoring.weights, [key]: Math.max(0, parseInt(e.target.value) || 0) } } })}
                        className="input !px-2.5 !py-1.5 text-[13px]"
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex gap-6 flex-wrap">
              <label className="flex items-center gap-2.5 cursor-pointer text-sm text-slate-300 select-none">
                <input type="checkbox" checked={taskForm.use_ai !== false} onChange={e => setTaskForm({ ...taskForm, use_ai: e.target.checked })} />
                AI-обогащение (Gemini)
              </label>
              <label className="flex items-center gap-2.5 cursor-pointer text-sm text-slate-300 select-none">
                <input type="checkbox" checked={taskForm.use_geocode !== false} onChange={e => setTaskForm({ ...taskForm, use_geocode: e.target.checked })} />
                Геокодинг (Nominatim)
              </label>
            </div>

            <div className="flex justify-end gap-2.5 pt-2">
              <button onClick={() => setTaskForm(null)} className="btn-ghost">Отмена</button>
              <button onClick={handleSaveTask} className="btn-primary">Сохранить задачу</button>
            </div>
          </div>
        )}
      </CenterModal>

      {/* Настройки скоринга */}
      <CenterModal open={Boolean(settingsDraft)} onClose={() => setSettingsDraft(null)} title="Глобальные настройки скоринга и поиска" width="max-w-2xl">
        {settingsDraft && (
          <div className="space-y-5">
            <div>
              <div className="label">Что и где искать по умолчанию</div>
              <div className="grid sm:grid-cols-3 gap-3">
                <input value={settingsDraft.city} onChange={e => setSettingsDraft({ ...settingsDraft, city: e.target.value })} className="input" placeholder="Город" />
                <input value={settingsDraft.industry} onChange={e => setSettingsDraft({ ...settingsDraft, industry: e.target.value })} className="input" placeholder="Отрасль" />
                <input type="number" min={1} max={20} value={settingsDraft.limit} onChange={e => setSettingsDraft({ ...settingsDraft, limit: Math.min(20, Math.max(1, parseInt(e.target.value) || 5)) })} className="input" placeholder="Лимит" />
              </div>
            </div>

            <div>
              <div className="label">Веса скоринга (сумма 100)</div>
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
                {SCORING_FIELDS.map(([key, label]) => (
                  <div key={key}>
                    <label className="label !mb-1">{label}</label>
                    <input
                      type="number" min={0} max={100}
                      value={settingsDraft.weights[key]}
                      onChange={e => setSettingsDraft({ ...settingsDraft, weights: { ...settingsDraft.weights, [key]: Math.max(0, parseInt(e.target.value) || 0) } })}
                      className="input !px-2.5 !py-1.5 text-[13px]"
                    />
                  </div>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="label !mb-1">Штраф за розницу</label>
                <input type="number" min={0} max={100} value={settingsDraft.retailPenalty} onChange={e => setSettingsDraft({ ...settingsDraft, retailPenalty: Math.max(0, parseInt(e.target.value) || 0) })} className="input !px-2.5 !py-1.5 text-[13px]" />
              </div>
              <div>
                <label className="label !mb-1">Tier A (≥)</label>
                <input type="number" min={0} max={100} value={settingsDraft.tiers.a} onChange={e => setSettingsDraft({ ...settingsDraft, tiers: { ...settingsDraft.tiers, a: Math.max(0, parseInt(e.target.value) || 0) } })} className="input !px-2.5 !py-1.5 text-[13px]" />
              </div>
              <div>
                <label className="label !mb-1">Tier B (≥)</label>
                <input type="number" min={0} max={100} value={settingsDraft.tiers.b} onChange={e => setSettingsDraft({ ...settingsDraft, tiers: { ...settingsDraft.tiers, b: Math.max(0, parseInt(e.target.value) || 0) } })} className="input !px-2.5 !py-1.5 text-[13px]" />
              </div>
            </div>

            <p className="text-[12px] text-slate-500">Параметры используются всеми задачами без индивидуальных весов. «Пересчитать лидов» применит настройки к уже найденным лидам.</p>

            <div className="flex justify-end gap-2.5 flex-wrap">
              <button onClick={handleRescoreAll} className="btn-ghost !text-violet-300">
                <RefreshCw size={14} /> Пересчитать лидов
              </button>
              <button onClick={() => setSettingsDraft(null)} className="btn-ghost">Отмена</button>
              <button onClick={handleSaveSettings} className="btn-primary">Сохранить</button>
            </div>
          </div>
        )}
      </CenterModal>

      {/* Настройки поставщика */}
      <CenterModal open={supplierOpen} onClose={() => setSupplierOpen(false)} title="Настройки поставщика" width="max-w-md">
        <div className="space-y-4">
          <div>
            <label className="label">Название компании</label>
            <input value={supplierDraft.name || ''} onChange={e => setSupplierDraft({ ...supplierDraft, name: e.target.value })} className="input" />
          </div>
          <div>
            <label className="label">Контактное лицо</label>
            <input value={supplierDraft.contact || ''} onChange={e => setSupplierDraft({ ...supplierDraft, contact: e.target.value })} className="input" />
          </div>
          <div className="flex justify-end gap-2.5 pt-1">
            <button onClick={() => setSupplierOpen(false)} className="btn-ghost">Отмена</button>
            <button onClick={handleSaveSupplier} className="btn-primary">Сохранить</button>
          </div>
        </div>
      </CenterModal>

      {/* Авторизация по ключу */}
      {authRequired && (
        <div className="fixed inset-0 z-[3000] bg-black/85 backdrop-blur flex items-center justify-center p-4">
          <div className="card w-full max-w-sm p-7 animate-fade-up">
            <div className="w-12 h-12 rounded-2xl bg-indigo-500/15 flex items-center justify-center mb-4">
              <KeyRound size={22} className="text-indigo-300" />
            </div>
            <h2 className="text-lg font-extrabold text-white">Требуется ключ доступа</h2>
            <p className="text-[13px] text-slate-500 mt-1.5 mb-5">Сервер защищён ключом API. Введите его — ключ сохранится в этом браузере.</p>
            <input
              type="password"
              value={tokenInput}
              onChange={e => setTokenInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSaveToken() }}
              placeholder="Ключ доступа"
              className="input mb-4"
              autoFocus
            />
            <button onClick={handleSaveToken} className="btn-primary w-full">Войти</button>
          </div>
        </div>
      )}

      <ProgressWidget job={isPipelineRunning ? job : null} />
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  )
}
