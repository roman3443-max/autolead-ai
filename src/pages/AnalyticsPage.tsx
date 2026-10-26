import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend } from 'recharts'
import { Lead } from '../lib/types'
import StatCard, { StatSkeleton } from '../components/StatCard'
import { Users, Sparkles, Briefcase, Award } from 'lucide-react'

interface Props {
  analytics: any
  leads: Lead[]
  loading: boolean
}

const TIER_COLORS: Record<string, string> = { A: '#34D399', B: '#FBBF24', C: '#F87171' }

export default function AnalyticsPage({ analytics, leads, loading }: Props) {
  if (loading) {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[0, 1, 2, 3].map(i => <StatSkeleton key={i} />)}
      </div>
    )
  }
  if (!analytics) return null

  const tiers = [
    { name: 'Tier A', value: leads.filter(l => l.lead_tier === 'A').length },
    { name: 'Tier B', value: leads.filter(l => l.lead_tier === 'B').length },
    { name: 'Tier C', value: leads.filter(l => l.lead_tier === 'C').length },
  ].filter(t => t.value > 0)

  const tooltipStyle = { backgroundColor: '#151B28', border: '1px solid rgba(148,163,184,0.15)', borderRadius: 12, color: '#fff', fontSize: 13 }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-extrabold text-white tracking-tight">Аналитика</h1>
        <p className="text-sm text-slate-500 mt-1">Воронка, тиры и эффективность команды</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Всего лидов" value={analytics.total} icon={<Users size={20} className="text-indigo-300" />} accent="bg-indigo-500/15" />
        <StatCard label="Новые" value={analytics.new} icon={<Sparkles size={20} className="text-sky-300" />} accent="bg-sky-500/15" delay={60} />
        <StatCard label="В работе" value={analytics.in_progress} icon={<Briefcase size={20} className="text-violet-300" />} accent="bg-violet-500/15" delay={120} />
        <StatCard label="Клиенты" value={analytics.converted} icon={<Award size={20} className="text-emerald-300" />} accent="bg-emerald-500/15" delay={180} />
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <div className="card p-6">
          <h3 className="font-bold text-slate-100 mb-5">Воронка по статусам</h3>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={[
              { name: 'Новые', value: analytics.new },
              { name: 'В работе', value: analytics.in_progress },
              { name: 'Клиенты', value: analytics.converted },
            ]}>
              <XAxis dataKey="name" stroke="#64748B" fontSize={12} tickLine={false} axisLine={false} />
              <YAxis stroke="#64748B" fontSize={12} tickLine={false} axisLine={false} allowDecimals={false} />
              <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'rgba(148,163,184,0.06)' }} />
              <Bar dataKey="value" radius={[8, 8, 0, 0]}>
                {['#6366F1', '#8B5CF6', '#10B981'].map((c, i) => <Cell key={i} fill={c} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="card p-6">
          <h3 className="font-bold text-slate-100 mb-5">Распределение по тирам</h3>
          {tiers.length === 0 ? (
            <div className="h-[280px] flex items-center justify-center text-slate-600 text-sm">Нет данных</div>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie data={tiers} dataKey="value" nameKey="name" innerRadius={70} outerRadius={105} paddingAngle={3} strokeWidth={0}>
                  {tiers.map(t => <Cell key={t.name} fill={TIER_COLORS[t.name.replace('Tier ', '')] || '#6366F1'} />)}
                </Pie>
                <Tooltip contentStyle={tooltipStyle} />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 13, color: '#94A3B8' }} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      <div className="card p-6">
        <h3 className="font-bold text-slate-100 mb-5">Эффективность менеджеров</h3>
        <ResponsiveContainer width="100%" height={Math.max(200, (analytics.managers?.length || 1) * 60)}>
          <BarChart data={analytics.managers} layout="vertical" margin={{ left: 8, right: 16 }}>
            <XAxis type="number" stroke="#64748B" fontSize={12} tickLine={false} axisLine={false} allowDecimals={false} />
            <YAxis dataKey="name" type="category" stroke="#94A3B8" fontSize={12} tickLine={false} axisLine={false} width={170} />
            <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'rgba(148,163,184,0.06)' }} />
            <Bar dataKey="leadsCount" fill="#6366F1" radius={[0, 6, 6, 0]} name="Лиды" barSize={16} />
            <Bar dataKey="convertedCount" fill="#10B981" radius={[0, 6, 6, 0]} name="Клиенты" barSize={16} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
