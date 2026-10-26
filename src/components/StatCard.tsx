import { ReactNode } from 'react'

export default function StatCard({ label, value, icon, accent, delay = 0 }: {
  label: string
  value: ReactNode
  icon: ReactNode
  accent: string
  delay?: number
}) {
  return (
    <div
      className="card p-5 flex items-center gap-4 animate-fade-up"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${accent}`}>
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{label}</div>
        <div className="text-2xl font-extrabold text-white tabular-nums leading-tight mt-0.5">{value}</div>
      </div>
    </div>
  )
}

export function StatSkeleton({ delay = 0 }: { delay?: number }) {
  return (
    <div className="card p-5 flex items-center gap-4" style={{ animationDelay: `${delay}ms` }}>
      <div className="skeleton w-11 h-11 shrink-0" />
      <div className="flex-1 space-y-2">
        <div className="skeleton h-3 w-20" />
        <div className="skeleton h-6 w-12" />
      </div>
    </div>
  )
}
