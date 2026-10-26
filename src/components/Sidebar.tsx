import { Search, Users, Map, Briefcase, BarChart3 } from 'lucide-react'

export type TabId = 'search' | 'table' | 'map' | 'managers' | 'analytics'

const NAV: { id: TabId; label: string; icon: any }[] = [
  { id: 'search', label: 'Поиск лидов', icon: Search },
  { id: 'table', label: 'Работа с лидами', icon: Users },
  { id: 'map', label: 'Карта и сектора', icon: Map },
  { id: 'managers', label: 'Менеджеры', icon: Briefcase },
  { id: 'analytics', label: 'Аналитика', icon: BarChart3 },
]

export default function Sidebar({ active, onChange, pipelineRunning }: {
  active: TabId
  onChange: (t: TabId) => void
  pipelineRunning: boolean
}) {
  return (
    <>
      {/* Desktop: сайдбар */}
      <aside className="hidden md:flex flex-col w-60 shrink-0 border-r border-line bg-ink-850/60 backdrop-blur sticky top-0 h-screen">
        <div className="px-5 pt-6 pb-5">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-glow">
              <Search size={18} className="text-white" />
            </div>
            <div>
              <div className="font-extrabold text-[15px] tracking-tight text-white leading-none">Lead Pipeline</div>
              <div className="text-[11px] text-slate-500 mt-0.5">AI-генератор лидов</div>
            </div>
          </div>
        </div>
        <nav className="px-3 space-y-1 mt-2">
          {NAV.map(item => {
            const isActive = active === item.id
            return (
              <button
                key={item.id}
                onClick={() => onChange(item.id)}
                className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-semibold transition-all duration-150 outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60 relative ${
                  isActive
                    ? 'bg-gradient-to-r from-indigo-500/15 to-violet-500/10 text-white'
                    : 'text-slate-400 hover:text-slate-100 hover:bg-ink-750'
                }`}
              >
                {isActive && <span className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-6 rounded-r bg-gradient-to-b from-indigo-400 to-violet-500" />}
                <item.icon size={17} className={isActive ? 'text-indigo-400' : ''} />
                {item.label}
                {item.id === 'search' && pipelineRunning && (
                  <span className="ml-auto w-2 h-2 rounded-full bg-emerald-400 animate-pulse-soft" title="Поиск выполняется" />
                )}
              </button>
            )
          })}
        </nav>
        <div className="mt-auto px-5 pb-6 text-[11px] text-slate-600 leading-relaxed">
          Автоматический поиск компаний,
          <br />скоринг и персональные КП
        </div>
      </aside>

      {/* Mobile: верхняя навигация */}
      <div className="md:hidden sticky top-0 z-40 bg-ink-900/90 backdrop-blur border-b border-line px-3 pt-3 pb-2">
        <div className="flex items-center gap-2 mb-2 px-1">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center">
            <Search size={14} className="text-white" />
          </div>
          <span className="font-extrabold text-sm text-white">Lead Pipeline</span>
        </div>
        <div className="flex gap-1 overflow-x-auto">
          {NAV.map(item => (
            <button
              key={item.id}
              onClick={() => onChange(item.id)}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors ${
                active === item.id ? 'bg-indigo-500/15 text-white' : 'text-slate-400'
              }`}
            >
              <item.icon size={13} />
              {item.label}
            </button>
          ))}
        </div>
      </div>
    </>
  )
}
