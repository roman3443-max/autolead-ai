import { Search, Play, Pencil, Trash2, ArrowRight, Settings2, RefreshCw, CheckCircle2, Circle, Sparkles, AlertCircle } from 'lucide-react'
import { SearchTask } from '../lib/types'

interface Props {
  tasks: SearchTask[]
  isPipelineRunning: boolean
  scoringCfg: any
  onNewTask: () => void
  onRunTask: (task: SearchTask) => void
  onEditTask: (task: SearchTask) => void
  onDeleteTask: (task: SearchTask) => void
  onGoLeads: () => void
  onOpenSettings: () => void
}

const STATUS_BADGE: Record<string, { text: string; cls: string }> = {
  draft:   { text: 'Черновик',        cls: 'bg-slate-500/10 text-slate-400' },
  running: { text: 'Выполняется',     cls: 'bg-sky-500/15 text-sky-300' },
  done:    { text: 'Выполнена',       cls: 'bg-emerald-500/15 text-emerald-300' },
  error:   { text: 'Ошибка',          cls: 'bg-rose-500/15 text-rose-300' },
}

export default function SearchPage(p: Props) {
  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-extrabold text-white tracking-tight">Задачи поиска лидов</h1>
          <p className="text-sm text-slate-500 mt-1">Задайте, что и где искать, параметры скоринга и обогащения — затем запускайте в один клик</p>
        </div>
        <div className="flex gap-2">
          <button onClick={p.onOpenSettings} className="btn-ghost">
            <Settings2 size={15} /> Настройки скоринга
          </button>
          <button onClick={p.onNewTask} className="btn-success">
            <Search size={15} /> Новая задача
          </button>
        </div>
      </div>

      {p.tasks.length === 0 ? (
        <div className="card py-16 text-center">
          <Sparkles size={36} className="mx-auto text-slate-600 mb-3" />
          <div className="text-slate-300 font-semibold">Задач пока нет</div>
          <div className="text-slate-500 text-sm mt-1 mb-5">Создайте первую задачу — задайте, что и где искать</div>
          <button onClick={p.onNewTask} className="btn-primary mx-auto">
            <Search size={15} /> Создать задачу
          </button>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
          {p.tasks.map((task, i) => {
            const badge = STATUS_BADGE[task.status] || STATUS_BADGE.draft
            return (
              <div key={task.id} className="card p-5 flex flex-col animate-fade-up hover:border-slate-600/60 transition-colors" style={{ animationDelay: `${i * 50}ms` }}>
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="font-bold text-slate-100 leading-snug">{task.name}</div>
                  <span className={`chip shrink-0 ${badge.cls}`}>
                    {task.status === 'running' && <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-pulse-soft" />}
                    {badge.text}
                  </span>
                </div>

                <div className="text-[13px] text-slate-400 mb-1">
                  {task.city} <span className="text-slate-600 mx-1">·</span> {task.industry} <span className="text-slate-600 mx-1">·</span> до {task.limit} компаний
                </div>
                <div className="text-[12px] text-slate-500 mb-4">
                  {task.scoring ? 'Индивидуальные веса скоринга' : 'Скоринг по глобальному конфигу'}
                  {task.use_ai === false ? ' · без AI' : ''}
                  {task.use_geocode === false ? ' · без геокодинга' : ''}
                </div>

                {task.last_run && (
                  <div className="text-[12px] text-slate-500 mb-4 pb-4 border-b border-line">
                    <div>Последний запуск: {new Date(task.last_run).toLocaleString('ru-RU')}</div>
                    <div className="mt-0.5">
                      Найдено <span className="text-slate-300 font-semibold tabular-nums">{task.leads_found ?? 0}</span>,
                      добавлено <span className="text-slate-300 font-semibold tabular-nums">{task.leads_added ?? 0}</span>
                    </div>
                    {task.last_error && (
                      <div className="flex items-start gap-1.5 mt-1.5 text-rose-300">
                        <AlertCircle size={12} className="mt-0.5 shrink-0" />
                        <span className="leading-snug">{task.last_error}</span>
                      </div>
                    )}
                  </div>
                )}

                <div className="flex gap-2 mt-auto flex-wrap">
                  <button
                    onClick={() => p.onRunTask(task)}
                    disabled={p.isPipelineRunning}
                    className="btn-success !py-2 text-[13px] flex-1"
                  >
                    <Play size={13} /> Запустить
                  </button>
                  <button onClick={() => p.onGoLeads()} className="btn-ghost !py-2 text-[13px]" title="К лидам">
                    <ArrowRight size={13} />
                  </button>
                  <button onClick={() => p.onEditTask(task)} className="btn-ghost !py-2 !px-2.5" title="Изменить">
                    <Pencil size={13} />
                  </button>
                  <button onClick={() => p.onDeleteTask(task)} className="btn-danger !py-2 !px-2.5" title="Удалить">
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Дефолты из конфига — подсказка */}
      {p.scoringCfg?.searchDefaults && (
        <div className="card px-5 py-4 flex items-center gap-3 text-[13px] text-slate-500">
          <RefreshCw size={14} className="text-slate-600" />
          <span>
            Дефолты поиска: <span className="text-slate-300 font-semibold">{p.scoringCfg.searchDefaults.city}</span>,
            отрасль <span className="text-slate-300 font-semibold">{p.scoringCfg.searchDefaults.industry}</span>,
            лимит <span className="text-slate-300 font-semibold tabular-nums">{p.scoringCfg.searchDefaults.limit}</span>
            {p.scoringCfg.retailPenalty ? <> · штраф за розницу <span className="text-slate-300 font-semibold tabular-nums">{p.scoringCfg.retailPenalty}</span></> : null}
          </span>
        </div>
      )}
    </div>
  )
}

// Чек-лист готовности (используется в drawer лида, экспортируем для App)
export function ReadinessChecklist({ items }: { items: { label: string; done: boolean }[] }) {
  return (
    <div className="space-y-1">
      {items.map((item, i) => (
        <div key={i} className={`flex items-center gap-2.5 py-1.5 text-[13px] ${item.done ? 'text-emerald-300' : 'text-slate-500'}`}>
          {item.done ? <CheckCircle2 size={15} className="shrink-0" /> : <Circle size={15} className="shrink-0 text-slate-600" />}
          {item.label}
        </div>
      ))}
    </div>
  )
}
