import { PipelineJob } from '../lib/types'

const STAGES = [
  { id: 'search', label: 'Поиск компаний' },
  { id: 'enrich', label: 'Проверка сайтов и скоринг' },
  { id: 'save', label: 'Проверка дублей и сохранение' },
]

// Виджет показывает текущий этап поиска и его локальный прогресс.
export default function ProgressWidget({ job }: { job: PipelineJob | null }) {
  if (!job) return null
  const stageIndex = Math.max(0, STAGES.findIndex(stage => stage.id === job.stage))
  const pct = Math.min(100, (job.processed / Math.max(job.total, 1)) * 100)
  const unit = job.stage === 'search' ? 'компаний' : 'сайтов'

  return (
    <div className="fixed bottom-5 left-5 z-[1500] w-[min(92vw,360px)] card p-4 border-indigo-500/30 animate-slide-in-left">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <div className="text-[13px] font-semibold text-white">{job.message}</div>
          <div className="text-[11px] text-slate-500 mt-0.5">Этап {Math.min(stageIndex + 1, STAGES.length)} из {STAGES.length}</div>
        </div>
        <span className="w-2 h-2 mt-1 rounded-full bg-indigo-400 animate-pulse-soft shrink-0" />
      </div>
      <div className="flex gap-1 mb-2" aria-label="Этапы поиска">
        {STAGES.map((stage, index) => (
          <div key={stage.id} title={stage.label} className={`h-1.5 flex-1 rounded-full transition-colors ${index <= stageIndex ? 'bg-indigo-400' : 'bg-ink-700'}`} />
        ))}
      </div>
      <div className="h-1.5 bg-ink-700 rounded-full overflow-hidden">
        <div className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-500 transition-all duration-500" style={{ width: `${pct}%` }} />
      </div>
      <div className="text-[11px] text-slate-500 mt-1.5 tabular-nums">{job.processed} / {job.total} {unit}</div>
    </div>
  )
}