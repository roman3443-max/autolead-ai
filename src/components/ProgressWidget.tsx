import { PipelineJob } from '../lib/types'

// Плавающий виджет прогресса пайплайна (низ-справа)
export default function ProgressWidget({ job }: { job: PipelineJob | null }) {
  if (!job) return null
  const pct = Math.min(100, (job.processed / Math.max(job.total, 1)) * 100)
  return (
    <div className="fixed bottom-5 left-5 z-[1500] w-[300px] card p-4 border-indigo-500/30 animate-slide-in-left">
      <div className="flex items-center gap-2 mb-2">
        <span className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse-soft" />
        <span className="text-[13px] font-semibold text-white">{job.message}</span>
      </div>
      <div className="h-1.5 bg-ink-700 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-500 transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="text-[11px] text-slate-500 mt-1.5 tabular-nums">{job.processed} / {job.total}</div>
    </div>
  )
}
