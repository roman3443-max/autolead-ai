import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react'
import { Toast } from '../lib/types'

const ICONS = {
  success: <CheckCircle2 size={16} className="text-emerald-400 shrink-0" />,
  error: <AlertCircle size={16} className="text-rose-400 shrink-0" />,
  info: <Info size={16} className="text-sky-400 shrink-0" />,
}

const STYLES = {
  success: 'border-emerald-500/30 bg-emerald-950/80',
  error: 'border-rose-500/30 bg-rose-950/80',
  info: 'border-sky-500/30 bg-sky-950/80',
}

export default function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="fixed bottom-5 right-5 z-[2000] flex flex-col gap-2 w-[min(92vw,360px)]">
      {toasts.map(t => (
        <div
          key={t.id}
          className={`flex items-start gap-3 rounded-xl border px-4 py-3 shadow-pop backdrop-blur animate-slide-in-right ${STYLES[t.type]}`}
        >
          {ICONS[t.type]}
          <div className="text-[13px] text-slate-100 leading-snug flex-1">{t.text}</div>
          <button onClick={() => onDismiss(t.id)} className="text-slate-500 hover:text-white transition-colors">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}
