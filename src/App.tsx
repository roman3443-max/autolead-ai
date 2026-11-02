import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import 'leaflet/dist/leaflet.css'
import L from 'leaflet'
import {
  Copy, Send, FileDown, Trash2, Mail, KeyRound, Briefcase, CheckCircle2, Circle,
  Settings2, RefreshCw, Plus, Upload,
} from 'lucide-react'

import { API_URL, createApiFetch, setToken, getToken } from './lib/api'
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

function parseOfferRows(raw: any): any[] {
  const rows = Array.isArray(raw) ? raw : raw?.items
  if (!Array.isArray(rows)) throw new Error('В файле не найден список товаров')
  if (rows.length > 1000) throw new Error('Загружайте не более 1000 позиций за раз')
  return rows.map((item: any, index: number) => {
    const rawPrice = String(item.price ?? item.цена ?? '').trim()
    const price = rawPrice ? Number(rawPrice.replace(/[^\d,.-]/g, '').replace(',', '.')) : Number.NaN
    const stock = Number(String(item.stock ?? item.остаток ?? 0).replace(/[^\d,.-]/g, '').replace(',', '.'))
    const normalized = {
      brand: String(item.brand ?? item.бренд ?? '').trim(),
      sku: String(item.sku ?? item.article ?? item.артикул ?? '').trim(),
      name: String(item.name ?? item.product ?? item.наименование ?? '').trim(),
      car: String(item.car ?? item.fitment ?? item.применяемость ?? '').trim(),
      price,
      stock: Number.isFinite(stock) ? stock : 0,
    }
    if (!normalized.brand || !normalized.name || !Number.isFinite(price) || price < 0) {
      throw new Error(`Проверьте строку ${index + 1}: нужны бренд, наименование и цена`)
    }
    return normalized
  })
}

function parseOfferCsv(text: string): any[] {
  const input = text.replace(/^\uFEFF/, '')
  const firstLine = input.split(/\r?\n/, 1)[0] || ''
  const delimiter = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : (firstLine.includes('\t') ? '\t' : ',')
  const rows: string[][] = []
  let row: string[] = [], cell = '', quoted = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === '"' && quoted && input[i + 1] === '"') { cell += '"'; i++; continue }
    if (ch === '"') { quoted = !quoted; continue }
    if (!quoted && ch === delimiter) { row.push(cell); cell = ''; continue }
    if (!quoted && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && input[i + 1] === '\n') i++
      row.push(cell); cell = ''
      if (row.some(value => value.trim())) rows.push(row)
      row = []; continue
    }
    cell += ch
  }
  row.push(cell)
  if (row.some(value => value.trim())) rows.push(row)
  if (rows.length < 2) throw new Error('CSV должен содержать заголовок и хотя бы одну строку товара')
  const headers = rows[0].map(value => value.trim().toLowerCase())
  const find = (record: string[], aliases: string[]) => {
    const index = headers.findIndex(header => aliases.includes(header))
    return index < 0 ? '' : record[index] || ''
  }
  return parseOfferRows(rows.slice(1).map(record => ({
    brand: find(record, ['brand', 'бренд']),
    sku: find(record, ['sku', 'article', 'артикул', 'код']),
    name: find(record, ['name', 'product', 'наименование', 'товар']),
    car: find(record, ['car', 'fitment', 'применяемость', 'автомобиль']),
    price: find(record, ['price', 'цена']),
    stock: find(record, ['stock', 'остаток', 'количество']),
  })))
}

async function readOfferFile(file: File): Promise<any[]> {
  const text = await file.text()
  if (file.name.toLowerCase().endsWith('.json')) return parseOfferRows(JSON.parse(text))
  return parseOfferCsv(text)
}
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
  const [kpGeneratingId, setKpGeneratingId] = useState<string | null>(null)
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
  const [leadEditMode, setLeadEditMode] = useState(false)
  const [leadEditDraft, setLeadEditDraft] = useState<any>(null)
  const [leadSaveBusy, setLeadSaveBusy] = useState(false)
  const [newComment, setNewComment] = useState('')

  const [supplier, setSupplier] = useState<any>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('supplier_config')
      if (saved) { try { return JSON.parse(saved) } catch { /* ignore */ } }
    }
    return { name: 'УралАвтоОпт', contact: 'Петров И.С.', catalogItems: [] }
  })
  const [supplierDraft, setSupplierDraft] = useState<any>(supplier)
  const [supplierOpen, setSupplierOpen] = useState(false)

  const [authRequired, setAuthRequired] = useState(() => typeof window !== 'undefined' && !getToken())
  const [loginEmail, setLoginEmail] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [loginBusy, setLoginBusy] = useState(false)
  const [user, setUser] = useState<any>(() => {
    if (typeof window === 'undefined') return null
    try { return JSON.parse(localStorage.getItem('auth_user') || 'null') } catch { return null }
  })

  const apiFetch = useMemo(() => createApiFetch(() => setAuthRequired(true)), [])

  const handleLogin = async () => {
    if (!loginEmail.trim() || !loginPassword) {
      toast('Введите email и пароль', 'error')
      return
    }
    setLoginBusy(true)
    try {
      const res = await fetch(`${API_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: loginEmail.trim().toLowerCase(), password: loginPassword })
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast(data.error || 'Неверный email или пароль', 'error')
        return
      }
      setToken(data.token)
      setUser(data.user)
      localStorage.setItem('auth_user', JSON.stringify(data.user))
      setAuthRequired(false)
      setLoginPassword('')
      toast(`Добро пожаловать, ${data.user.name || data.user.email}`, 'success')
      loadData(); loadTasks(); loadSupplierConfig(); loadScoringConfig()
    } catch {
      toast('Ошибка соединения с сервером', 'error')
    } finally {
      setLoginBusy(false)
    }
  }

  const handleLogout = () => {
    setToken('')
    setUser(null)
    localStorage.removeItem('auth_user')
    setAuthRequired(true)
  }

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
          setActiveTab('table')
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
    const status_history = [...(lead?.status_history || []), { status: newStatus, date: new Date().toLocaleString('ru-RU') }]
    try {
      const res = await apiFetch(`${API_URL}/api/leads/${leadId}`, {
        method: 'PUT',
        body: JSON.stringify({ status: newStatus, status_history })
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { toast(data.error || 'Не удалось изменить этап', 'error'); return }
      loadData()
      if (selectedLead?.id === leadId) setSelectedLead({ ...selectedLead, status: newStatus, status_history })
    } catch { toast('Ошибка соединения с сервером', 'error') }
  }

  const handleOpenLead = (lead: Lead) => {
    setLeadEditMode(false)
    setLeadEditDraft(null)
    setSelectedLead(lead)
  }

  const beginLeadEdit = (lead: Lead) => {
    setLeadEditDraft({
      company_name: lead.company_name || '', domain: lead.domain || '', city: lead.city || '',
      industry: lead.industry || '', address: lead.address || '', phone: lead.phone || '',
      emails: (lead.lpr_emails || []).join('; '), brands: (lead.brands || []).join('; '),
      lprName: lead.lpr?.[0]?.name || '', lprPosition: lead.lpr?.[0]?.position || '',
    })
    setLeadEditMode(true)
  }

  const handleSaveLeadDetails = async () => {
    if (!selectedLead || !leadEditDraft) return
    const company_name = String(leadEditDraft.company_name || '').trim()
    if (company_name.length < 2) { toast('Укажите название компании', 'error'); return }
    const emails = [...new Set(String(leadEditDraft.emails || '').split(/[;,|\n]/).map((value: string) => value.trim().toLowerCase()).filter(Boolean))]
    if (emails.some((email: string) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
      toast('Проверьте формат email или разделите адреса точкой с запятой', 'error')
      return
    }
    const brands = [...new Set(String(leadEditDraft.brands || '').split(/[;,|\n]/).map((value: string) => value.trim()).filter(Boolean))]
    const lprName = String(leadEditDraft.lprName || '').trim()
    const lprPosition = String(leadEditDraft.lprPosition || '').trim()
    const previousLpr = selectedLead.lpr?.[0]
    const sameLpr = previousLpr?.name === lprName && previousLpr?.position === lprPosition
    const lpr = lprName
      ? [{ ...(previousLpr || {}), name: lprName, position: lprPosition, evidence: sameLpr ? previousLpr?.evidence || '' : '' }, ...(selectedLead.lpr || []).slice(1)]
      : (selectedLead.lpr || []).slice(1)
    const emailSource = JSON.stringify(emails) === JSON.stringify(selectedLead.lpr_emails || [])
      ? selectedLead.email_source
      : emails.length ? 'manual' : 'none'
    setLeadSaveBusy(true)
    try {
      const res = await apiFetch(`${API_URL}/api/leads/${selectedLead.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          company_name, domain: String(leadEditDraft.domain || '').trim(),
          city: String(leadEditDraft.city || '').trim(), industry: String(leadEditDraft.industry || '').trim(),
          address: String(leadEditDraft.address || '').trim(), phone: String(leadEditDraft.phone || '').trim(),
          lpr, lpr_emails: emails, email_source: emailSource, brands,
        })
      })
      const updated = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(updated.error || 'Не удалось сохранить карточку')
      setSelectedLead(updated)
      setLeadEditDraft(null); setLeadEditMode(false)
      await loadData()
      toast('Карточка лида обновлена', 'success')
    } catch (error: any) {
      toast(error?.message || 'Ошибка соединения с сервером', 'error')
    } finally { setLeadSaveBusy(false) }
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
    const email = lead.email_source === 'website' ? lead.lpr_emails[0] : ''
    if (!email) { toast('Email с сайта не найден. Проверьте контакт перед отправкой.', 'info'); return }
    const { subject, body } = buildLetter(lead)
    window.location.href = `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
    markLetterCopied(lead.id)
  }

  const handleGenerateKP = async (lead: Lead) => {
    setKpGeneratingId(lead.id)
    try {
      const res = await apiFetch(`${API_URL}/api/leads/${lead.id}/generate-kp`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { toast(data.error || 'Не удалось сформировать КП', 'error'); return }
      setLeads(prev => prev.map(item => item.id === lead.id ? data : item))
      setSelectedLead(prev => prev?.id === lead.id ? data : prev)
      loadData()
      toast(data.status === 'proposal_ready' ? 'КП сформировано. Лид переведён на этап «КП подготовлено».' : 'КП сформировано. Его можно открыть из карточки лида.', 'success')
    } catch {
      toast('Ошибка соединения с сервером при формировании КП', 'error')
    } finally {
      setKpGeneratingId(null)
    }
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

  const requestLeadImport = async (rows: any[], sourceName: string, dryRun: boolean) => {
    const res = await apiFetch(`${API_URL}/api/leads/import`, {
      method: 'POST',
      body: JSON.stringify({ leads: rows, sourceName, dryRun })
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || 'Не удалось обработать импорт')
    return data
  }

  const handlePreviewImport = (rows: any[], sourceName: string) => requestLeadImport(rows, sourceName, true)

  const handleCommitImport = async (rows: any[], sourceName: string) => {
    const result = await requestLeadImport(rows, sourceName, false)
    await loadData()
    toast(`Импортировано ${result.imported} лидов; пропущено дублей: ${result.duplicates}.`, 'success')
    return result
  }

  const handleGeocodeMissing = async (leadIds: string[]) => {
    const res = await apiFetch(`${API_URL}/api/leads/geocode-missing`, {
      method: 'POST',
      body: JSON.stringify({ leadIds })
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || 'Не удалось найти координаты')
    await loadData()
    if (data.geocoded > 0) toast(`Координаты найдены для ${data.geocoded} лидов.${data.failed ? ` Не удалось определить для ${data.failed}; проверьте адреса.` : ''}`, data.failed ? 'info' : 'success')
    else toast('Геокодер не нашёл точные точки для выбранных лидов. Добавьте точные адреса или координаты вручную при импорте.', 'info')
    return data
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
  const downloadCatalogTemplate = () => {
    const content = '\uFEFFbrand;sku;name;car;price;stock\r\nBosch;BO-123;Фильтр воздушный;LADA Granta;420;25\r\n'
    const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'supplier_offer_template.csv'
    link.click()
    URL.revokeObjectURL(url)
  }
  const handleCatalogUpload = async (event: any) => {
    const file = event.target.files?.[0] as File | undefined
    if (!file) return
    try {
      const catalogItems = await readOfferFile(file)
      setSupplierDraft((prev: any) => ({ ...prev, catalogItems }))
      const brands = [...new Set(catalogItems.map(item => item.brand))]
      toast(`Загружено ${catalogItems.length} позиций по ${brands.length} брендам`, 'success')
    } catch (error: any) {
      toast(error?.message || 'Не удалось прочитать файл предложения', 'error')
    } finally {
      event.target.value = ''
    }
  }

  const handleSaveSupplier = async () => {
    try {
      const res = await apiFetch(`${API_URL}/api/supplier-config`, {
        method: 'PUT',
        body: JSON.stringify(supplierDraft)
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { toast(data.error || 'Не удалось сохранить карточку поставщика', 'error'); return }
      setSupplier(data)
      setSupplierDraft(data)
      try { localStorage.setItem('supplier_config', JSON.stringify(data)) } catch { /* ignore */ }
      setSupplierOpen(false)
      const scoreRes = await apiFetch(`${API_URL}/api/leads/rescore`, { method: 'POST' })
      if (scoreRes.ok) {
        const scoreData = await scoreRes.json().catch(() => ({}))
        loadData()
        toast(`Карточка сохранена. Пересчитан скоринг ${scoreData.rescored || 0} лидов по ассортименту поставщика.`, 'success')
      } else {
        toast('Карточка сохранена, но скоринг существующих лидов не обновлён.', 'error')
      }
    } catch { toast('Ошибка соединения с сервером', 'error') }
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
      (l.industry || '').toLowerCase().includes(q) ||
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
    { label: 'ЛПР найден с цитатой источника', done: selectedLead.lpr.some(person => Boolean(person.evidence)) },
    { label: 'Email найден на сайте', done: selectedLead.email_source === 'website' && (selectedLead.lpr_emails || []).length > 0 },
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
          {user && (
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-indigo-500/30 to-violet-500/30 border border-indigo-500/25 flex items-center justify-center text-[11px] font-bold text-indigo-200" title={user.email}>
                {(user.name || user.email || '?').trim().split(/\s+/).map((w: string) => w[0]).slice(0, 2).join('').toUpperCase()}
              </div>
              <button onClick={handleLogout} className="btn-ghost !py-2 !px-3 text-[12px]" title="Выйти">
                Выйти
              </button>
            </div>
          )}
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
            onOpenLead={handleOpenLead}
            onCopyLetter={handleCopyLetter}
            onDownloadPDF={handleDownloadPDF}
            onExportCSV={handleExportCSV}
            onPreviewImport={handlePreviewImport}
            onCommitImport={handleCommitImport}
            onStatusChange={handleStatusChange}
          />
        )}
        {activeTab === 'map' && <MapPage leads={leads} sectors={sectors} managers={managers} onGeocodeMissing={handleGeocodeMissing} onCreateSector={handleCreateSector} />}
        {activeTab === 'managers' && <ManagersPage managers={managers} analytics={analytics} />}
        {activeTab === 'analytics' && <AnalyticsPage analytics={analytics} leads={leads} loading={loading} />}
      </main>

      {/* Drawer лида */}
      <Drawer open={Boolean(selectedLead)} onClose={() => { setSelectedLead(null); setLeadEditMode(false); setLeadEditDraft(null) }} title={selectedLead?.company_name}>
        {selectedLead && (
          <div className="space-y-7">
            <div>
              <div className="flex items-center justify-between gap-3 mb-3">
                <div className="label !mb-0">Данные компании и контакты</div>
                {leadEditMode ? (
                  <div className="flex gap-2">
                    <button onClick={() => { setLeadEditMode(false); setLeadEditDraft(null) }} disabled={leadSaveBusy} className="btn-ghost !py-1.5 text-xs">Отмена</button>
                    <button onClick={() => void handleSaveLeadDetails()} disabled={leadSaveBusy} className="btn-primary !py-1.5 text-xs">{leadSaveBusy ? 'Сохраняю...' : 'Сохранить'}</button>
                  </div>
                ) : (
                  <button onClick={() => beginLeadEdit(selectedLead)} className="btn-ghost !py-1.5 text-xs">Редактировать</button>
                )}
              </div>
              {leadEditMode && leadEditDraft && (
                <div className="card !bg-ink-800/60 p-4 space-y-3">
                  <div className="grid sm:grid-cols-2 gap-3">
                    {([
                      ['company_name', 'Компания'], ['domain', 'Сайт или домен'], ['city', 'Город'],
                      ['industry', 'Вид деятельности'], ['address', 'Адрес'], ['phone', 'Телефон'],
                      ['lprName', 'Контактное лицо / ЛПР'], ['lprPosition', 'Должность'],
                    ] as [string, string][]).map(([key, label]) => (
                      <div key={key}>
                        <label className="label">{label}</label>
                        <input value={leadEditDraft[key] || ''} onChange={e => setLeadEditDraft({ ...leadEditDraft, [key]: e.target.value })} className="input" />
                      </div>
                    ))}
                  </div>
                  <div>
                    <label className="label">Email (несколько адресов разделяйте точкой с запятой)</label>
                    <input value={leadEditDraft.emails} onChange={e => setLeadEditDraft({ ...leadEditDraft, emails: e.target.value })} className="input" />
                  </div>
                  <div>
                    <label className="label">Бренды (разделяйте точкой с запятой)</label>
                    <input value={leadEditDraft.brands} onChange={e => setLeadEditDraft({ ...leadEditDraft, brands: e.target.value })} className="input" />
                  </div>
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              {[
                ['Сайт', selectedLead.domain || '—'],
                ['Город', selectedLead.city || '—'],
                ['Вид деятельности', selectedLead.industry || '—'],
                ['Адрес', selectedLead.address || '—'],
                ['Телефон', selectedLead.phone || '—'],
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
              <div className="label">ЛПР, найденные в тексте сайта</div>
              <div className="space-y-2">
                {selectedLead.lpr.length === 0 && (
                  <div className="card !bg-ink-800/60 p-3.5 text-[13px] text-slate-500">Имя и должность ЛПР с цитатой источника не найдены.</div>
                )}
                {selectedLead.lpr.map((person, i) => (
                  <div key={i} className="card !bg-ink-800/60 p-3.5">
                    <div className="font-semibold text-slate-100 text-sm">{person.name}</div>
                    <div className="text-[12px] text-slate-500 mb-2">{person.position}</div>
                    {person.evidence ? (
                      <div className="text-[12px] text-slate-400 border-l border-indigo-500/40 pl-2">Источник: «{person.evidence}»</div>
                    ) : (
                      <div className="text-[11px] text-amber-300/80">Старая запись: источник имени не сохранён, проверьте вручную.</div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div>
              <div className="label">Email компании</div>
              <div className="card !bg-ink-800/60 p-3.5">
                {(selectedLead.lpr_emails || []).length === 0 ? (
                  <div className="text-[13px] text-slate-500">Email на сайте не найден.</div>
                ) : (
                  <>
                    <div className="text-[11px] text-slate-500 mb-2">
                      {selectedLead.email_source === 'website'
                        ? 'Найден в тексте сайта; принадлежность конкретному ЛПР и актуальность не проверены.'
                        : selectedLead.email_source === 'import'
                        ? 'Email загружен из внешнего файла; проверьте актуальность перед использованием.'
                        : selectedLead.email_source === 'manual'
                        ? 'Email внесён менеджером вручную.'
                        : 'Источник email в старой записи неизвестен; проверьте адрес перед использованием.'}
                    </div>
                    {selectedLead.lpr_emails.map((email, i) => (
                      <div key={i} className="flex items-center gap-2 flex-wrap py-1">
                        <Mail size={12} className="text-slate-600" />
                        <span className="text-[13px] text-slate-300">{email}</span>
                        <button
                          onClick={() => { navigator.clipboard.writeText(email); toast('Email скопирован', 'success') }}
                          className="text-slate-600 hover:text-white transition-colors"
                          title="Скопировать email"
                        >
                          <Copy size={12} />
                        </button>
                      </div>
                    ))}
                  </>
                )}
              </div>
            </div>

            <div>
              <div className="label">Бренды компании</div>
              <div className="flex flex-wrap gap-1.5">
                {selectedLead.brands.map((b, i) => (
                  <span key={i} className="chip bg-ink-700 text-slate-300 !px-2.5 !py-1">{b}</span>
                ))}
              </div>
              <div className="label mt-3">Совпадение с предложением поставщика</div>
              <div className="text-[13px] text-slate-300">
                {selectedLead.matched_brands?.length ? selectedLead.matched_brands.join(', ') : 'Совпавших брендов нет — брендовая часть скоринга не начислена.'}
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
                disabled={!selectedLead.lpr_emails[0] || selectedLead.email_source !== 'website'}
                className="btn-ghost text-[13px]"
                title="Открыть в почтовом клиенте"
              >
                <Send size={14} /> В почту
              </button>
              <button
                onClick={() => selectedLead.pdf_file ? handleDownloadPDF(selectedLead) : handleGenerateKP(selectedLead)}
                disabled={kpGeneratingId === selectedLead.id || (!selectedLead.pdf_file && ['not_target', 'blacklisted'].includes(selectedLead.status))}
                className="btn-ghost text-[13px]"
                title={!selectedLead.pdf_file && ['not_target', 'blacklisted'].includes(selectedLead.status) ? 'Верните лид в рабочий статус для формирования КП' : undefined}
              >
                <FileDown size={14} /> {kpGeneratingId === selectedLead.id ? 'Формирую КП…' : selectedLead.pdf_file ? 'Открыть КП' : ['not_target', 'blacklisted'].includes(selectedLead.status) ? 'Лид исключён' : 'Сформировать КП'}
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
      <CenterModal open={supplierOpen} onClose={() => setSupplierOpen(false)} title="Карточка поставщика для КП" width="max-w-2xl">
        <div className="max-h-[70vh] overflow-y-auto pr-1 space-y-4">
          <div className="grid sm:grid-cols-2 gap-3">
            {([
              ['name', 'Название компании'], ['inn', 'ИНН'], ['contact', 'Контактное лицо'],
              ['phone', 'Телефон'], ['email', 'Email'], ['website', 'Сайт'], ['address', 'Адрес'],
              ['payment_terms', 'Условия оплаты'], ['delivery', 'Доставка'], ['warranty', 'Гарантия'],
              ['offer_validity', 'Срок действия КП'],
            ] as [string, string][]).map(([key, label]) => (
              <div key={key}>
                <label className="label">{label}</label>
                <input value={supplierDraft[key] || ''} onChange={e => setSupplierDraft({ ...supplierDraft, [key]: e.target.value })} className="input" />
              </div>
            ))}
          </div>
          <div>
            <label className="label">Текст предложения и особые условия</label>
            <textarea value={supplierDraft.offer_text || ''} onChange={e => setSupplierDraft({ ...supplierDraft, offer_text: e.target.value })} className="input min-h-24 resize-y" placeholder="Например: специализация, преимущества, порядок заказа" />
          </div>
          <div className="card !bg-ink-800/60 p-4 space-y-3">
            <div>
              <div className="font-semibold text-sm text-slate-200">Предложение по брендам и товарам</div>
              <div className="text-xs text-slate-500 mt-1">CSV или JSON. Для CSV нужны колонки: brand, name, price; sku, car и stock — дополнительные.</div>
            </div>
            <div className="flex flex-wrap gap-2">
              <label className="btn-ghost !py-2 text-[13px] w-fit cursor-pointer">
                <Upload size={14} /> Загрузить CSV / JSON
                <input type="file" accept=".csv,.json,text/csv,application/json" onChange={handleCatalogUpload} className="hidden" />
              </label>
              <button onClick={downloadCatalogTemplate} className="btn-ghost !py-2 text-[13px]">
                <FileDown size={14} /> Скачать шаблон CSV
              </button>
            </div>
            <div className="text-xs text-slate-400">Позиции: {(supplierDraft.catalogItems || []).length} · Бренды: {[...new Set((supplierDraft.catalogItems || []).map((item: any) => item.brand).filter(Boolean))].join(', ') || 'не загружены'}</div>
          </div>
          <div className="flex justify-end gap-2.5 pt-1">
            <button onClick={() => setSupplierOpen(false)} className="btn-ghost">Отмена</button>
            <button onClick={handleSaveSupplier} className="btn-primary">Сохранить карточку</button>
          </div>
        </div>
      </CenterModal>

      {/* Авторизация */}
      {authRequired && (
        <div className="fixed inset-0 z-[3000] bg-black/85 backdrop-blur flex items-center justify-center p-4">
          <div className="card w-full max-w-sm p-7 animate-fade-up">
            <div className="w-12 h-12 rounded-2xl bg-indigo-500/15 flex items-center justify-center mb-4">
              <KeyRound size={22} className="text-indigo-300" />
            </div>
            <h2 className="text-lg font-extrabold text-white">Вход в систему</h2>
            <p className="text-[13px] text-slate-500 mt-1.5 mb-5">Введите email и пароль вашей учётной записи</p>
            <div className="space-y-3">
              <input
                type="email"
                value={loginEmail}
                onChange={e => setLoginEmail(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleLogin() }}
                placeholder="Email"
                className="input"
                autoFocus
              />
              <input
                type="password"
                value={loginPassword}
                onChange={e => setLoginPassword(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleLogin() }}
                placeholder="Пароль"
                className="input"
              />
              <button onClick={handleLogin} disabled={loginBusy} className="btn-primary w-full">
                {loginBusy ? 'Вход...' : 'Войти'}
              </button>
            </div>
          </div>
        </div>
      )}

      <ProgressWidget job={isPipelineRunning ? job : null} />
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  )
}
