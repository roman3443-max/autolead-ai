import { Search, Download, Inbox, Copy, FileDown, Users, Sparkles, Briefcase } from 'lucide-react'
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
  onStatusChange: (leadId: string, status: string) => void
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
  const counts = {
    total: p.leads.length,
    fresh: p.leads.filter(l => l.status === 'new').length,
    working: p.leads.filter(l => l.status === 'in_progress').length,
    clients: p.leads.filter(l => l.status === 'converted').length,
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
            <select value={p.statusFilter} onChange={e => p.setStatusFilter(e.target.value)} className="input !w-auto !py-2 text-[13px]">
              <option value="all">Все статусы</option>
              {Object.entries(STATUS_META).map(([id, m]) => <option key={id} value={id}>{m.label}</option>)}
            </select>
            <div className="text-[13px] text-slate-500 ml-auto">
              Найдено: <span className="text-slate-200 font-semibold tabular-nums">{p.filteredLeads.length}</span> из {p.leads.length}
            </div>
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
        ) : p.filteredLeads.length === 0 ? (
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
                {p.filteredLeads.map(lead => {
                  const sm = STATUS_META[lead.status] || STATUS_META.new
                  const tm = TIER_META[lead.lead_tier] || TIER_META.C
                  return (
                    <tr key={lead.id} className="row-hover border-b border-line/60 last:border-0">
                      <td className="td cursor-pointer" onClick={() => p.onOpenLead(lead)}>
                        <div className="font-semibold text-slate-100 hover:text-indigo-300 transition-colors">{lead.company_name}</div>
                        <div className="text-[12px] text-slate-500 mt-0.5">{lead.domain}</div>
                        <div className="flex gap-1.5 mt-1.5 flex-wrap">
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
                        {lead.lpr.map((person, idx) => (
                          <div key={idx} className="flex items-start gap-2.5 mb-2 last:mb-0">
                            <LprAvatar name={person.name} />
                            <div className="min-w-0">
                              <div className="text-[13px] text-slate-200 leading-tight">{person.name}</div>
                              <div className="text-[11px] text-slate-500">{person.position}</div>
                              {lead.lpr_emails[idx] && (
                                <div className="flex items-center gap-1 mt-0.5">
                                  <span className="text-[12px] text-slate-400">{lead.lpr_emails[idx]}</span>
                                  <button
                                    onClick={() => navigator.clipboard.writeText(lead.lpr_emails[idx])}
                                    className="text-slate-600 hover:text-white transition-colors"
                                    title="Скопировать email"
                                  >
                                    <Copy size={11} />
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                        ))}
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
    </div>
  )
}
