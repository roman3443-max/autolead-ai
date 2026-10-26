import { ReactNode } from 'react'
import { X } from 'lucide-react'

// Боковая панель (drawer) справа
export default function Drawer({ open, onClose, title, children, width = 'max-w-xl' }: {
  open: boolean
  onClose: () => void
  title: ReactNode
  children: ReactNode
  width?: string
}) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-[1000]" role="dialog" aria-modal="true">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-[fade-up_0.2s_ease-out]"
        onClick={onClose}
      />
      <div className={`absolute right-0 top-0 h-full w-full ${width} bg-ink-850 border-l border-line shadow-pop animate-slide-in-right flex flex-col`}>
        <div className="flex items-center justify-between gap-4 px-6 py-5 border-b border-line">
          <div className="text-lg font-bold text-white truncate">{title}</div>
          <button onClick={onClose} className="icon-btn shrink-0" aria-label="Закрыть">
            <X size={20} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
      </div>
    </div>
  )
}

// Центрированная модалка (для форм задач, настроек)
export function CenterModal({ open, onClose, title, children, width = 'max-w-lg' }: {
  open: boolean
  onClose: () => void
  title: ReactNode
  children: ReactNode
  width?: string
}) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className={`relative w-full ${width} card shadow-pop animate-fade-up max-h-[88vh] flex flex-col`}>
        <div className="flex items-center justify-between gap-4 px-6 py-4 border-b border-line">
          <div className="text-base font-bold text-white">{title}</div>
          <button onClick={onClose} className="icon-btn" aria-label="Закрыть">
            <X size={18} />
          </button>
        </div>
        <div className="overflow-y-auto px-6 py-5">{children}</div>
      </div>
    </div>
  )
}
