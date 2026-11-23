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
  supplierCatalog?: SupplierCatalog
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
export interface CatalogItem { sku: string; brand: string; name: string; car: string; price: number; stock: number }
export interface SupplierCatalog {
  supplier_name?: string
  payment_terms?: string
  delivery?: string
  items: CatalogItem[]
}

export function loadCatalog(override?: SupplierCatalog): SupplierCatalog {
  const catalog = override || readJSONFile('supplier_catalog.json', { items: [] })
  if (!catalog.items || catalog.items.length === 0) {
    console.log('⚠️ supplier_catalog.json пуст — КП будут без таблицы товаров')
  } else {
    console.log(`📦 Каталог поставщика: ${catalog.items.length} позиций`)
  }
  return catalog
}

function normalizeBrand(value: string): string {
  return String(value || '').trim().toLocaleLowerCase('ru-RU').replace(/ё/g, 'е')
}

function getMatchedBrands(brands: string[], catalog: SupplierCatalog): string[] {
  const offered = new Set((catalog.items || []).map(item => normalizeBrand(item.brand)).filter(Boolean))
  return [...new Set(brands.filter(brand => offered.has(normalizeBrand(brand))))]
}

export function matchCatalogItems(brands: string[], catalog: SupplierCatalog, maxItems = 10): CatalogItem[] {
  const matched = new Set(getMatchedBrands(brands, catalog).map(normalizeBrand))
  return (catalog.items || []).filter(item => matched.has(normalizeBrand(item.brand))).slice(0, maxItems)
}
function buildProductsTable(items: CatalogItem[]): string {
  if (!items.length) return ''
  const rows = items
    .map(i => `<tr><td>${escapeHtml(i.brand)}</td><td>${escapeHtml(i.name)}</td><td>${escapeHtml(i.car)}</td><td>${escapeHtml(i.sku)}</td><td><b>${Number(i.price || 0).toLocaleString('ru-RU')} ₽</b></td><td>${Number(i.stock || 0)} шт.</td></tr>`)
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
  industry: string
  source_provider?: 'Tavily' | 'Firecrawl'
  source_url?: string
  source_title?: string
  source_snippet?: string
  social_sources?: { provider: 'VK' | 'Telegram'; url: string; title: string; snippet?: string }[]
  qualification_status?: 'qualified' | 'needs_review' | 'not_qualified'
  llm_status?: 'ok' | 'unavailable' | 'disabled'
  industry_evidence?: string
  city_evidence?: string
  requested_city?: string
  customer_role?: 'buyer' | 'supplier' | 'competitor' | 'other' | 'unknown'
  customer_role_evidence?: string
  address_evidence?: string
  address?: string
  coordinates?: { lat: number; lng: number }
  coordinate_source?: 'nominatim'
  lpr: { name: string; position: string; evidence?: string }[]
  lpr_emails: string[]
  email_source?: 'website' | 'none'
  brands: string[]
  lead_score: number
  lead_tier: 'A' | 'B' | 'C'
  score_breakdown?: { total: number; factors: { key: string; label: string; points: number; detail: string }[] }
  business_size?: 'small' | 'medium' | 'large' | 'unknown'
  wholesale?: boolean
  reason?: string
  matched_skus?: CatalogItem[]
  matched_brands?: string[]
}

// --- Геокодинг (Nominatim) с кэшем ---
interface GeocodeCache { [key: string]: { lat: number; lng: number; source: 'nominatim' } }
let geocodeCache: GeocodeCache = readJSONFile('geocache.json', {})
let geocodeDirty = false
let nominatimQueue: Promise<void> = Promise.resolve()
let lastNominatimRequestAt = 0

async function acquireNominatimSlot(): Promise<() => void> {
  const previous = nominatimQueue
  let release: () => void = () => {}
  nominatimQueue = new Promise<void>(resolve => { release = resolve })
  await previous
  const wait = 1100 - (Date.now() - lastNominatimRequestAt)
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
  lastNominatimRequestAt = Date.now()
  return release
}

async function nominatimGeocode(query: string): Promise<{ lat: number; lng: number } | null> {
  const release = await acquireNominatimSlot()
  const ctrl = new AbortController()
  const timeout = setTimeout(() => ctrl.abort(), 12000)
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=ru&q=${encodeURIComponent(query)}`,
      { headers: { 'User-Agent': 'autolead-ai/1.0 (lead generation tool)' }, signal: ctrl.signal }
    )
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
  } finally {
    clearTimeout(timeout)
    release()
  }
}

export async function getCoordinates(companyName: string, city: string, useGeocode = true, address = ''): Promise<GeocodeCache[string] | undefined> {
  const cacheKey = address ? `${companyName}|${city}|${address}` : `${companyName}|${city}`
  const cached = geocodeCache[cacheKey]
  // Старые значения кэша могли быть случайными точками; используем только помеченные результаты геокодера.
  if (cached?.source === 'nominatim') return cached
  if (!useGeocode) return undefined

  // Сначала ищем по адресу организации в городе, и только затем — по названию.
  // Совместная строка "адрес + компания" часто даёт плохие/пустые совпадения.
  const queries = [
    address ? [address, city, 'Россия'].filter(Boolean).join(', ') : '',
    companyName ? [companyName, city, 'Россия'].filter(Boolean).join(', ') : ''
  ].filter((query, index, all) => Boolean(query) && all.indexOf(query) === index)
  let result: { lat: number; lng: number } | null = null
  for (const query of queries) {
    result = await nominatimGeocode(query)
    if (result) break
  }
  if (!result) return undefined

  const coordinates = { ...result, source: 'nominatim' as const }
  geocodeCache[cacheKey] = coordinates
  geocodeDirty = true
  return coordinates
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
  industry_match: 'yes' | 'no' | 'unknown'
  industry_evidence: string
  city_match: 'yes' | 'no' | 'unknown'
  city_evidence: string
  customer_role: 'buyer' | 'supplier' | 'competitor' | 'other' | 'unknown'
  customer_role_evidence: string
  address: string
  address_evidence: string
  business_size: 'small' | 'medium' | 'large' | 'unknown'
  wholesale: boolean
  reason: string
}

async function generateWithOpenRouter(prompt: string): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY
  const model = process.env.OPENROUTER_MODEL
  if (!apiKey || !model) throw new Error('Для резервного LLM задайте OPENROUTER_API_KEY и OPENROUTER_MODEL')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30000)
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://autolead-ai', 'X-Title': 'AutoLead AI' },
      body: JSON.stringify({ model, temperature: 0, messages: [{ role: 'user', content: prompt }] }),
      signal: controller.signal
    })
    const body: any = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(`OpenRouter ${response.status}: ${body?.error?.message || response.statusText}`)
    const text = body?.choices?.[0]?.message?.content
    if (typeof text !== 'string' || !text.trim()) throw new Error('OpenRouter вернул пустой ответ')
    return text.trim()
  } finally {
    clearTimeout(timeout)
  }
}

async function extractWithLLM(companyName: string, domain: string, city: string, industry: string, content: string, offeredItems: CatalogItem[]): Promise<AiExtraction | null> {
  const hasGemini = Boolean(process.env.GEMINI_API_KEY)
  const hasOpenRouter = Boolean(process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_MODEL)
  if (!hasGemini && !hasOpenRouter) {
    console.warn('  ⚠️ LLM не настроена: укажите GEMINI_API_KEY или OPENROUTER_API_KEY вместе с OPENROUTER_MODEL')
    return null
  }
  const prompt = 'Оцени компанию как потенциального B2B-покупателя товаров поставщика. Целевой город: "' + city + '". Целевая отрасль/запрос: "' + industry + '". Компания: "' + companyName + '" (' + domain + '). Верни только JSON:\n' +
    '{\n  "industry_match": "yes|no|unknown", "industry_evidence": "дословная цитата", "city_match": "yes|no|unknown", "city_evidence": "дословная цитата",\n' +
    '  "address": "полный адрес или пустая строка", "address_evidence": "дословная цитата с адресом",\n' +
    '  "customer_role": "buyer|supplier|competitor|other|unknown", "customer_role_evidence": "дословная цитата",\n' +
    '  "lpr": [{"name": "Фамилия Имя", "position": "должность", "evidence": "точная цитата с сайта, содержащая имя"}],\n' +
    '  "business_size": "small|medium|large|unknown",\n  "wholesale": true/false,\n' +
    '  "reason": "одно предложение: почему этому лиду стоит продавать"\n}\n' +
    'Правила:\n' +
    '- industry_match=yes только если сайт прямо подтверждает нужную деятельность; no только при явном противоречии; иначе unknown.\n' +
    '- city_match=yes только если цитата полного адреса нужного филиала сама содержит целевой город и он совпадает с целевым городом поиска. Упоминания города в меню, списке регионов или других филиалах не считаются. Если адрес филиала не подтверждает город — unknown; если он в другом городе — no.\n' +
    '- Каталог поставщика: ' + (offeredItems.slice(0, 25).map(item => `${item.brand} ${item.name} ${item.car}`.trim()).join('; ') || 'не задан') + '.\n' +
    '- buyer — организация, которая покупает/использует/перепродаёт именно эти товары или их категорию. Одного совпадения отрасли недостаточно. Клиника не является покупателем автозапчастей. supplier/competitor — продавец или производитель той же категории.\n' +
    '- customer_role_evidence должно отдельно подтверждать коммерческую роль и не повторять цитату об отрасли. Все evidence дословно должны встречаться в исходном тексте. Не придумывай доказательства; если роли нет — unknown.\n' +
    '- lpr: до 2 людей, чьи имя и должность прямо подтверждаются текстом. Приведи точную цитату из текста без пересказа. Если цитаты нет — не включай человека.\n' +
    '- business_size: large — сеть/филиалы/50+ сотрудников/крупный склад; medium — 10-50 сотрудников, несколько точек; small — один магазин/СТО; unknown — непонятно.\n' +
    '- wholesale: true только при явных признаках опта в тексте (оптовые цены, "опт и розница", дистрибьютор, B2B).\n' +
    'Текст сайта (первые 8000 символов):\n"""\n' + content.slice(0, 8000) + '\n"""'

  let lastError: any = null
  const requestedProvider = process.env.AI_PROVIDER?.toLowerCase()
  const preferred = requestedProvider === 'openrouter' ? 'openrouter' : 'gemini'
  const providers = preferred === 'gemini' ? ['gemini', 'openrouter'] : ['openrouter', 'gemini']
  for (const provider of providers) {
    if (provider === 'gemini' && !hasGemini) continue
    if (provider === 'openrouter' && !hasOpenRouter) continue
    const attempts = provider === 'gemini' ? 2 : 1
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        let text: string
        if (provider === 'gemini') {
          const model = genAI.getGenerativeModel(
            { model: process.env.GEMINI_MODEL || 'gemini-3.8-flash' },
            { timeout: 20000 }
          )
          const result = await model.generateContent(prompt)
          text = result.response.text().trim()
        } else {
          text = await generateWithOpenRouter(prompt)
        }
        return parseAiExtraction(text, content, city, industry)
      } catch (err: any) {
        lastError = err
        const msg = String(err?.message || err)
        const isRetryable = /429|500|502|503|504|aborted|timed?\s*out|timeout|fetch failed|error fetching|network|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(msg)
        if (provider === 'gemini' && isRetryable && attempt < attempts) {
          console.log('  ⏳ Gemini временно недоступен, повтор 2/2...')
          await new Promise(r => setTimeout(r, 1200))
          continue
        }
        break
      }
    }
  }
  console.warn('  ⚠️ LLM недоступна; профиль лида будет помечен как требующий проверки: ' + String(lastError?.message || lastError || 'нет настроенного провайдера').slice(0, 160))
  return null
}

function parseAiExtraction(text: string, content: string, city: string, industry: string): AiExtraction {
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      if (!jsonMatch) throw new Error('AI вернул не JSON')
      const parsed = JSON.parse(jsonMatch[0])
      const source = normalizeEvidence(content)
      const validateQuote = (value: unknown) => {
        const quote = String(value || '').trim()
        return quote && source.includes(normalizeEvidence(quote)) ? quote : ''
      }
      const industry_evidence = validateQuote(parsed.industry_evidence)
      const city_evidence = validateQuote(parsed.city_evidence)
      const customer_role_evidence = validateQuote(parsed.customer_role_evidence)
      const address_evidence = validateQuote(parsed.address_evidence)
      const addressValue = String(parsed.address || '').trim()
      const address = addressValue && address_evidence && normalizeEvidence(address_evidence).includes(normalizeEvidence(addressValue)) ? addressValue.slice(0, 250) : ''
      const hasTargetTerm = (evidence: string, target: string) => {
        const normalizedEvidence = normalizeEvidence(evidence)
        const tokens = normalizeEvidence(target).split(' ').filter(token => token.length >= 4)
        return tokens.some(token => normalizedEvidence.includes(token.slice(0, Math.min(token.length, Math.max(3, token.length - 2)))))
      }
      const industryEvidenceSupportsTarget = hasTargetTerm(industry_evidence, industry)
      const cityEvidenceSupportsTarget = hasTargetTerm(city_evidence, city)
      const hasExactCityInAddress = (evidence: string, target: string) => {
        const words = normalizeEvidence(evidence).replace(/[^a-zа-яё0-9-]+/gi, ' ').split(/\s+/).filter(Boolean)
        const targetWords = normalizeEvidence(target).replace(/[^a-zа-яё0-9-]+/gi, ' ').split(/\s+/).filter(word => word.length >= 3)
        return targetWords.length > 0 && targetWords.every(token =>
          words.some(word => word === token || (token.length >= 8 && word.startsWith(token) && word.length <= token.length + 3))
        )
      }
      const addressEvidenceSupportsTargetCity = hasExactCityInAddress(address_evidence, city)
      const roleEvidenceIsDistinct = Boolean(customer_role_evidence && normalizeEvidence(customer_role_evidence) !== normalizeEvidence(industry_evidence))
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
        industry_match: industry_evidence && parsed.industry_match === 'no' ? 'no' : industryEvidenceSupportsTarget && parsed.industry_match === 'yes' ? 'yes' : 'unknown',
        industry_evidence,
        city_match: city_evidence && parsed.city_match === 'no'
          ? 'no'
          : cityEvidenceSupportsTarget && addressEvidenceSupportsTargetCity && parsed.city_match === 'yes'
            ? 'yes'
            : 'unknown',
        city_evidence,
        customer_role: roleEvidenceIsDistinct && ['buyer', 'supplier', 'competitor', 'other'].includes(parsed.customer_role) ? parsed.customer_role : 'unknown',
        customer_role_evidence: roleEvidenceIsDistinct ? customer_role_evidence : '',
        address,
        address_evidence: address ? address_evidence : '',
        business_size: ['small', 'medium', 'large'].includes(parsed.business_size) ? parsed.business_size : 'unknown',
        wholesale: Boolean(parsed.wholesale),
        reason: String(parsed.reason || '').slice(0, 300)
      }
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

function extractEmails(content: string): string[] {
  const emails = content.match(/[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || []
  return [...new Set(emails)].filter(e => !e.match(/\.(png|jpg|jpeg|gif|webp|svg)$/i)).slice(0, 5)
}

function inferVertical(value: string): 'automotive' | 'dental' | 'food' | 'unknown' {
  const text = normalizeEvidence(value)
  if (/стоматолог|дентал|зубн|ортодонт|имплант/.test(text)) return 'dental'
  if (/автозапчаст|автомобил|автосервис|автомагазин|сто\b|шиномонтаж|двигател|тормозн|сцеплен/.test(text)) return 'automotive'
  if (/снек|продукт|бакале|кондитер|напит|продоволь|пищев/.test(text)) return 'food'
  return 'unknown'
}

function catalogVertical(catalog: SupplierCatalog): 'automotive' | 'dental' | 'food' | 'unknown' {
  return inferVertical((catalog.items || []).map(item => `${item.brand} ${item.name} ${item.car}`).join(' '))
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function extractBrands(content: string, offeredBrands: string[] = []): string[] {
  const text = content.toLocaleLowerCase('ru-RU')
  const commercialContext = /(бренд|производител|каталог|ассортимент|товар|продукц|запчаст|артикул|купить|цена|в наличии|постав)/i
  const found = offeredBrands.filter(brand => {
    const safe = escapeRegExp(brand.toLocaleLowerCase('ru-RU'))
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${safe}(?=$|[^\\p{L}\\p{N}])`, 'giu')
    for (const match of text.matchAll(pattern)) {
      const at = match.index || 0
      const context = text.slice(Math.max(0, at - 100), Math.min(text.length, at + brand.length + 100))
      if (commercialContext.test(context)) return true
    }
    return false
  })
  return [...new Set(found)].slice(0, 6)
}

function extractAddress(content: string): string {
  const match = content.match(/адрес[:\s]+(.+?)(?:\n|,|$)/i)
  return match ? match[1].replace(/адрес[:\s]+/i, '').trim().slice(0, 120) : ''
}

// --- Скоринг ---
function calculateScoreBreakdown(cfg: ScoringConfig, input: {
  lprCount: number; emailsCount: number; brandsCount: number
  businessSize: 'small' | 'medium' | 'large' | 'unknown'
  wholesale: boolean; contentLength: number
}): { total: number; factors: { key: string; label: string; points: number; detail: string }[] } {
  const w = cfg.weights
  const brandPoints = input.brandsCount > 2 ? w.brands : input.brandsCount > 0 ? Math.round(w.brands / 2) : 0
  const sizePoints = cfg.businessSizeScores[input.businessSize] ?? cfg.businessSizeScores.unknown
  const contentPoints = input.contentLength > 1500 ? w.content : input.contentLength > 500 ? Math.round(w.content / 2) : 0
  const factors = [
    { key: 'lpr', label: 'ЛПР', points: input.lprCount > 0 ? w.lpr : 0, detail: input.lprCount > 0 ? `Найдено: ${input.lprCount}` : 'Не найдено' },
    { key: 'emails', label: 'Email сайта', points: input.emailsCount > 0 ? w.emails : 0, detail: input.emailsCount > 0 ? `Найдено адресов: ${input.emailsCount}` : 'Не найдено' },
    { key: 'brands', label: 'Совпадение брендов', points: brandPoints, detail: input.brandsCount > 0 ? `Совпало с каталогом: ${input.brandsCount}` : 'Совпадений с каталогом нет' },
    { key: 'businessSize', label: 'Размер бизнеса', points: sizePoints, detail: input.businessSize === 'large' ? 'Крупный бизнес' : input.businessSize === 'medium' ? 'Средний бизнес' : input.businessSize === 'small' ? 'Малый бизнес' : 'Размер не определён' },
    { key: 'wholesale', label: 'Оптовый профиль', points: input.wholesale ? w.wholesale : -cfg.retailPenalty, detail: input.wholesale ? 'Оптовый профиль подтверждён' : 'Оптовый профиль не подтверждён; применён штраф' },
    { key: 'content', label: 'Содержимое сайта', points: contentPoints, detail: input.contentLength > 1500 ? 'Достаточно данных для анализа' : input.contentLength > 500 ? 'Неполные данные' : 'Мало данных на странице' },
  ]
  const total = Math.max(0, Math.min(factors.reduce((sum, factor) => sum + factor.points, 0), 100))
  return { total, factors }
}

function calculateLeadScore(cfg: ScoringConfig, input: {
  lprCount: number; emailsCount: number; brandsCount: number
  businessSize: 'small' | 'medium' | 'large' | 'unknown'
  wholesale: boolean; contentLength: number
}): number {
  return calculateScoreBreakdown(cfg, input).total
}

function getLeadTier(cfg: ScoringConfig, score: number): 'A' | 'B' | 'C' {
  if (score >= cfg.tiers.a) return 'A'
  if (score >= cfg.tiers.b) return 'B'
  return 'C'
}

// Пересчёт скоринга существующих лидов текущей моделью (для старых записей
// с устаревшим скором и для смены scoring_config)
export function rescoreLead(lead: any, overrides?: Partial<ScoringConfig> | null, catalogOverride?: SupplierCatalog): any {
  const cfg = loadScoringConfig(overrides)
  const catalog = loadCatalog(catalogOverride)
  const matched_brands = getMatchedBrands(Array.isArray(lead.brands) ? lead.brands : [], catalog)
  const size = ['small', 'medium', 'large'].includes(lead.business_size) ? lead.business_size : 'unknown'
  const score_breakdown = calculateScoreBreakdown(cfg, {
    lprCount: Array.isArray(lead.lpr) ? lead.lpr.length : 0,
    emailsCount: lead.email_source === 'website' && Array.isArray(lead.lpr_emails) ? lead.lpr_emails.length : 0,
    brandsCount: matched_brands.length,
    businessSize: size,
    wholesale: Boolean(lead.wholesale),
    contentLength: 0 // у старых лидов нет исходного текста сайта — не учитываем
  })
  const score = score_breakdown.total
  // Контент не сохраняем у лидов, поэтому чтобы не занижать всех старых записей,
  // Даём половину веса контента по умолчанию, так как исходный текст старой записи не хранится.
  const fallbackContentPoints = Math.round(cfg.weights.content / 2)
  const withContentFallback = Math.min(100, score + fallbackContentPoints)
  const factors = score_breakdown.factors.map(factor => factor.key === 'content'
    ? { ...factor, points: fallbackContentPoints, detail: 'Текст страницы не сохранён; применена половина веса' }
    : factor)
  return { ...lead, matched_brands, matched_skus: matchCatalogItems(Array.isArray(lead.brands) ? lead.brands : [], catalog), score_breakdown: { total: withContentFallback, factors }, lead_score: withContentFallback, lead_tier: getLeadTier(cfg, withContentFallback) }
}

// --- Этап 1: Поиск компаний через Tavily ---
export async function searchCompanies(city: string, industry: string, limit: number = 10) {
  console.log(`🔍 Поиск компаний: ${city}, ${industry}`)

  // Не добавляем «оптом»: это уводит выдачу к конкурентам и поставщикам,
  // хотя менеджер часто ищет именно потенциальных покупателей.
  const query = `${industry} ${city} официальный сайт организации`
  const shortQuery = `${industry} ${city} компании адрес`
  let lastError: any = null

  // Tavily SDK по умолчанию ждёт до 60 секунд. Ограничиваем одну попытку,
  // чтобы задача не зависала на минуту на каждом запросе.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await tvly.search(attempt === 1 ? query : shortQuery, {
        searchDepth: 'basic',
        maxResults: limit,
        timeout: 25
      })
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
        snippet: result.content || '',
        source_provider: 'Tavily' as const,
        source_url: result.url,
        source_title: result.title || '',
        source_snippet: result.content || ''
      }))
      console.log(`✅ Найдено ${companies.length} компаний`)
      return companies
    } catch (error: any) {
      lastError = error
      const msg = String(error?.message || error)
      const is429 = msg.includes('429') || msg.toLowerCase().includes('rate limit')
      const isTransient = /\b(502|503|504)\b/i.test(msg) || /timed?\s*out|timeout|fetch failed|network|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|aborted/i.test(msg)
      console.error(`❌ Ошибка Tavily (попытка ${attempt}/2):`, msg.slice(0, 120))
      if (!is429 && !isTransient) {
        break
      }
      if (attempt < 2) await new Promise(r => setTimeout(r, is429 ? 2500 : 1000))
    }
  }

  // Если Tavily недоступен/завис, используем поиск Firecrawl как резервный источник.
  // Это сохраняет основной сценарий поиска, если в проекте настроен FIRECRAWL_API_KEY.
  if (process.env.FIRECRAWL_API_KEY) {
    try {
      console.warn('⚠️ Tavily не ответил; пробуем резервный поиск Firecrawl')
      const response = await firecrawlApp.search(shortQuery, {
        limit,
        timeout: 30000,
        lang: 'ru',
        country: 'ru'
      })
      if (response.success) {
        const companies = (response.data || []).flatMap((result: any) => {
          const url = result.url || result.metadata?.sourceURL
          if (!url) return []
          try {
            const parsed = new URL(url)
            if (isExcludedDomain(parsed.hostname.toLowerCase())) return []
            return [{
              company_name: result.title || result.metadata?.title || 'Неизвестная компания',
              domain: parsed.hostname.replace(/^www\./, ''),
              url,
              snippet: result.markdown || result.description || result.metadata?.description || '',
              source_provider: 'Firecrawl' as const,
              source_url: url,
              source_title: result.title || result.metadata?.title || '',
              source_snippet: result.markdown || result.description || result.metadata?.description || ''
            }]
          } catch { return [] }
        })
        console.log(`✅ Firecrawl нашёл ${companies.length} компаний (резервный поиск)`)
        return companies
      }
      throw new Error(response.error || 'Firecrawl вернул неуспешный ответ')
    } catch (fallbackError: any) {
      const fallbackMessage = String(fallbackError?.message || fallbackError).slice(0, 180)
      const tavilyMessage = String(lastError?.message || lastError || 'неизвестная ошибка').slice(0, 180)
      throw new Error(`Поиск не выполнен: Tavily — ${tavilyMessage}; Firecrawl — ${fallbackMessage}`)
    }
  }

  throw new Error(`Tavily: ${String(lastError?.message || lastError || 'неизвестная ошибка').slice(0, 200)}. Проверьте TAVILY_API_KEY и доступ к API.`)
}

async function findPublicSocialSources(companyName: string, city: string, industry: string): Promise<{ provider: 'VK' | 'Telegram'; url: string; title: string; snippet?: string }[]> {
  if (!process.env.TAVILY_API_KEY) return []
  const stopWords = new Set(['ооо', 'ао', 'пао', 'зао', 'ип', 'компания', 'официальный', 'сайт', 'клиника', 'стоматология', 'медицинский', 'центр'])
  const nameTokens = normalizeEvidence(companyName).replace(/[^a-zа-яё0-9]+/gi, ' ').split(/\s+/).filter(token => token.length >= 4 && !stopWords.has(token))
  if (!nameTokens.length) return []
  try {
    const response = await tvly.search(`site:vk.com OR site:t.me "${companyName}" ${city} ${industry}`, {
      searchDepth: 'basic',
      maxResults: 8,
      timeout: 12
    })
    const sources: { provider: 'VK' | 'Telegram'; url: string; title: string; snippet?: string }[] = []
    for (const result of response.results || []) {
      try {
        const parsed = new URL(result.url)
        const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
        const provider = host === 'vk.com' || host.endsWith('.vk.com')
          ? 'VK'
          : host === 't.me' || host === 'telegram.me' || host.endsWith('.telegram.me')
            ? 'Telegram'
            : null
        if (!provider) continue
        const title = String(result.title || '').trim()
        const snippet = String(result.content || '').replace(/\s+/g, ' ').trim().slice(0, 400)
        const searchable = normalizeEvidence(`${title} ${snippet} ${parsed.pathname}`)
        const matchedTokens = nameTokens.filter(token => searchable.includes(token))
        if (matchedTokens.length < Math.min(2, nameTokens.length)) continue
        if (sources.some(source => source.url === result.url)) continue
        sources.push({ provider, url: result.url, title: title || result.url, snippet })
        if (sources.length >= 3) break
      } catch { /* пропускаем некорректные ссылки */ }
    }
    return sources
  } catch (error: any) {
    console.warn('  ⚠️ Поиск публичных страниц в соцсетях недоступен:', String(error?.message || error).slice(0, 120))
    return []
  }
}

// --- Этап 2: Обогащение данных через Firecrawl ---
export async function enrichCompanyData(companies: any[], city: string, industry: string, onProgress?: (processed: number, total: number) => void, options?: PipelineOptions) {
  console.log('🕷️ Обогащение данных...')
  const scoringCfg = loadScoringConfig(options?.scoring)
  const catalog = loadCatalog(options?.supplierCatalog)
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

      // Ищем только публичные страницы компаний; ссылки соцсетей не используются как доказательство профиля или города.
      const [ai, social_sources] = await Promise.all([
        useAI ? extractWithLLM(company.company_name, company.domain, city, industry, content, catalog.items) : Promise.resolve(null),
        findPublicSocialSources(company.company_name, city, industry)
      ])
      const lpr = ai && ai.lpr.length > 0 ? ai.lpr : extractLPRRegex(content)
      const businessSize = ai && ai.industry_match === 'yes' && ai.city_match === 'yes' ? ai.business_size : 'unknown'
      const wholesale = ai && ai.industry_match === 'yes' && ai.city_match === 'yes' ? ai.wholesale : false
      const reason = ai?.industry_evidence && ai?.city_evidence && ai?.customer_role_evidence && ai?.customer_role === 'buyer'
        ? `Профиль подтверждён цитатами сайта: отрасль — «${ai.industry_evidence}»; город — «${ai.city_evidence}»; роль покупателя — «${ai.customer_role_evidence}».`
        : ''
      const industryVertical = inferVertical(industry)
      const supplierVertical = catalogVertical(catalog)
      const catalogConflict = industryVertical !== 'unknown' && supplierVertical !== 'unknown' && industryVertical !== supplierVertical
      const explicitMismatch = catalogConflict || ai?.industry_match === 'no' || ai?.city_match === 'no' || ['supplier', 'competitor', 'other'].includes(ai?.customer_role || '')
      const qualificationStatus = explicitMismatch
        ? 'not_qualified'
        : ai?.industry_match === 'yes' && ai?.city_match === 'yes' && ai?.customer_role === 'buyer'
          ? 'qualified'
          : 'needs_review'

      // Email: только адреса из текста сайта; принадлежность ЛПР не предполагается.
      const siteEmails = extractEmails(content)
      const lpr_emails = siteEmails
      const email_source = siteEmails.length > 0 ? 'website' : 'none'

      const brands = catalogConflict ? [] : extractBrands(content, catalog.items.map(item => item.brand))
      const matched_brands = getMatchedBrands(brands, catalog)
      const address = ai?.address || extractAddress(content)
      const verifiedCity = ai?.city_match === 'yes' ? city : ''
      const geocoding = verifiedCity ? await getCoordinates(company.company_name, verifiedCity, options?.useGeocode ?? true, address) : undefined
      const score_breakdown = calculateScoreBreakdown(scoringCfg, {
        lprCount: lpr.length,
        emailsCount: siteEmails.length,
        brandsCount: matched_brands.length,
        businessSize,
        wholesale,
        contentLength: content.length
      })
      const rawLeadScore = score_breakdown.total
      // Высокий скор нельзя выдавать без подтверждения отрасли и адреса филиала в целевом городе.
      const lead_score = qualificationStatus === 'qualified'
        ? rawLeadScore
        : qualificationStatus === 'not_qualified' ? 0 : Math.min(rawLeadScore, Math.max(0, scoringCfg.tiers.b - 1))
      if (lead_score !== rawLeadScore) {
        score_breakdown.factors.push({
          key: 'qualification',
          label: 'Проверка профиля',
          points: lead_score - rawLeadScore,
          detail: qualificationStatus === 'not_qualified' ? 'Не соответствует профилю или целевому городу' : 'Ограничение до проверки профиля и адреса'
        })
        score_breakdown.total = lead_score
      }
      const lead_tier = getLeadTier(scoringCfg, lead_score)
      const matched_skus = matchCatalogItems(brands, catalog)

      enrichedLeads.push({
        company_name: company.company_name,
        domain: company.domain,
        city: verifiedCity,
        requested_city: city,
        industry,
        source_provider: company.source_provider,
        source_url: company.source_url || company.url,
        source_title: company.source_title || company.company_name,
        source_snippet: String(company.source_snippet || company.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 500),
        social_sources,
        qualification_status: qualificationStatus,
        llm_status: useAI ? (ai ? 'ok' : 'unavailable') : 'disabled',
        industry_evidence: ai?.industry_evidence || '',
        city_evidence: ai?.city_evidence || '',
        customer_role: ai?.customer_role || 'unknown',
        customer_role_evidence: ai?.customer_role_evidence || '',
        address_evidence: ai?.address_evidence || '',
        address,
        coordinates: geocoding ? { lat: geocoding.lat, lng: geocoding.lng } : undefined,
        coordinate_source: geocoding?.source,
        lpr,
        lpr_emails,
        email_source,
        brands,
        matched_brands,
        lead_score,
        lead_tier,
        score_breakdown,
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

// --- Формирование КП по карточке поставщика и каталогу (быстрый HTML-шаблон) ---
function escapeHtml(value: unknown): string {
  const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  return String(value ?? '').replace(/[&<>"']/g, c => entities[c] || c)
}

// Формирует фактическое КП из карточки поставщика и совпавших товаров без ожидания LLM.
export async function generateKP(lead: any, supplierInput: any, hooks?: { onKP?: (filename: string, content: string) => void | Promise<void> }) {
  console.log(`📝 Формирование КП для ${lead.company_name}...`)
  try {
    const supplier = typeof supplierInput === 'string' ? { name: supplierInput } : (supplierInput || {})
    const products = Array.isArray(lead.matched_skus) ? lead.matched_skus : []
    const productsTable = buildProductsTable(products)
    const recipient = Array.isArray(lead.lpr) && lead.lpr[0]?.name ? `Уважаемый(ая) ${escapeHtml(lead.lpr[0].name)}!` : 'Добрый день!'
    const supplierName = escapeHtml(supplier.name || supplier.supplier_name || 'Поставщик')
    const contactLines = [
      supplier.contact && `Контактное лицо: ${escapeHtml(supplier.contact)}`,
      supplier.phone && `Телефон: ${escapeHtml(supplier.phone)}`,
      supplier.email && `Email: ${escapeHtml(supplier.email)}`,
      supplier.website && `Сайт: ${escapeHtml(supplier.website)}`,
      supplier.inn && `ИНН: ${escapeHtml(supplier.inn)}`,
      supplier.address && `Адрес: ${escapeHtml(supplier.address)}`
    ].filter(Boolean).map(line => `<p>${line}</p>`).join('')
    const terms = [
      supplier.payment_terms && `<li><b>Оплата:</b> ${escapeHtml(supplier.payment_terms)}</li>`,
      supplier.delivery && `<li><b>Доставка:</b> ${escapeHtml(supplier.delivery)}</li>`,
      supplier.warranty && `<li><b>Гарантия:</b> ${escapeHtml(supplier.warranty)}</li>`,
      supplier.offer_validity && `<li><b>Срок действия предложения:</b> ${escapeHtml(supplier.offer_validity)}</li>`
    ].filter(Boolean).join('')
    const customOffer = supplier.offer_text ? `<p>${escapeHtml(supplier.offer_text).replace(/\n/g, '<br>')}</p>` : ''
    const brands = (lead.matched_brands || []).map(escapeHtml).join(', ')
    const productsBlock = productsTable
      ? `<h2>Предложение по ассортименту${brands ? `: ${brands}` : ''}</h2>${productsTable}`
      : `<h2>Ассортимент</h2><p>Подготовим предложение по интересующим вас брендам и артикулам после уточнения потребности.</p>`
    const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Коммерческое предложение — ${escapeHtml(lead.company_name)}</title><style>body{font:15px/1.55 Arial,sans-serif;color:#172033;max-width:900px;margin:36px auto;padding:0 24px}h1{font-size:26px}h2{font-size:18px;margin-top:28px}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid #cbd5e1;padding:8px;text-align:left}th{background:#f1f5f9}.muted{color:#64748b}</style></head><body><h1>Коммерческое предложение</h1><p class="muted">${new Date().toLocaleDateString('ru-RU')}</p><p>${recipient}</p><p>Компания <b>${escapeHtml(lead.company_name)}</b>${lead.city ? `, ${escapeHtml(lead.city)}` : ''}.</p><p>${supplierName} предлагает рассмотреть условия сотрудничества по поставке автозапчастей.</p>${customOffer}${productsBlock}${terms ? `<h2>Условия сотрудничества</h2><ul>${terms}</ul>` : ''}<h2>Связаться с поставщиком</h2>${contactLines || '<p>Контактные данные поставщика не заполнены.</p>'}<p>Будем рады уточнить вашу потребность и подготовить актуальный расчёт.</p></body></html>`
    const slug = String(lead.company_name || 'lead').replace(/[^a-z0-9а-яё]/gi, '_').slice(0, 55) || 'lead'
    const safeId = String(lead.id || Date.now()).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)
    const fileName = `${slug}_${safeId}.html`
    try {
      const filePath = path.join(rootDir, 'kp_final', fileName)
      if (!fs.existsSync(path.join(rootDir, 'kp_final'))) fs.mkdirSync(path.join(rootDir, 'kp_final'))
      fs.writeFileSync(filePath, html, 'utf-8')
    } catch { /* локальная копия не критична */ }
    if (hooks?.onKP) await hooks.onKP(fileName, html)
    console.log(`✅ КП сформировано: ${fileName}`)
    return fileName
  } catch (error) {
    console.error('❌ Ошибка формирования КП:', error)
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

  const leads = await enrichCompanyData(companies, city, industry, (p, t) => onProgress?.('enrich', p, t), options)
  if (companies.length > 0 && leads.length === 0) {
    // Компании нашлись, но ни один сайт не спарсился — почти всегда это проблема Firecrawl
    throw new Error(`Firecrawl: найдено ${companies.length} компаний, но ни один сайт не удалось спарсить. Проверьте FIRECRAWL_API_KEY и баланс кредитов.`)
  }
  saveGeocodeCache()
  console.log('✅ Пайплайн завершен!')
  return leads
}
