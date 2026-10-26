import { Users, Mail, Phone, Award, TrendingUp } from 'lucide-react'

interface Props {
  managers: any[]
  analytics: any
}

export default function ManagersPage({ managers, analytics }: Props) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-extrabold text-white tracking-tight">Команда менеджеров</h1>
        <p className="text-sm text-slate-500 mt-1">Нагрузка и конверсия по ответственным</p>
      </div>
      <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
        {managers.map((m, i) => {
          const stats = analytics?.managers?.find((am: any) => am.id === m.id)
          const initials = m.name.split(/\s+/).map((w: string) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase()
          const conversion = stats?.leadsCount ? Math.round((stats.convertedCount / stats.leadsCount) * 100) : 0
          return (
            <div key={m.id} className="card p-5 animate-fade-up hover:border-slate-600/60 transition-colors" style={{ animationDelay: `${i * 60}ms` }}>
              <div className="flex items-start gap-3.5">
                <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500/30 to-violet-500/30 border border-indigo-500/25 flex items-center justify-center text-sm font-extrabold text-indigo-200 shrink-0">
                  {initials}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-bold text-slate-100 truncate">{m.name}</div>
                  <div className="text-[12px] text-slate-500">{m.position}</div>
                </div>
              </div>
              <div className="mt-4 space-y-1.5 text-[13px] text-slate-400">
                <div className="flex items-center gap-2"><Mail size={12} className="text-slate-600" /> {m.email}</div>
                <div className="flex items-center gap-2"><Phone size={12} className="text-slate-600" /> {m.phone}</div>
              </div>
              <div className="mt-4 pt-4 border-t border-line grid grid-cols-3 gap-2 text-center">
                <div>
                  <div className="text-lg font-extrabold text-white tabular-nums flex items-center justify-center gap-1">
                    <Users size={13} className="text-indigo-400" />{stats?.leadsCount || 0}
                  </div>
                  <div className="text-[10px] uppercase tracking-wider text-slate-500 mt-0.5">Лидов</div>
                </div>
                <div>
                  <div className="text-lg font-extrabold text-emerald-300 tabular-nums flex items-center justify-center gap-1">
                    <Award size={13} />{stats?.convertedCount || 0}
                  </div>
                  <div className="text-[10px] uppercase tracking-wider text-slate-500 mt-0.5">Клиентов</div>
                </div>
                <div>
                  <div className="text-lg font-extrabold text-violet-300 tabular-nums flex items-center justify-center gap-1">
                    <TrendingUp size={13} />{conversion}%
                  </div>
                  <div className="text-[10px] uppercase tracking-wider text-slate-500 mt-0.5">Конверсия</div>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
