import { useRef, useState } from 'react'
import { Search, Download, Inbox, Copy, FileDown, Users, Sparkles, Briefcase, Upload } from 'lucide-react'
import { CenterModal } from '../components/Drawer'
import { Lead, STATUS_META, TIER_META, SIZE_LABELS } from '../lib/types'
import StatCard, { StatSkeleton } from '../components/StatCard'

interface Props {
  leads: Lead[]
  loading: boolean
  searchQuery: string
  setSearchQuery: (v: string) => void
  statusFilter: string
  setStatusFilter: (v: string) => void
  filteredLeads: Lead[]
  onOpenLead: (lead: Lead) => void
  onCopyLetter: (lead: Lead) => void
  onDownloadPDF: (lead: Lead) => void
  onExportCSV: () => void
  onPreviewImport: (rows: any[], sourceName: string) => Promise<any>
  onCommitImport: (rows: any[], sourceName: string) => Promise<any>
  onStatusChange: (leadId: string, status: string) => void
}


function parseLeadCsv(input: string): any[] {
  const text = input.replace(/^\uFEFF/, '')
  const firstLine = text.split(/\r?\n/, 1)[0] || ''
  const delimiter = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length
    ? ';' : firstLine.includes('\t') ? '\t' : ','
  const records: string[][] = []
  let row: string[] = [], cell = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"' && quoted && text[i + 1] === '"') { cell += '"'; i++; continue }
    if (ch === '"') { quoted = !quoted; continue }
    if (!quoted && ch === delimiter) { row.push(cell); cell = ''; continue }
    if (!quoted && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell); cell = ''
      if (row.some(value => value.trim())) records.push(row)
      row = []; continue
    }
    cell += ch
  }
  row.push(cell)
  if (row.some(value => value.trim())) records.push(row)
  if (records.length < 2) throw new Error('CSV должен содержать заголовок и хотя бы одну строку')
  if (records.length > 1001) throw new Error('За один раз можно загрузить не более 1000 строк')
  const normalize = (value: string) => value.trim().toLowerCase().replace(/ё/g, 'е')
  const headers = records[0].map(normalize)
  const aliases: Record<string, string[]> = {
    company_name: ['company_name', 'company name', 'company', 'компания', 'название компании', 'организация', 'название организации'],
    domain: ['domain', 'website', 'site', 'url', 'сайт', 'веб-сайт'],
    city: ['city', 'город', 'населенный пункт'],
    industry: ['industry', 'activity', 'вид деятельности', 'отрасль', 'сфера деятельности'],
    address: ['address', 'адрес'],
    phone: ['phone', 'telephone', 'телефон'],
    email: ['email', 'e-mail', 'email компании', 'почта'],
    brands: ['brands', 'бренды', 'марки'],
    lpr_name: ['lpr_name', 'лпр', 'контактное лицо', 'имя контакта'],
    lpr_position: ['lpr_position', 'должность', 'позиция'],
    lat: ['lat', 'latitude', 'широта'],
    lng: ['lng', 'lon', 'longitude', 'долгота'],
  }
  const indexes = Object.fromEntries(Object.entries(aliases).map(([key, names]) =>
    [key, headers.findIndex(header => names.includes(header))]
  ))
  if (indexes.company_name < 0) throw new Error('Не найдена обязательная колонка «Компания» или company_name')
  return records.slice(1).map(record => {
    const value = (key: string) => indexes[key] < 0 ? '' : String(record[indexes[key]] || '').trim()
    const numberOrUndefined = (raw: string) => raw ? Number(raw.replace(',', '.')) : undefined
    return {
      company_name: value('company_name'), domain: value('domain'), city: value('city'),
      industry: value('industry'), address: value('address'), phone: value('phone'), email: value('email'),
      brands: value('brands'), lpr_name: value('lpr_name'), lpr_position: value('lpr_position'),
      lat: numberOrUndefined(value('lat')), lng: numberOrUndefined(value('lng')),
    }
  })
}

function LprAvatar({ name }: { name: string }) {
  const initials = name.split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '?'
  return (
    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-500/40 to-violet-500/40 border border-indigo-500/30 flex items-center justify-center text-[11px] font-bold text-indigo-200 shrink-0">
      {initials}
    </div>
  )
}

export default function LeadsPage(p: Props) {
  const [industryFilter, setIndustryFilter] = useState('all')
  const activityOptions = [...new Set(p.leads.map(lead => lead.industry?.trim()).filter((value): value is string => Boolean(value)))].sort((a, b) => a.localeCompare(b, 'ru'))
  const visibleLeads = industryFilter === 'all' ? p.filteredLeads : p.filteredLeads.filter(lead => lead.industry === industryFilter)
  const now = new Date()
  const weekAhead = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
  const followUps = p.leads
    .filter(lead => lead.next_contact_at && !['not_target', 'blacklisted', 'converted'].includes(lead.status))
    .map(lead => ({ lead, date: new Date(lead.next_contact_at as string) }))
    .filter(item => Number.isFinite(item.date.getTime()) && item.date <= weekAhead)
    .sort((a, b) => a.date.getTime() - b.date.getTime())
  const fileInput = useRef<HTMLInputElement>(null)
  const [importRows, setImportRows] = useState<any[]>([])
  const [importSource, setImportSource] = useState('')
  const [importPreview, setImportPreview] = useState<any>(null)
  const [importBusy, setImportBusy] = useState(false)
  const [importError, setImportError] = useState('')

  const handleImportFile = async (file?: File) => {
    if (!file) return
    setImportBusy(true); setImportError(''); setImportPreview(null)
    try {
      const rows = parseLeadCsv(await file.text())
      const preview = await p.onPreviewImport(rows, file.name)
      setImportRows(rows); setImportSource(file.name); setImportPreview(preview)
    } catch (error: any) {
      setImportError(error?.message || 'Не удалось прочитать CSV')
    } finally {
      setImportBusy(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  const handleCommitImport = async () => {
    if (!importRows.length || !importSource) return
    setImportBusy(true); setImportError('')
    try {
      await p.onCommitImport(importRows, importSource)
      setImportPreview(null); setImportRows([]); setImportSource('')
    } catch (error: any) {
      setImportError(error?.message || 'Импорт не выполнен')
    } finally { setImportBusy(false) }
  }
  const counts = {
    total: p.leads.length,
    fresh: p.leads.filter(l => l.status === 'new').length,
    working: p.leads.filter(l => l.status === 'in_progress').length,
    clients: p.leads.filter(l => l.status === 'converted').length,
  }
  const pipelineStages = [
    { status: 'new', step: 'Этап 1', action: 'Проверить профиль компании' },
    { status: 'in_progress', step: 'Этап 2', action: 'Начать работу и выбрать предложение' },
    { status: 'proposal_ready', step: 'Этап 3', action: 'КП сформировано · проверить и отправить' },
    { status: 'contacted', step: 'Этап 4', action: 'КП отправлено · дождаться ответа' },
    { status: 'converted', step: 'Этап 5', action: 'Клиент · сделка завершена' },
  ].map(stage => ({ ...stage, label: STATUS_META[stage.status].label, count: p.leads.filter(lead => lead.status === stage.status).length }))
  const excludedCounts = {
    not_target: p.leads.filter(lead => lead.status === 'not_target').length,
    blacklisted: p.leads.filter(lead => lead.status === 'blacklisted').length,
  }

  return (
    <div className="space-y-6">
      {p.loading ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[0, 1, 2, 3].map(i => <StatSkeleton key={i} delay={i * 60} />)}
        </div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard label="Всего в базе" value={counts.total} icon={<Users size={20} className="text-indigo-300" />} accent="bg-indigo-500/15" />
          <StatCard label="Новые" value={counts.fresh} icon={<Sparkles size={20} className="text-sky-300" />} accent="bg-sky-500/15" delay={60} />
          <StatCard label="В работе" value={counts.working} icon={<Briefcase size={20} className="text-violet-300" />} accent="bg-violet-500/15" delay={120} />
          <StatCard label="Клиенты" value={counts.clients} icon={<Inbox size={20} className="text-emerald-300" />} accent="bg-emerald-500/15" delay={180} />
        </div>
      )}

      <section className="card p-4 md:p-5 space-y-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-sm font-bold text-slate-100">Пайплайн менеджера</h2>
            <p className="text-xs text-slate-500 mt-1">Основной путь лида. Нажмите этап, чтобы открыть записи. После генерации КП этап обновится автоматически; «КП отправлено» отмечайте после фактической отправки.</p>
          </div>
          {(excludedCounts.not_target + excludedCounts.blacklisted) > 0 && (
            <span className="text-xs text-slate-500">Вне основной воронки: {excludedCounts.not_target + excludedCounts.blacklisted}</span>
          )}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-2">
          {pipelineStages.map((stage, index) => {
            const active = p.statusFilter === stage.status
            return (
              <button key={stage.status} onClick={() => p.setStatusFilter(active ? 'all' : stage.status)}
                aria-pressed={active}
                className={`rounded-xl border p-3 text-left transition-colors ${active ? 'border-indigo-400/70 bg-indigo-500/10' : 'border-line bg-ink-800/50 hover:border-slate-600'}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] uppercase tracking-wide text-slate-500">{stage.step}</span>
                  <span className={`text-lg font-extrabold tabular-nums ${active ? 'text-indigo-200' : 'text-slate-100'}`}>{stage.count}</span>
                </div>
                <div className="text-sm font-semibold text-slate-100 mt-1">{stage.label}</div>
                <div className="text-[11px] text-slate-500 mt-1 leading-relaxed">{stage.action}</div>
                {index < pipelineStages.length - 1 && <div className="hidden xl:block text-[10px] text-slate-600 mt-2">Далее →</div>}
              </button>
            )
          })}
        </div>
        <div className="flex flex-wrap gap-2 border-t border-line pt-3">
          {(['not_target', 'blacklisted'] as const).map(status => (
            <button key={status} onClick={() => p.setStatusFilter(p.statusFilter === status ? 'all' : status)}
              className={`rounded-lg px-2.5 py-1.5 text-xs border transition-colors ${p.statusFilter === status ? 'border-amber-400/50 bg-amber-500/10 text-amber-200' : 'border-line text-slate-500 hover:text-slate-300'}`}>
              {STATUS_META[status].label}: {excludedCounts[status]}
            </button>
          ))}
        </div>
      </section>

      <section className="card p-4 md:p-5 space-y-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-sm font-bold text-slate-100">Контакты для внимания</h2>
            <p className="text-xs text-slate-500 mt-1">Просроченные и запланированные на ближайшие 7 дней.</p>
          </div>
          <div className="flex gap-3 text-xs">
            <span className="text-rose-300">Просрочено: {followUps.filter(item => item.date < now).length}</span>
            <span className="text-indigo-300">Впереди: {followUps.filter(item => item.date >= now).length}</span>
          </div>
        </div>
        {followUps.length === 0 ? (
          <div className="text-sm text-slate-500">Нет контактов на ближайшие дни. Назначьте дату в карточке лида.</div>
        ) : (
          <div className="grid md:grid-cols-2 gap-2">
            {followUps.slice(0, 8).map(({ lead, date }) => {
              const overdue = date < now
              const latestNote = lead.activities?.[0]?.note
              return (
                <button key={lead.id} onClick={() => p.onOpenLead(lead)} className="card !bg-ink-800/50 p-3 text-left hover:border-indigo-500/40 transition-colors">
                  <div className="flex items-start justify-between gap-3">
                    <span className="font-semibold text-sm text-slate-100">{lead.company_name}</span>
                    <span className={overdue ? 'text-[11px] text-rose-300 shrink-0' : 'text-[11px] text-indigo-300 shrink-0'}>
                      {overdue ? 'Просрочено · ' : ''}{date.toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                  <div className="text-xs text-slate-500 mt-1">{lead.city}{lead.industry ? ` · ${lead.industry}` : ''}</div>
                  {latestNote && <div className="text-xs text-slate-400 mt-2 line-clamp-2">{latestNote}</div>}
                </button>
              )
            })}
          </div>
        )}
        {followUps.length > 8 && <div className="text-xs text-slate-500">Показаны ближайшие 8 из {followUps.length}. Отфильтруйте лиды по поиску или статусу для работы с остальными.</div>}
      </section>

      <div className="card overflow-hidden">
        {/* Панель фильтров */}
        <div className="p-4 border-b border-line space-y-3">
          <div className="relative">
            <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              value={p.searchQuery}
              onChange={e => p.setSearchQuery(e.target.value)}
              placeholder="Поиск по компании, сайту, ЛПР, email или брендам..."
              className="input pl-10"
            />
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <select value={industryFilter} onChange={e => setIndustryFilter(e.target.value)} className="input !w-auto !py-2 text-[13px]">
              <option value="all">Все виды деятельности</option>
              {activityOptions.map(activity => <option key={activity} value={activity}>{activity}</option>)}
            </select>
            <select value={p.statusFilter} onChange={e => p.setStatusFilter(e.target.value)} className="input !w-auto !py-2 text-[13px]">
              <option value="all">Все статусы</option>
              {Object.entries(STATUS_META).map(([id, m]) => <option key={id} value={id}>{m.label}</option>)}
            </select>
            <div className="text-[13px] text-slate-500 ml-auto">
              Найдено: <span className="text-slate-200 font-semibold tabular-nums">{visibleLeads.length}</span> из {p.leads.length}
            </div>
            <button onClick={() => fileInput.current?.click()} disabled={importBusy} className="btn-ghost !py-2 text-[13px]">
              <Upload size={14} /> Импорт CSV
            </button>
            <input ref={fileInput} type="file" accept=".csv,text/csv" onChange={e => void handleImportFile(e.target.files?.[0])} className="hidden" />
            <button onClick={() => {
              const csv = '\uFEFFКомпания;Сайт;Город;Вид деятельности;Адрес;Телефон;Email;Бренды;ЛПР;Должность;Широта;Долгота\r\nАвтоСервис;example.ru;Екатеринбург;СТО;Ленина 1;+7 900 000-00-00;info@example.ru;Bosch;Иван Иванов;Директор;56.838;60.597'
              const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
              const a = document.createElement('a'); a.href = url; a.download = 'шаблон_импорта_лидов.csv'
              document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
            }} className="btn-ghost !py-2 text-[13px]">
              <FileDown size={14} /> Шаблон
            </button>
            <button onClick={p.onExportCSV} className="btn-ghost !py-2 text-[13px]">
              <Download size={14} /> Экспорт CSV
            </button>
          </div>
        </div>

        {/* Таблица */}
        {p.loading ? (
          <div className="p-6 space-y-3">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="flex gap-4 items-center">
                <div className="skeleton w-8 h-8 rounded-full" />
                <div className="flex-1 space-y-2">
                  <div className="skeleton h-4 w-1/3" />
                  <div className="skeleton h-3 w-1/4" />
                </div>
                <div className="skeleton h-8 w-24" />
              </div>
            ))}
          </div>
        ) : visibleLeads.length === 0 ? (
          <div className="py-16 text-center">
            <Inbox size={36} className="mx-auto text-slate-600 mb-3" />
            <div className="text-slate-400 font-semibold">Лиды не найдены</div>
            <div className="text-slate-600 text-sm mt-1">Измените фильтры или запустите поиск на вкладке «Поиск лидов»</div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px]">
              <thead className="sticky-head">
                <tr className="border-b border-line">
                  <th className="th">Компания</th>
                  <th className="th">ЛПР и контакты</th>
                  <th className="th">Бренды</th>
                  <th className="th">Скор</th>
                  <th className="th">Статус</th>
                  <th className="th text-right !pr-5">Действия</th>
                </tr>
              </thead>
              <tbody>
                {visibleLeads.map(lead => {
                  const sm = STATUS_META[lead.status] || STATUS_META.new
                  const tm = TIER_META[lead.lead_tier] || TIER_META.C
                  return (
                    <tr key={lead.id} className="row-hover border-b border-line/60 last:border-0">
                      <td className="td cursor-pointer" onClick={() => p.onOpenLead(lead)}>
                        <div className="font-semibold text-slate-100 hover:text-indigo-300 transition-colors">{lead.company_name}</div>
                        <div className="text-[12px] text-slate-500 mt-0.5">{lead.domain}</div>
                        <div className="flex gap-1.5 mt-1.5 flex-wrap">
                          {lead.industry && <span className='chip bg-indigo-500/10 text-indigo-300'>{lead.industry}</span>}
                          {lead.business_size && lead.business_size !== 'unknown' && (
                            <span className="chip bg-sky-500/10 text-sky-300">{SIZE_LABELS[lead.business_size]}</span>
                          )}
                          {lead.wholesale && <span className="chip bg-emerald-500/10 text-emerald-300">Опт</span>}
                          {lead.search_task_name && (
                            <span className="chip bg-violet-500/10 text-violet-300" title={`Задача поиска: ${lead.search_task_name}`}>
                              {lead.search_task_name}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="td">
                        {lead.phone && <div className="text-[11px] text-slate-400 mb-2">Тел. {lead.phone}</div>}
                        {lead.lpr.map((person, idx) => (
                          <div key={idx} className="flex items-start gap-2.5 mb-2 last:mb-0">
                            <LprAvatar name={person.name} />
                            <div className="min-w-0">
                              <div className="text-[13px] text-slate-200 leading-tight">{person.name}</div>
                              <div className="text-[11px] text-slate-500">{person.position}</div>
                              {person.evidence && <div className="text-[11px] text-slate-500 mt-1 line-clamp-2">Источник: «{person.evidence}»</div>}
                            </div>
                          </div>
                        ))}
                        {(lead.lpr_emails || []).length > 0 && (
                          <div className="mt-2 pt-2 border-t border-line/60">
                            <div className="text-[10px] uppercase tracking-wide text-slate-600 mb-1">
                              {lead.email_source === 'website' ? 'Найдено на сайте · не привязано к ЛПР' : lead.email_source === 'import' ? 'Импортировано · проверьте источник' : lead.email_source === 'manual' ? 'Введено вручную' : 'Email из старой записи · проверьте'}
                            </div>
                            {lead.lpr_emails.slice(0, 2).map((email, idx) => (
                              <div key={idx} className="text-[11px] text-slate-400 truncate">{email}</div>
                            ))}
                          </div>
                        )}
                        {lead.lpr.length === 0 && (lead.lpr_emails || []).length === 0 && (
                          <span className="text-[12px] text-slate-600">Контакты не найдены</span>
                        )}
                      </td>
                      <td className="td">
                        <div className="flex flex-wrap gap-1 max-w-[180px]">
                          {lead.brands.slice(0, 4).map((b, i) => (
                            <span key={i} className="chip bg-ink-700 text-slate-300">{b}</span>
                          ))}
                          {lead.brands.length > 4 && <span className="text-[11px] text-slate-500">+{lead.brands.length - 4}</span>}
                        </div>
                      </td>
                      <td className="td">
                        <div className="text-lg font-extrabold text-white tabular-nums">{lead.lead_score}</div>
                        <span className={`chip mt-0.5 ${tm.bg} ${tm.color}`}>Tier {lead.lead_tier}</span>
                      </td>
                      <td className="td">
                        <select
                          value={lead.status}
                          onChange={e => p.onStatusChange(lead.id, e.target.value)}
                          className={`rounded-lg border border-line bg-ink-800 px-2.5 py-1.5 text-[12px] font-semibold outline-none cursor-pointer transition-colors hover:border-slate-600 ${sm.color}`}
                        >
                          {Object.entries(STATUS_META).map(([id, m]) => <option key={id} value={id}>{m.label}</option>)}
                        </select>
                      </td>
                      <td className="td !pr-4">
                        <div className="flex items-center justify-end gap-1">
                          <button onClick={() => p.onCopyLetter(lead)} className="icon-btn" title="Скопировать текст письма">
                            <Copy size={16} />
                          </button>
                          <button
                            onClick={() => p.onDownloadPDF(lead)}
                            className={`icon-btn ${lead.pdf_file ? 'text-emerald-400 hover:text-emerald-300' : ''}`}
                            title={lead.pdf_file ? 'Открыть КП' : 'КП не сгенерировано'}
                          >
                            <FileDown size={16} />
                          </button>
                          <button onClick={() => p.onOpenLead(lead)} className="btn-primary !py-1.5 !px-3.5 text-[12px] ml-1">
                            Открыть
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <CenterModal open={Boolean(importPreview) || Boolean(importError)} onClose={() => { if (!importBusy) { setImportPreview(null); setImportError('') } }} title="Импорт внешних лидов" width="max-w-2xl">
        {importError && !importPreview && <div className="text-sm text-rose-300">{importError}</div>}
        {importPreview && (
          <div className="space-y-4">
            <p className="text-sm text-slate-400">Файл: <span className="text-slate-200">{importSource}</span>. Импортируем с пересчётом скоринга и проверкой дублей.</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {[
                ['Строк', importPreview.total], ['К импорту', importPreview.importable],
                ['Дубли', importPreview.duplicates], ['Ошибки', importPreview.invalid],
              ].map(([label, value]) => (
                <div key={label} className="card !bg-ink-800/60 p-3">
                  <div className="text-xs text-slate-500">{label}</div>
                  <div className="text-lg font-bold text-white">{value}</div>
                </div>
              ))}
            </div>
            {!!importPreview.newPreview?.length && <div>
              <div className="label">Новые лиды (показаны первые 20)</div>
              <div className="max-h-40 overflow-y-auto rounded-lg border border-line divide-y divide-line/60">
                {importPreview.newPreview.map((lead: any) => <div key={lead.row} className="px-3 py-2 text-xs text-slate-300 flex justify-between gap-3">
                  <span>{lead.company_name}{lead.city ? ` · ${lead.city}` : ''}{lead.industry ? ` · ${lead.industry}` : ''}</span>
                  <span className="shrink-0">Скор {lead.lead_score} · {lead.lead_tier}</span>
                </div>)}
              </div>
            </div>}
            {!!importPreview.duplicatePreview?.length && <div>
              <div className="label">Дубли (показаны первые 20)</div>
              <div className="text-xs text-slate-500">{importPreview.duplicatePreview.map((row: any) => row.company_name).join(' · ')}</div>
            </div>}
            {!!importPreview.invalidRows?.length && <div>
              <div className="label">Строки с ошибками</div>
              <div className="max-h-24 overflow-y-auto text-xs text-amber-300">{importPreview.invalidRows.slice(0, 20).map((row: any) => `Строка ${row.row}: ${row.reason}`).join(' · ')}</div>
            </div>}
            {importError && <div className="text-sm text-rose-300">{importError}</div>}
            <div className="flex justify-end gap-2">
              <button onClick={() => { setImportPreview(null); setImportError('') }} disabled={importBusy} className="btn-ghost">Отмена</button>
              <button onClick={() => void handleCommitImport()} disabled={importBusy || !importPreview?.importable} className="btn-primary">
                {importBusy ? 'Обработка...' : `Импортировать ${importPreview.importable}`}
              </button>
            </div>
          </div>
        )}
      </CenterModal>
    </div>
  )
}
