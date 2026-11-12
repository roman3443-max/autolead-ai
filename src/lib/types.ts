export interface Lpr { name: string; position: string; evidence?: string }

export interface ScoreFactor {
  key: string
  label: string
  points: number
  detail: string
}

export interface ProposalItem {
  sku?: string
  brand: string
  name: string
  car?: string
  price: number
  stock?: number
  quantity: number
}

export interface Lead {
  id: string
  company_name: string
  domain: string
  city: string
  address?: string
  industry?: string
  phone?: string
  source_type?: 'import' | 'search'
  source_name?: string
  coordinates?: { lat: number; lng: number }
  coordinate_source?: 'nominatim' | 'import'
  lpr: Lpr[]
  lpr_emails: string[]
  email_source?: 'website' | 'import' | 'manual' | 'none'
  brands: string[]
  matched_brands?: string[]
  lead_score: number
  lead_tier: 'A' | 'B' | 'C'
  score_breakdown?: { total: number; factors: ScoreFactor[] }
  matched_skus?: ProposalItem[]
  proposal_items?: ProposalItem[]
  proposal_total?: number
  proposal_created_at?: string
  business_size?: 'small' | 'medium' | 'large' | 'unknown'
  wholesale?: boolean
  reason?: string
  status: string
  pdf_file?: string | null
  comments?: string[]
  activities?: { id: string; created_at: string; note: string; outcome?: string; next_contact_at?: string | null }[]
  next_contact_at?: string | null
  status_history?: { status: string; date: string }[]
  sector_id?: string
  assigned_manager_id?: string
  search_task_id?: string
  search_task_name?: string
}

export interface SearchTask {
  id: string
  name: string
  city: string
  industry: string
  limit: number
  scoring?: { weights: Record<string, number> } | null
  use_ai?: boolean
  use_geocode?: boolean
  status: 'draft' | 'running' | 'done' | 'error'
  last_run?: string | null
  leads_found?: number
  leads_added?: number
  last_error?: string
  created_at?: string
}

export interface PipelineJob {
  id: string
  status: string
  stage: string
  processed: number
  total: number
  added: number
  totalFound: number
  message: string
  error?: string
}

export interface Toast {
  id: number
  text: string
  type: 'success' | 'error' | 'info'
}

export const STATUS_META: Record<string, { label: string; color: string; bg: string; dot: string }> = {
  new:          { label: 'Новый',             color: 'text-slate-300',    bg: 'bg-slate-500/10',    dot: 'bg-slate-400' },
  in_progress:  { label: 'В работе',          color: 'text-violet-300',   bg: 'bg-violet-500/10',   dot: 'bg-violet-400' },
  proposal_ready: { label: 'КП подготовлено',  color: 'text-cyan-300',     bg: 'bg-cyan-500/10',     dot: 'bg-cyan-400' },
  contacted:    { label: 'КП отправлено',      color: 'text-sky-300',      bg: 'bg-sky-500/10',      dot: 'bg-sky-400' },
  converted:    { label: 'Клиент',             color: 'text-emerald-300', bg: 'bg-emerald-500/10',  dot: 'bg-emerald-400' },
  not_target:   { label: 'Не целевой',         color: 'text-amber-300',    bg: 'bg-amber-500/10',    dot: 'bg-amber-400' },
  blacklisted:  { label: 'Чёрный список',      color: 'text-rose-300',     bg: 'bg-rose-500/10',     dot: 'bg-rose-400' },
}
export const TIER_META: Record<string, { color: string; bg: string }> = {
  A: { color: 'text-emerald-300', bg: 'bg-emerald-500/15' },
  B: { color: 'text-amber-300', bg: 'bg-amber-500/15' },
  C: { color: 'text-rose-300', bg: 'bg-rose-500/15' },
}

export const SIZE_LABELS: Record<string, string> = {
  small: 'Малый бизнес', medium: 'Средний бизнес', large: 'Крупный бизнес', unknown: 'Не определён',
}

export const SCORING_FIELDS: [string, string][] = [
  ['lpr', 'ЛПР'], ['emails', 'Email'], ['brands', 'Совпадение с ассортиментом'],
  ['businessSize', 'Размер'], ['wholesale', 'Опт'], ['content', 'Контент сайта'],
]
