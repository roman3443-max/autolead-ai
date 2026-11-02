import { tavily } from '@tavily/core'
import FirecrawlApp from '@mendable/firecrawl-js'
import { GoogleGenerativeAI } from '@google/generative-ai'
import fs from 'fs'
import path from 'path'

// Загрузка переменных окружения из .env (для локального запуска; на Railway переменные заданы в dashboard)
const envPath = path.join(process.cwd(), '.env')
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
    const eq = line.indexOf('=')
    if (eq > 0 && !line.trim().startsWith('#')) {
      const key = line.slice(0, eq).trim()
      if (!process.env[key]) process.env[key] = line.slice(eq + 1).trim()
    }
  })
}

// Инициализация API (ключи берутся из .env / переменных окружения)
const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY || '' })
const firecrawlApp = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY || '' })
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '')

const rootDir = process.cwd()
const readJSONFile = (file: string, fallback: any) => {
  const p = path.join(rootDir, file)
  if (!fs.existsSync(p)) return fallback
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')) } catch { return fallback }
}

// --- Конфигурация скоринга (scoring_config.json) ---
interface ScoringConfig {
  weights: { lpr: number; emails: number; brands: number; businessSize: number; wholesale: number; content: number }
  tiers: { a: number; b: number }
  businessSizeScores: { large: number; medium: number; small: number; unknown: number }
  retailPenalty: number
}

// Глобальные настройки поиска «что и где искать» по умолчанию
interface SearchDefaults { city: string; industry: string; limit: number }

// Параметры конкретного запуска поиска (могут переопределять файл-конфиг)
interface PipelineOptions {
  scoring?: Partial<ScoringConfig> | null
  useAI?: boolean
  useGeocode?: boolean
  onKP?: (filename: string, content: string) => void | Promise<void>
}

const DEFAULT_SCORING: ScoringConfig = {
  weights: { lpr: 25, emails: 15, brands: 20, businessSize: 15, wholesale: 10, content: 15 },
  tiers: { a: 75, b: 50 },
  businessSizeScores: { large: 15, medium: 10, small: 5, unknown: 2 },
  retailPenalty: 15
}

const DEFAULT_SEARCH: SearchDefaults = { city: 'Екатеринбург', industry: 'автозапчасти', limit: 5 }

function loadScoringConfig(overrides?: Partial<ScoringConfig> | null): ScoringConfig {
  const cfg = readJSONFile('scoring_config.json', null)
  const base: ScoringConfig = cfg ? {
    weights: { ...DEFAULT_SCORING.weights, ...(cfg.weights || {}) },
    tiers: { ...DEFAULT_SCORING.tiers, ...(cfg.tiers || {}) },
    businessSizeScores: { ...DEFAULT_SCORING.businessSizeScores, ...(cfg.businessSizeScores || {}) },
    retailPenalty: typeof cfg.retailPenalty === 'number' ? cfg.retailPenalty : DEFAULT_SCORING.retailPenalty
  } : DEFAULT_SCORING
  if (!cfg) {
    console.log('⚠️ scoring_config.json не найден — используются веса по умолчанию')
  }
  const merged: ScoringConfig = {
    weights: { ...base.weights, ...(overrides?.weights || {}) },
    tiers: { ...base.tiers, ...(overrides?.tiers || {}) },
    businessSizeScores: { ...base.businessSizeScores, ...(overrides?.businessSizeScores || {}) },
    retailPenalty: typeof overrides?.retailPenalty === 'number' ? overrides.retailPenalty : base.retailPenalty
  }
  const sum = Object.values(merged.weights).reduce((a, b) => a + b, 0)
  if (sum !== 100) {
    console.log(`⚠️ Сумма весов в scoring_config.json равна ${sum} (ожидалось 100). Скоринг работает, но проверьте конфиг.`)
  }
  console.log('⚖️ Веса скоринга:', JSON.stringify(merged.weights), '| штраф за розницу:', merged.retailPenalty)
  return merged
}

export function loadSearchDefaults(): SearchDefaults {
  const cfg = readJSONFile('scoring_config.json', null)
  const d = cfg?.searchDefaults || {}
  const limit = parseInt(d.limit)
  return {
    city: String(d.city || DEFAULT_SEARCH.city).trim() || DEFAULT_SEARCH.city,
    industry: String(d.industry || DEFAULT_SEARCH.industry).trim() || DEFAULT_SEARCH.industry,
    limit: Number.isInteger(limit) && limit >= 1 && limit <= 20 ? limit : DEFAULT_SEARCH.limit
  }
}

// --- Каталог поставщика (supplier_catalog.json) ---
interface CatalogItem { sku: string; brand: string; name: string; car: string; price: number; stock: number }
interface SupplierCatalog {
  supplier_name?: string
  payment_terms?: string
  delivery?: string
  items: CatalogItem[]
}

function loadCatalog(): SupplierCatalog {
  const catalog = readJSONFile('supplier_catalog.json', { items: [] })
  if (!catalog.items || catalog.items.length === 0) {
    console.log('⚠️ supplier_catalog.json пуст — КП будут без таблицы товаров')
  } else {
    console.log(`📦 Каталог поставщика: ${catalog.items.length} позиций`)
  }
  return catalog
}

function matchCatalogItems(brands: string[], catalog: SupplierCatalog, maxItems = 10): CatalogItem[] {
  if (!catalog.items.length) return []
  const brandSet = brands.map(b => b.toLowerCase())
  const matched = catalog.items.filter(item =>
    brandSet.some(b => item.brand.toLowerCase().includes(b) || b.includes(item.brand.toLowerCase()))
  )
  const pool = matched.length >= 4 ? matched : [...matched, ...catalog.items.filter(i => !matched.includes(i))]
  return pool.slice(0, maxItems)
}

function buildProductsTable(items: CatalogItem[]): string {
  if (!items.length) return ''
  const rows = items
    .map(i => `<tr><td>${i.brand}</td><td>${i.name}</td><td>${i.car}</td><td>${i.sku}</td><td><b>${i.price.toLocaleString('ru-RU')} ₽</b></td><td>${i.stock} шт.</td></tr>`)
    .join('\n')
  return `<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:13px">
<thead><tr><th>Бренд</th><th>Наименование</th><th>Применяемость</th><th>Артикул</th><th>Цена</th><th>Остаток</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`
}

// --- Чёрный список агрегаторов и мусорных доменов ---
const EXCLUDED_DOMAINS = [
  'avito.ru', 'tiu.ru', 'pulscen.ru', 'flamp.ru', 'yell.ru', 'zoon.ru',
  'asktel.ru', 'spravker.ru', 'help-tel.ru', 'orgs.biz', 'feech.org', 'yp.ru',
  'list-org.com', 'rusprofile.ru', 'sbis.ru', '2gis.ru', 'yandex.ru', 'yandex.com',
  'google.com', 'vk.com', 't.me', 'telegram.me', 'whatsapp.com', 'ok.ru',
  'wikipedia.org', 'youtube.com', 'facebook.com', 'instagram.com', 'aliexpress.com', 'ozon.ru', 'wildberries.ru'
]

function isExcludedDomain(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^www\./, '')
  return EXCLUDED_DOMAINS.some(d => host === d || host.endsWith('.' + d) || host.includes(d))
}

// Email-паттерны не генерируем: сохраняем только адреса, найденные в источнике.

interface LeadData {
  company_name: string
  domain: string
  city: string
  address?: string
  coordinates?: { lat: number; lng: number }
  coordinate_source?: 'nominatim'
  lpr: { name: string; position: string; evidence?: string }[]
  lpr_emails: string[]
  email_source?: 'website' | 'none'
  brands: string[]
  lead_score: number
  lead_tier: 'A' | 'B' | 'C'
  business_size?: 'small' | 'medium' | 'large' | 'unknown'
  wholesale?: boolean
  reason?: string
  matched_skus?: CatalogItem[]
}

// --- Геокодинг (Nominatim) с кэшем ---
interface GeocodeCache { [key: string]: { lat: number; lng: number; source: 'nominatim' } }
let geocodeCache: GeocodeCache = readJSONFile('geocache.json', {})
let geocodeDirty = false

async function nominatimGeocode(query: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 12000)
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=ru&q=${encodeURIComponent(query)}`,
      { headers: { 'User-Agent': 'autolead-ai/1.0 (lead generation tool)' }, signal: ctrl.signal }
    )
    clearTimeout(t)
    if (!res.ok) return null
    const data: any = await res.json()
    if (Array.isArray(data) && data.length > 0) {
      const lat = Number(data[0].lat)
      const lng = Number(data[0].lon)
      if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng }
    }
    return null
  } catch {
    return null
  }
}

async function getCoordinates(companyName: string, city: string, useGeocode = true): Promise<GeocodeCache[string] | undefined> {
  const cacheKey = `${companyName}|${city}`
  const cached = geocodeCache[cacheKey]
  // Старые значения кэша могли быть случайными точками; используем только помеченные результаты геокодера.
  if (cached?.source === 'nominatim') return cached
  if (!useGeocode) return undefined

  const coordinates = await nominatimGeocode(`${companyName}, ${city}`)
  if (!coordinates) return undefined

  const result = { ...coordinates, source: 'nominatim' as const }
  geocodeCache[cacheKey] = result
  geocodeDirty = true
  return result
}

function saveGeocodeCache() {
  if (!geocodeDirty) return
  try {
    fs.writeFileSync(path.join(rootDir, 'geocache.json'), JSON.stringify(geocodeCache, null, 2))
    geocodeDirty = false
  } catch (e) {
    console.error('⚠️ Не удалось сохранить geocache.json:', e)
  }
}

// --- AI: извлечение ЛПР, размера бизнеса, оптовых сигналов одним вызовом ---
function normalizeEvidence(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim()
}

interface AiExtraction {
  lpr: { name: string; position: string; evidence: string }[]
  business_size: 'small' | 'medium' | 'large' | 'unknown'
  wholesale: boolean
  reason: string
}

async function extractWithGemini(companyName: string, domain: string, content: string): Promise<AiExtraction | null> {
  if (!process.env.GEMINI_API_KEY) return null
  const model = genAI.getGenerativeModel(
    { model: process.env.GEMINI_MODEL || 'gemini-3.8-flash' },
    { timeout: 60000 }
  )
  const prompt = 'Проанализируй текст сайта компании "' + companyName + '" (' + domain + ') и ответь СТРОГО в формате JSON:\n' +
    '{\n  "lpr": [{"name": "Фамилия Имя", "position": "должность", "evidence": "точная цитата с сайта, содержащая имя"}],\n' +
    '  "business_size": "small|medium|large|unknown",\n  "wholesale": true/false,\n' +
    '  "reason": "одно предложение: почему этому лиду стоит продавать"\n}\n' +
    'Правила:\n' +
    '- lpr: до 2 людей, чьи имя и должность прямо подтверждаются текстом. Приведи точную цитату из текста без пересказа. Если цитаты нет — не включай человека.\n' +
    '- business_size: large — сеть/филиалы/50+ сотрудников/крупный склад; medium — 10-50 сотрудников, несколько точек; small — один магазин/СТО; unknown — непонятно.\n' +
    '- wholesale: true только при явных признаках опта в тексте (оптовые цены, "опт и розница", дистрибьютор, B2B).\n' +
    'Текст сайта (первые 8000 символов):\n"""\n' + content.slice(0, 8000) + '\n"""'

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await model.generateContent(prompt)
      const text = result.response.text().trim()
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      if (!jsonMatch) throw new Error('AI вернул не JSON')
      const parsed = JSON.parse(jsonMatch[0])
      const source = normalizeEvidence(content)
      const lpr = Array.isArray(parsed.lpr) ? parsed.lpr.slice(0, 2).map((item: any) => ({
        name: String(item.name || '').trim(),
        position: String(item.position || 'Контактное лицо').trim(),
        evidence: String(item.evidence || '').trim()
      })).filter((item: any) => {
        const quote = normalizeEvidence(item.evidence)
        const name = normalizeEvidence(item.name)
        return Boolean(name && quote && quote.includes(name) && source.includes(quote))
      }) : []
      return {
        lpr,
        business_size: ['small', 'medium', 'large'].includes(parsed.business_size) ? parsed.business_size : 'unknown',
        wholesale: Boolean(parsed.wholesale),
        reason: String(parsed.reason || '').slice(0, 300)
      }
    } catch (err: any) {
      const msg = String(err?.message || err)
      const isRetryable = msg.includes('503') || msg.includes('429') || msg.includes('aborted')
      if (!isRetryable || attempt === 3) {
        console.log('  ⚠️ AI-извлечение не удалось (' + msg.slice(0, 80) + ')')
        return null
      }
      console.log('  ⏳ AI занят, повтор ' + (attempt + 1) + '/3...')
      await new Promise(r => setTimeout(r, 8000))
    }
  }
  return null
}

// --- Регэксп-извлечение ЛПР только при наличии имени и должности в тексте ---
function extractLPRRegex(content: string): { name: string; position: string; evidence: string }[] {
  const found: { name: string; position: string; evidence: string }[] = []
  const patterns = [
    {
      regex: /((?:генеральный\s+)?директор|руководитель|менеджер\s+по\s+закупкам)\s*[:—-]\s*([А-ЯЁ][а-яё-]+(?:\s+[А-ЯЁ][а-яё-]+){1,2})/giu,
      position: (match: RegExpMatchArray) => match[1],
      name: (match: RegExpMatchArray) => match[2]
    },
    {
      regex: /([А-ЯЁ][а-яё-]+(?:\s+[А-ЯЁ][а-яё-]+){1,2})\s*[,—-]\s*((?:генеральный\s+)?директор|руководитель|менеджер\s+по\s+закупкам)/giu,
      position: (match: RegExpMatchArray) => match[2],
      name: (match: RegExpMatchArray) => match[1]
    }
  ]
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern.regex)) {
      const name = pattern.name(match).trim()
      if (!found.some(person => normalizeEvidence(person.name) === normalizeEvidence(name))) {
        found.push({ name, position: pattern.position(match).trim(), evidence: match[0].trim() })
      }
      if (found.length >= 2) return found
    }
  }
  return found
}

function extractBusinessSizeRegex(content: string): 'small' | 'medium' | 'large' | 'unknown' {
  const text = content.toLowerCase()
  if (/сеть|филиал|(\d+)\s*(магазин|точк)|склад\s*\d+\s*(м²|м2|кв)|сотрудник[а-я]*\s*[:\-]?\s*([5-9]\d|\d{3,})/.test(text)) return 'large'
  if (/сотрудник[а-я]*\s*[:\-]?\s*(1\d|[2-4]\d)|оптово-розничн|2\s*магазин|более 10/.test(text)) return 'medium'
  if (/сотрудник[а-я]*\s*[:\-]?\s*\d|магазин|сто|шиномонтаж/.test(text)) return 'small'
  return 'unknown'
}

function hasWholesaleSignals(content: string): boolean {
  const text = content.toLowerCase()
  return /опт(овая|ом|а\b)|оптово-розничн|дистрибьютор|b2b|дилер(ская|ам)?|партн(ер|ёр)/.test(text)
}

function extractEmails(content: string): string[] {
  const emails = content.match(/[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || []
  return [...new Set(emails)].filter(e => !e.match(/\.(png|jpg|jpeg|gif|webp|svg)$/i)).slice(0, 5)
}

function extractBrands(content: string): string[] {
  const known = ['Toyota', 'Nissan', 'Honda', 'Mazda', 'Mitsubishi', 'Bosch', 'Denso', 'TRW', 'ZF', 'Continental', 'LADA', 'ВАЗ', 'ГАЗ', 'УАЗ', 'КАМАЗ', 'Ford', 'Renault', 'Chevrolet']
  const found = known.filter(b => content.toLowerCase().includes(b.toLowerCase()))
  return found.length > 0 ? found.slice(0, 6) : ['Автозапчасти']
}

function extractAddress(content: string): string {
  const match = content.match(/адрес[:\s]+(.+?)(?:\n|,|$)/i)
  return match ? match[1].replace(/адрес[:\s]+/i, '').trim().slice(0, 120) : ''
}

// --- Скоринг ---
function calculateLeadScore(cfg: ScoringConfig, input: {
  lprCount: number; emailsCount: number; brandsCount: number
  businessSize: 'small' | 'medium' | 'large' | 'unknown'
  wholesale: boolean; contentLength: number
}): number {
  const w = cfg.weights
  let score = 0
  if (input.lprCount > 0) score += w.lpr
  if (input.emailsCount > 0) score += w.emails
  if (input.brandsCount > 2) score += w.brands
  else if (input.brandsCount > 0) score += Math.round(w.brands / 2)
  score += cfg.businessSizeScores[input.businessSize] ?? cfg.businessSizeScores.unknown
  if (input.wholesale) score += w.wholesale
  else score -= cfg.retailPenalty // штраф за розничный бизнес (как в исходной модели)
  if (input.contentLength > 1500) score += w.content
  else if (input.contentLength > 500) score += Math.round(w.content / 2)
  return Math.max(0, Math.min(score, 100))
}

function getLeadTier(cfg: ScoringConfig, score: number): 'A' | 'B' | 'C' {
  if (score >= cfg.tiers.a) return 'A'
  if (score >= cfg.tiers.b) return 'B'
  return 'C'
}

// Пересчёт скоринга существующих лидов текущей моделью (для старых записей
// с устаревшим скором и для смены scoring_config)
export function rescoreLead(lead: any, overrides?: Partial<ScoringConfig> | null): any {
  const cfg = loadScoringConfig(overrides)
  const size = ['small', 'medium', 'large'].includes(lead.business_size) ? lead.business_size : 'unknown'
  const score = calculateLeadScore(cfg, {
    lprCount: Array.isArray(lead.lpr) ? lead.lpr.length : 0,
    emailsCount: lead.email_source === 'website' && Array.isArray(lead.lpr_emails) ? lead.lpr_emails.length : 0,
    brandsCount: Array.isArray(lead.brands) ? lead.brands.length : 0,
    businessSize: size,
    wholesale: Boolean(lead.wholesale),
    contentLength: 0 // у старых лидов нет исходного текста сайта — не учитываем
  })
  // Контент не сохраняем у лидов, поэтому чтобы не занижать всех старых записей,
  // даём половину веса контента по умолчанию
  const withContentFallback = Math.min(100, score + Math.round(cfg.weights.content / 2))
  return { ...lead, lead_score: withContentFallback, lead_tier: getLeadTier(cfg, withContentFallback) }
}

// --- Этап 1: Поиск компаний через Tavily ---
export async function searchCompanies(city: string, industry: string, limit: number = 10) {
  console.log(`🔍 Поиск компаний: ${city}, ${industry}`)

  const query = `${industry} ${city} компания оптом официальный сайт`
  let lastError: any = null

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await tvly.search(query, { searchDepth: 'basic', maxResults: limit })
      const raw = response.results || []
      const filtered = raw.filter((result: any) => {
        try {
          const host = new URL(result.url).hostname.toLowerCase()
          return !isExcludedDomain(host)
        } catch { return false }
      })
      const excludedCount = raw.length - filtered.length
      if (excludedCount > 0) console.log(`🧹 Отфильтровано агрегаторов/мусора: ${excludedCount}`)

      const companies = filtered.map((result: any) => ({
        company_name: result.title || 'Неизвестная компания',
        domain: new URL(result.url).hostname.replace(/^www\./, ''),
        url: result.url,
        snippet: result.content
      }))
      console.log(`✅ Найдено ${companies.length} компаний`)
      return companies
    } catch (error: any) {
      lastError = error
      const msg = String(error?.message || error)
      const is429 = msg.includes('429') || msg.toLowerCase().includes('rate limit')
      console.error(`❌ Ошибка Tavily (попытка ${attempt}/3):`, msg.slice(0, 120))
      if (!is429 || attempt === 3) {
        // Прокидываем реальную причину — чтобы в UI была точная ошибка (ключ/квота), а не "не найдено"
        throw new Error(`Tavily: ${msg.slice(0, 200)}`)
      }
      await new Promise(r => setTimeout(r, 4000 * attempt))
    }
  }
  throw lastError || new Error('Tavily: неизвестная ошибка')
}

// --- Этап 2: Обогащение данных через Firecrawl ---
export async function enrichCompanyData(companies: any[], city: string, onProgress?: (processed: number, total: number) => void, options?: PipelineOptions) {
  console.log('🕷️ Обогащение данных...')
  const scoringCfg = loadScoringConfig(options?.scoring)
  const catalog = loadCatalog()
  const useAI = options?.useAI ?? true
  const enrichedLeads: LeadData[] = []

  for (const [idx, company] of companies.entries()) {
    try {
      console.log(`   Парсинг ${company.domain}...`)
      const scrapeResult = await firecrawlApp.scrapeUrl(company.url, {
        formats: ['markdown'],
        onlyMainContent: true
      }) as any

      if (!scrapeResult?.success || !scrapeResult.markdown) {
        console.log(`  ⚠️ Не удалось спарсить ${company.domain}`)
        continue
      }

      const content = scrapeResult.markdown

      // Сначала пробуем AI-извлечение (если включено), при неудаче — регэкспы
      const ai = useAI ? await extractWithGemini(company.company_name, company.domain, content) : null
      const lpr = ai && ai.lpr.length > 0 ? ai.lpr : extractLPRRegex(content)
      const businessSize = ai ? ai.business_size : extractBusinessSizeRegex(content)
      const wholesale = ai ? ai.wholesale : hasWholesaleSignals(content)
      const reason = ai?.reason || ''

      // Email: только адреса из текста сайта; принадлежность ЛПР не предполагается.
      const siteEmails = extractEmails(content)
      const lpr_emails = siteEmails
      const email_source = siteEmails.length > 0 ? 'website' : 'none'

      const brands = extractBrands(content)
      const geocoding = await getCoordinates(company.company_name, city, options?.useGeocode ?? true)
      const lead_score = calculateLeadScore(scoringCfg, {
        lprCount: lpr.length,
        emailsCount: siteEmails.length,
        brandsCount: brands.length,
        businessSize,
        wholesale,
        contentLength: content.length
      })
      const lead_tier = getLeadTier(scoringCfg, lead_score)
      const matched_skus = matchCatalogItems(brands, catalog)

      enrichedLeads.push({
        company_name: company.company_name,
        domain: company.domain,
        city,
        address: extractAddress(content),
        coordinates: geocoding ? { lat: geocoding.lat, lng: geocoding.lng } : undefined,
        coordinate_source: geocoding?.source,
        lpr,
        lpr_emails,
        email_source,
        brands,
        lead_score,
        lead_tier,
        business_size: businessSize,
        wholesale,
        reason,
        matched_skus
      })

      console.log(`  ✅ ${company.domain}: ЛПР с цитатой=${lpr.length}, email с сайта=${lpr_emails.length}, геокодирование=${geocoding ? 'Nominatim' : 'нет'}, Размер=${businessSize}, Опт=${wholesale}, Скор=${lead_score} (${lead_tier})`)
    } catch (error) {
      console.error(`  ❌ Ошибка при парсинге ${company.domain}:`, error)
    }
    onProgress?.(idx + 1, companies.length)
  }

  console.log(`✅ Обогащено ${enrichedLeads.length} лидов`)
  return enrichedLeads
}

// --- Этап 3: Генерация КП через Gemini (сохраняем как HTML) ---
export async function generateKP(lead: LeadData, supplierName: string, hooks?: { onKP?: (filename: string, content: string) => void | Promise<void> }) {
  console.log(`📝 Генерация КП для ${lead.company_name}...`)

  try {
    const model = genAI.getGenerativeModel(
      { model: process.env.GEMINI_MODEL || 'gemini-3.8-flash' },
      { timeout: 60000 }
    )

    const productsTable = buildProductsTable(lead.matched_skus || [])
    const productsBlock = productsTable
      ? `Обязательно вставь в раздел про ассортимент ТАБЛИЦУ ТОВАРОВ (используй ровно эти данные, цены не меняй):\n${productsTable}\n`
      : ''

    const prompt = `
Создай персонализированное коммерческое предложение от поставщика "${supplierName}" для компании "${lead.company_name}".
Информация о клиенте: Сайт: ${lead.domain}, Город: ${lead.city}, ЛПР: ${lead.lpr.map(l => `${l.name} (${l.position})`).join(', ')}, Бренды: ${lead.brands.join(', ')}${lead.business_size && lead.business_size !== 'unknown' ? `, Размер бизнеса: ${lead.business_size === 'large' ? 'крупный' : lead.business_size === 'medium' ? 'средний' : 'малый'}` : ''}.
${productsBlock}
Требования:
1. Заголовок: "Коммерческое предложение"
2. Если подтверждённый ЛПР найден — приветствие по его имени. Если ЛПР не найден, используй нейтральное «Добрый день!» и не придумывай имя или должность.
3. Краткое представление поставщика
4. Ассортимент (упомяни бренды клиента${productsTable ? ' и вставь таблицу товаров выше' : ''})
5. Условия сотрудничества (оптовые цены, доставка)
6. Призыв к действию и контакты.
Формат: Чистый HTML с базовыми тегами (<h1>, <h2>, <p>, <ul>, <li>, <b> и <table> для товаров), без <html> и <body>, только контент.
`

    let kpText = ''
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const result = await model.generateContent(prompt)
        kpText = result.response.text()
        break
      } catch (err: any) {
        const is503 = String(err?.message || err).includes('503')
        if (!is503 || attempt === 3) throw err
        console.log(`  ⏳ Gemini перегружен (503), повтор ${attempt + 1}/3...`)
        await new Promise(r => setTimeout(r, 8000))
      }
    }

    // Если AI почему-то не вставил таблицу — добавляем сами после заголовка "Ассортимент"
    if (productsTable && !kpText.includes('<table')) {
      const insertPoint = kpText.search(/<h2>[^<]*ассортимент|<h2>[^<]*предложение/i)
      if (insertPoint >= 0) {
        const h2end = kpText.indexOf('</h2>', insertPoint)
        kpText = kpText.slice(0, h2end + 5) + '\n' + productsTable + kpText.slice(h2end + 5)
      } else {
        kpText += '\n<h2>Ассортимент и цены</h2>\n' + productsTable
      }
    }

    const fileName = `${lead.company_name.replace(/[^a-z0-9а-яё]/gi, '_')}.html`
    // Локальная копия (fallback-режим без БД) + колбэк для сохранения в БД
    try {
      const filePath = path.join(rootDir, 'kp_final', fileName)
      if (!fs.existsSync(path.join(rootDir, 'kp_final'))) {
        fs.mkdirSync(path.join(rootDir, 'kp_final'))
      }
      fs.writeFileSync(filePath, kpText, 'utf-8')
    } catch { /* локальная копия не критична */ }
    if (hooks?.onKP) {
      try { await hooks.onKP(fileName, kpText) } catch (e) { console.error('⚠️ Не удалось сохранить КП в БД:', e) }
    }
    console.log(`✅ КП сохранено: ${fileName}`)
    return fileName
  } catch (error) {
    console.error('❌ Ошибка генерации КП:', error)
    return null
  }
}

// --- Главная функция ---
export async function runPipeline(
  city: string = 'Екатеринбург',
  industry: string = 'автозапчасти',
  limit: number = 5,
  supplierName: string = 'УралАвтоОпт',
  onProgress?: (stage: string, processed: number, total: number) => void,
  options?: PipelineOptions
) {
  console.log('🚀 Запуск пайплайна...')
  const companies = await searchCompanies(city, industry, limit)
  onProgress?.('search', companies.length, limit)
  if (companies.length === 0) return []

  const leads = await enrichCompanyData(companies, city, (p, t) => onProgress?.('enrich', p, t), options)
  if (companies.length > 0 && leads.length === 0) {
    // Компании нашлись, но ни один сайт не спарсился — почти всегда это проблема Firecrawl
    throw new Error(`Firecrawl: найдено ${companies.length} компаний, но ни один сайт не удалось спарсить. Проверьте FIRECRAWL_API_KEY и баланс кредитов.`)
  }
  saveGeocodeCache()
  console.log('✅ Пайплайн завершен!')
  return leads
}
