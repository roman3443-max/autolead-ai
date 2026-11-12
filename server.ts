import express from 'express'
import cors from 'cors'
import path from 'path'
import { runPipeline, generateKP, rescoreLead, loadSearchDefaults, loadCatalog, matchCatalogItems, getCoordinates } from './src/pipeline.ts'
import { db, initDb, closeDb, dbMode } from './src/db/index.ts'
import { authMiddleware, loginHandler, requireAdmin, assertAuthConfig } from './src/auth.ts'
import { orphanedRunningSearchTasks } from './src/lib/searchTaskRecovery.ts'

const app = express()
const PORT = process.env.PORT || 3001

// Разрешённые источники (CORS). Переопределяется переменной ALLOWED_ORIGINS через запятую
const DEFAULT_ORIGINS = [
  'https://autolead-ai-rosy.vercel.app',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  'http://localhost:3001'
]
const allowedOrigins = (process.env.ALLOWED_ORIGINS || DEFAULT_ORIGINS.join(',')).split(',').map(s => s.trim()).filter(Boolean)

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true)
    callback(new Error('Not allowed by CORS'))
  },
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-token']
}))
app.use(express.json({ limit: '1mb' }))

// Заголовки безопасности
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  next()
})

// Rate limit на запуск пайплайна
const RUN_COOLDOWN_MS = (parseInt(process.env.RUN_COOLDOWN_SECONDS || '') || 120) * 1000
let lastRunAt = 0
const runCooldown = (req: any, res: any, next: any) => {
  const wait = RUN_COOLDOWN_MS - (Date.now() - lastRunAt)
  if (wait > 0) {
    return res.status(429).json({ error: `Слишком частые запуски. Подождите ${Math.ceil(wait / 1000)} сек.` })
  }
  lastRunAt = Date.now()
  next()
}

function getSupplierCatalog(profile: any = {}) {
  const fallback = loadCatalog()
  return {
    ...fallback,
    supplier_name: profile.name || fallback.supplier_name || 'УралАвтоОпт',
    payment_terms: profile.payment_terms || fallback.payment_terms || '',
    delivery: profile.delivery || fallback.delivery || '',
    items: Array.isArray(profile.catalogItems) ? profile.catalogItems : fallback.items,
  }
}
function normalizeLeadDomain(value: unknown): string {
  const raw = String(value || '').trim()
  if (!raw) return ''
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`)
    const host = url.hostname.toLowerCase().replace(/^www\./, '')
    return host.includes('.') || host === 'localhost' ? host : ''
  } catch { return '' }
}

function normalizeLeadText(value: unknown): string {
  return String(value || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/gi, ' ').trim()
}

function getLeadDedupeKeys(lead: any): string[] {
  const keys: string[] = []
  const domain = normalizeLeadDomain(lead.domain)
  if (domain) keys.push(`domain:${domain}`)
  const company = normalizeLeadText(lead.company_name)
  if (company) keys.push(`company:${company}|city:${normalizeLeadText(lead.city)}`)
  return keys
}
function hasValidCoordinates(coordinates: any): boolean {
  if (!coordinates || coordinates.lat === '' || coordinates.lng === '' || coordinates.lat === null || coordinates.lng === null) return false
  const lat = Number(coordinates.lat), lng = Number(coordinates.lng)
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
}

function pointInRing(lng: number, lat: number, ring: [number, number][]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j]
    const cross = (lng - xi) * (yj - yi) - (lat - yi) * (xj - xi)
    const onSegment = Math.abs(cross) < 1e-10 &&
      lng >= Math.min(xi, xj) - 1e-10 && lng <= Math.max(xi, xj) + 1e-10 &&
      lat >= Math.min(yi, yj) - 1e-10 && lat <= Math.max(yi, yj) + 1e-10
    if (onSegment) return true
    const intersects = ((yi > lat) !== (yj > lat)) &&
      (lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)
    if (intersects) inside = !inside
  }
  return inside
}

async function assignLeadToKnownSector(lead: any): Promise<void> {
  if (!hasValidCoordinates(lead?.coordinates)) return
  const sectors = await db.sectors.list()
  const sector = sectors.find((candidate: any) => {
    const ring = candidate?.polygon?.geometry?.coordinates?.[0]
    return Array.isArray(ring) && ring.length >= 4 && pointInRing(lead.coordinates.lng, lead.coordinates.lat, ring)
  })
  if (sector) await db.leads.update(lead.id, { sector_id: sector.id, assigned_manager_id: sector.manager_id })
}

// Безопасное имя файла КП (защита от path traversal)
const kpFileName = (fileName: any): string | null => {
  if (typeof fileName !== 'string' || fileName.length === 0 || fileName.length > 120) return null
  if (fileName !== path.basename(fileName)) return null
  return fileName
}

// ---------- auth ----------
app.get('/api/health', (req, res) => {
  res.json({ ok: true })
})

app.post('/api/auth/login', loginHandler)
app.get('/api/auth/me', authMiddleware, (req: any, res) => res.json(req.user))
app.use('/api', authMiddleware)

app.post('/api/map/city-center', async (req, res) => {
  const city = String(req.body?.city || '').trim()
  if (city.length < 2 || city.length > 100) return res.status(400).json({ error: 'Укажите город' })
  if ([...city].some(char => char.codePointAt(0) === 0xfffd)) return res.status(400).json({ error: 'Название города содержит ошибку кодировки' })
  try {
    const coordinates = await getCoordinates('', city, true)
    if (!coordinates) return res.status(404).json({ error: `Не удалось найти город «${city}»` })
    res.json({ city, coordinates: { lat: coordinates.lat, lng: coordinates.lng } })
  } catch (error) {
    console.error('❌ Ошибка поиска центра города:', error)
    res.status(500).json({ error: 'Не удалось определить центр города' })
  }
})

// ---------- leads ----------
app.get('/api/leads', async (req, res) => {
  res.json(await db.leads.list())
})

app.post('/api/leads/geocode-missing', async (req, res) => {
  const rawIds = req.body?.leadIds
  if (!Array.isArray(rawIds) || rawIds.length === 0) return res.status(400).json({ error: 'Не выбраны лиды для поиска координат' })
  if (rawIds.length > 50) return res.status(400).json({ error: 'За один запуск можно обработать не более 50 лидов' })
  const ids = new Set(rawIds.map((id: any) => String(id)).filter(Boolean))
  try {
    const allLeads = await db.leads.list()
    const candidates = allLeads.filter((lead: any) => ids.has(String(lead.id)) && !hasValidCoordinates(lead.coordinates))
    let geocoded = 0
    let failed = 0
    for (const lead of candidates) {
      if (!String(lead.city || '').trim()) {
        failed++
        continue
      }
      const coordinates = await getCoordinates(String(lead.company_name || ''), String(lead.city || ''), true, String(lead.address || ''))
      if (!coordinates) {
        failed++
        continue
      }
      const updatedLead = {
        ...lead,
        coordinates: { lat: coordinates.lat, lng: coordinates.lng },
        coordinate_source: 'nominatim',
      }
      await db.leads.update(lead.id, {
        coordinates: updatedLead.coordinates,
        coordinate_source: updatedLead.coordinate_source,
      })
      await assignLeadToKnownSector(updatedLead)
      geocoded++
    }
    res.json({ requested: ids.size, processed: candidates.length, geocoded, failed, remaining: failed })
  } catch (error) {
    console.error('❌ Ошибка геокодирования лидов:', error)
    res.status(500).json({ error: 'Не удалось найти координаты для выбранных лидов' })
  }
})

app.post('/api/leads/import', async (req, res) => {
  const rows = req.body?.leads
  if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'В CSV нет строк для импорта' })
  if (rows.length > 1000) return res.status(400).json({ error: 'За один раз можно импортировать не более 1000 строк' })
  const dryRun = req.body?.dryRun === true
  const sourceName = String(req.body?.sourceName || 'Внешняя база').trim().slice(0, 120)
  try {
    const existingLeads = await db.leads.list()
    const knownKeys = new Set(existingLeads.flatMap((lead: any) => getLeadDedupeKeys(lead)))
    const supplier = (await db.settings.get('supplier_config')) || {}
    const catalog = getSupplierCatalog(supplier)
    const scoring = (await db.settings.get('scoring_config')) || {}
    const newPreview: any[] = []
    const duplicatePreview: any[] = []
    const invalidRows: any[] = []
    let imported = 0
    let importable = 0
    let duplicates = 0
    let needsReview = 0

    for (const [index, raw] of rows.entries()) {
      const company_name = String(raw?.company_name || '').trim().slice(0, 200)
      if (company_name.length < 2) {
        invalidRows.push({ row: index + 1, company_name, reason: 'Не указано название компании' })
        continue
      }
      const domain = normalizeLeadDomain(raw?.domain || raw?.website)
      const city = String(raw?.city || '').trim().slice(0, 100)
      const industry = String(raw?.industry || '').trim().slice(0, 120)
      const phone = String(raw?.phone || '').trim().slice(0, 80)
      const rawEmails = Array.isArray(raw?.lpr_emails) ? raw.lpr_emails : String(raw?.email || '').split(/[;,|]/)
      const rawEmailValues = rawEmails.map((email: any) => String(email).trim().toLowerCase()).filter(Boolean)
      const lpr_emails = [...new Set(rawEmailValues.filter((email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))].slice(0, 10)
      const rawLpr = Array.isArray(raw?.lpr) ? raw.lpr : (raw?.lpr_name ? [{ name: raw.lpr_name, position: raw.lpr_position || '' }] : [])
      const lpr = rawLpr.slice(0, 5).map((person: any) => ({ name: String(person?.name || '').trim(), position: String(person?.position || '').trim(), evidence: '' })).filter((person: any) => person.name)
      const rawBrands = Array.isArray(raw?.brands) ? raw.brands : String(raw?.brands || '').split(/[;,|]/)
      const brands = [...new Set(rawBrands.map((brand: any) => String(brand).trim()).filter(Boolean))].slice(0, 30)
      const lat = Number(raw?.lat), lng = Number(raw?.lng)
      const hasCoordinates = Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
      const lead: any = {
        company_name, domain, city, industry, address: String(raw?.address || '').trim().slice(0, 250),
        phone,
        coordinates: hasCoordinates ? { lat, lng } : undefined,
        coordinate_source: hasCoordinates ? 'import' : undefined,
        lpr, lpr_emails, email_source: lpr_emails.length ? 'import' : 'none', brands,
        business_size: 'unknown', wholesale: false, reason: '', matched_brands: [], matched_skus: [],
        status: 'new', pdf_file: null, comments: [],
        status_history: [{ status: 'new', date: new Date().toLocaleString('ru-RU') }],
        source_type: 'import', source_name: sourceName, search_task_name: `Импорт: ${sourceName}`,
      }
      const qualityWarnings: string[] = []
      if (!city) qualityWarnings.push('не указан город')
      if (!industry) qualityWarnings.push('не указан вид деятельности')
      if (!domain) qualityWarnings.push('не указан сайт')
      if (!phone && !lpr_emails.length) qualityWarnings.push('нет телефона и email')
      if (rawEmailValues.length > lpr_emails.length) qualityWarnings.push('есть email в неверном формате')
      if (!lpr.length) qualityWarnings.push('не указано контактное лицо')
      if (!brands.length) qualityWarnings.push('не указаны бренды')
      if (!hasCoordinates) qualityWarnings.push(String(raw?.lat ?? '').trim() || String(raw?.lng ?? '').trim() ? 'координаты некорректны' : 'нет координат для карты')
      const keys = getLeadDedupeKeys(lead)
      if (keys.some(key => knownKeys.has(key))) {
        duplicates++
        if (duplicatePreview.length < 20) duplicatePreview.push({ row: index + 1, company_name, domain, city })
        keys.forEach(key => knownKeys.add(key))
        continue
      }
      const scored = rescoreLead(lead, scoring, catalog)
      importable++
      if (qualityWarnings.length) needsReview++
      if (newPreview.length < 20) newPreview.push({ row: index + 1, company_name, domain, city, industry, lead_score: scored.lead_score, lead_tier: scored.lead_tier, qualityWarnings })
      if (!dryRun) {
        const id = `lead_import_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 6)}`
        const importedLead = { ...scored, id }
        await db.leads.create(importedLead)
        await assignLeadToKnownSector(importedLead)
        imported++
      }
      keys.forEach(key => knownKeys.add(key))
    }
    res.json({ dryRun, total: rows.length, importable, imported, duplicates, invalid: invalidRows.length, needsReview, newPreview, duplicatePreview, invalidRows })
  } catch (error) {
    console.error('❌ Ошибка импорта лидов:', error)
    res.status(500).json({ error: 'Не удалось обработать файл импорта' })
  }
})
app.post('/api/leads/:id/follow-up', async (req, res) => {
  const lead = await db.leads.get(req.params.id)
  if (!lead) return res.status(404).json({ error: 'Лид не найден' })
  const body = req.body || {}
  let nextContactAt = lead.next_contact_at || null
  let scheduleChanged = false
  if (Object.prototype.hasOwnProperty.call(body, 'next_contact_at')) {
    if (body.next_contact_at === null || body.next_contact_at === '') {
      nextContactAt = null
    } else {
      const parsed = new Date(body.next_contact_at)
      if (!Number.isFinite(parsed.getTime())) return res.status(400).json({ error: 'Укажите корректные дату и время следующего контакта' })
      nextContactAt = parsed.toISOString()
    }
    scheduleChanged = nextContactAt !== (lead.next_contact_at || null)
  }
  const note = String(body.note || '').trim()
  if (note.length > 2000) return res.status(400).json({ error: 'Заметка не должна превышать 2000 символов' })
  const allowedOutcomes = ['reached', 'no_answer', 'requested_quote', 'proposal_sent', 'not_interested', 'wrong_contact']
  const outcome = String(body.outcome || '')
  if (outcome && !allowedOutcomes.includes(outcome)) return res.status(400).json({ error: 'Неизвестный результат контакта' })
  if (outcome === 'proposal_sent' && !lead.pdf_file) return res.status(409).json({ error: 'Сначала сформируйте КП, затем отметьте его отправку' })
  if (body.next_contact_at === undefined && !note && !outcome) return res.status(400).json({ error: 'Укажите результат контакта, дату или заметку' })

  const activities = Array.isArray(lead.activities) ? [...lead.activities] : []
  if (note || scheduleChanged || outcome) {
    activities.unshift({
      id: `activity_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      created_at: new Date().toISOString(),
      note: note || (outcome ? 'Результат контакта зафиксирован' : nextContactAt ? 'Назначен следующий контакт' : 'Дата следующего контакта снята'),
      outcome: outcome || undefined,
      next_contact_at: nextContactAt,
    })
  }
  const status = outcome === 'proposal_sent' ? 'contacted' : lead.status
  const status_history = status !== lead.status
    ? [...(Array.isArray(lead.status_history) ? lead.status_history : []), { status, date: new Date().toLocaleString('ru-RU') }]
    : lead.status_history
  const updated = await db.leads.update(lead.id, {
    next_contact_at: nextContactAt,
    activities: activities.slice(0, 100),
    status,
    status_history,
  })
  res.json(updated)
})

app.put('/api/leads/:id', async (req, res) => {
  const body: any = { ...req.body }
  if (body.status === 'contacted') {
    const current = await db.leads.get(req.params.id)
    if (current && current.status !== 'contacted') return res.status(409).json({ error: 'Зафиксируйте фактическую отправку КП в блоке «Результат контакта»' })
  }
  if (body.company_name !== undefined) {
    body.company_name = String(body.company_name || '').trim()
    if (body.company_name.length < 2 || body.company_name.length > 200) {
      return res.status(400).json({ error: 'Название компании должно быть от 2 до 200 символов' })
    }
  }
  if (body.domain !== undefined) {
    const rawDomain = String(body.domain || '').trim()
    const normalizedDomain = rawDomain ? normalizeLeadDomain(rawDomain) : ''
    if (rawDomain && !normalizedDomain) return res.status(400).json({ error: 'Укажите корректный сайт или домен' })
    body.domain = normalizedDomain
  }
  for (const [field, limit] of [['city', 100], ['industry', 120], ['address', 250], ['phone', 80]] as [string, number][]) {
    if (body[field] !== undefined) {
      body[field] = String(body[field] || '').trim()
      if (body[field].length > limit) return res.status(400).json({ error: `Поле "${field}" не должно превышать ${limit} символов` })
    }
  }
  if (body.lpr !== undefined) {
    if (!Array.isArray(body.lpr) || body.lpr.length > 5) return res.status(400).json({ error: 'Можно сохранить не более 5 контактных лиц' })
    body.lpr = body.lpr.map((person: any) => ({
      name: String(person?.name || '').trim().slice(0, 120),
      position: String(person?.position || '').trim().slice(0, 120),
      evidence: String(person?.evidence || '').trim().slice(0, 1000),
    })).filter((person: any) => person.name)
  }
  if (body.lpr_emails !== undefined) {
    if (!Array.isArray(body.lpr_emails) || body.lpr_emails.length > 10) return res.status(400).json({ error: 'Можно сохранить не более 10 email-адресов' })
    body.lpr_emails = [...new Set(body.lpr_emails.map((email: any) => String(email).trim().toLowerCase()))]
    if (body.lpr_emails.some((email: string) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
      return res.status(400).json({ error: 'Проверьте формат email-адресов' })
    }
    if (!['website', 'import', 'manual', 'none'].includes(body.email_source)) {
      body.email_source = body.lpr_emails.length ? 'manual' : 'none'
    }
  }
  if (body.brands !== undefined) {
    if (!Array.isArray(body.brands) || body.brands.length > 30) return res.status(400).json({ error: 'Можно сохранить не более 30 брендов' })
    body.brands = [...new Set(body.brands.map((brand: any) => String(brand).trim().slice(0, 100)).filter(Boolean))]
  }
  if (body.pdf_file !== undefined) {
    if (body.pdf_file === null || body.pdf_file === '') {
      body.pdf_file = null
    } else if (!kpFileName(body.pdf_file)) {
      return res.status(400).json({ error: 'Некорректное имя файла КП' })
    }
  }
  delete body.id
  let updated = await db.leads.update(req.params.id, body)
  if (!updated) return res.status(404).json({ error: 'Лид не найден' })
  const scoringFieldsChanged = ['lpr', 'lpr_emails', 'brands', 'business_size', 'wholesale'].some(field => body[field] !== undefined)
  if (scoringFieldsChanged) {
    const supplier = (await db.settings.get('supplier_config')) || {}
    const scoring = (await db.settings.get('scoring_config')) || {}
    const scored = rescoreLead(updated, scoring, getSupplierCatalog(supplier))
    updated = await db.leads.update(req.params.id, {
      lead_score: scored.lead_score, lead_tier: scored.lead_tier,
      matched_brands: scored.matched_brands, matched_skus: scored.matched_skus,
      score_breakdown: scored.score_breakdown
    })
  }
  res.json(updated)
})

app.post('/api/leads/:id/generate-kp', async (req, res) => {
  const lead = await db.leads.get(req.params.id)
  if (!lead) return res.status(404).json({ error: 'Лид не найден' })
  if (['not_target', 'blacklisted'].includes(lead.status) && !lead.pdf_file) {
    return res.status(409).json({ error: 'Сначала верните лид в рабочий статус, чтобы сформировать КП' })
  }
  let stored = false
  try {
    const supplier = (await db.settings.get('supplier_config')) || {}
    const catalog = getSupplierCatalog(supplier)
    const matched_skus = matchCatalogItems(Array.isArray(lead.brands) ? lead.brands : [], catalog)
    const requestedItems = req.body?.items
    if (requestedItems !== undefined && (!Array.isArray(requestedItems) || requestedItems.length > 10)) {
      return res.status(400).json({ error: 'Выберите не более 10 позиций для одного КП' })
    }
    const proposal_items: any[] = requestedItems === undefined
      ? matched_skus.map(item => ({ ...item, quantity: 1 }))
      : requestedItems.map((requested: any) => {
          const product = matched_skus.find(item => requested?.sku
            ? item.sku === String(requested.sku)
            : item.brand === String(requested?.brand || '') && item.name === String(requested?.name || ''))
          const quantity = Number(requested?.quantity)
          if (!product || !Number.isInteger(quantity) || quantity < 1 || quantity > 9999 || (Number(product.stock) > 0 && quantity > Number(product.stock))) return null
          return { ...product, quantity }
        })
    if (proposal_items.some((item: any) => !item)) return res.status(400).json({ error: 'Проверьте выбранные позиции, количество и остатки в каталоге. Обновите карточку и повторите.' })
    if (proposal_items.length === 0) {
      return res.status(409).json({ error: 'Нельзя сформировать коммерческое КП без товарных позиций с ценой. Загрузите предложение поставщика по брендам, сохраните карточку и пересчитайте скоринг лидов.' })
    }
    const proposal_total = proposal_items.reduce((sum: number, item: any) => sum + Number(item.price || 0) * item.quantity, 0)
    const proposalLead = { ...lead, proposal_items, matched_skus, matched_brands: [...new Set(proposal_items.map((item: any) => item.brand))] }
    const filename = await generateKP(proposalLead, { ...supplier, name: supplier.name || catalog.supplier_name, payment_terms: supplier.payment_terms || catalog.payment_terms, delivery: supplier.delivery || catalog.delivery }, {
      onKP: async (name, content) => {
        await db.kp.put(name, lead.id, content)
        stored = true
      }
    })
    if (!filename || !stored) {
      return res.status(500).json({ error: 'Не удалось сохранить КП. Проверьте данные поставщика и повторите попытку.' })
    }
    const status = ['new', 'in_progress'].includes(lead.status) ? 'proposal_ready' : lead.status
    const status_history = status !== lead.status
      ? [...(Array.isArray(lead.status_history) ? lead.status_history : []), { status, date: new Date().toLocaleString('ru-RU') }]
      : lead.status_history
    const updated = await db.leads.update(lead.id, {
      pdf_file: filename, matched_skus, proposal_items, proposal_total, proposal_created_at: new Date().toISOString(), matched_brands: proposalLead.matched_brands,
      status, status_history
    })
    if (!updated) return res.status(404).json({ error: 'Лид не найден' })
    res.json(updated)
  } catch (error) {
    console.error('❌ Ошибка формирования КП:', error)
    res.status(500).json({ error: 'Ошибка при формировании КП' })
  }
})
app.get('/api/leads/:id/pdf', async (req, res) => {
  const lead = await db.leads.get(req.params.id)
  if (!lead?.pdf_file) return res.status(404).json({ error: 'КП не найдено' })
  const safeName = kpFileName(String(lead.pdf_file))
  if (!safeName) return res.status(404).json({ error: 'Файл не существует' })
  const content = await db.kp.get(safeName)
  if (content === null) return res.status(404).json({ error: 'Файл не существует' })
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; style-src 'unsafe-inline'; img-src data: https:; sandbox")
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(safeName)}"`)
  res.send(content)
})

app.delete('/api/leads/:id', async (req, res) => {
  const lead = await db.leads.get(req.params.id)
  if (!lead) return res.status(404).json({ error: 'Лид не найден' })
  if (lead.pdf_file) await db.kp.removeIfUnused(String(lead.pdf_file), lead.id)
  await db.leads.remove(req.params.id)
  res.json({ success: true })
})

app.post('/api/leads/rescore', async (req, res) => {
  const leads = await db.leads.list()
  const supplier = (await db.settings.get('supplier_config')) || {}
  const catalog = getSupplierCatalog(supplier)
  const scoring = (await db.settings.get('scoring_config')) || {}
  let dist: any = { A: 0, B: 0, C: 0 }
  for (const l of leads) {
    const r = rescoreLead(l, scoring, catalog)
    dist[r.lead_tier] = (dist[r.lead_tier] || 0) + 1
    await db.leads.update(l.id, { lead_score: r.lead_score, lead_tier: r.lead_tier, matched_brands: r.matched_brands, matched_skus: r.matched_skus, score_breakdown: r.score_breakdown })
  }
  console.log(`♻️ Пересчитано ${leads.length} лидов: A=${dist.A} B=${dist.B} C=${dist.C}`)
  res.json({ rescored: leads.length, distribution: dist })
})

app.get('/api/leads/export', async (req, res) => {
  const leads = await db.leads.list()
  const esc = (v: any) => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const statusText: Record<string, string> = {
    new: 'Новый', in_progress: 'В работе', proposal_ready: 'КП подготовлено', contacted: 'КП отправлено',
    not_target: 'Не целевой', blacklisted: 'Чёрный список', converted: 'Клиент'
  }
  const header = ['Компания', 'Сайт', 'Город', 'Вид деятельности', 'Адрес', 'Телефон', 'Скор', 'Тир', 'Статус', 'ЛПР', 'Должности', 'Источник ЛПР', 'Цитата ЛПР', 'Email компании', 'Источник email', 'Бренды', 'Размер', 'Опт', 'Источник задачи', 'Комментарии']
  const rows = leads.map((l: any) => [
    l.company_name, l.domain, l.city, l.industry || '', l.address || '', l.phone || '',
    l.lead_score, l.lead_tier, statusText[l.status] || l.status,
    (l.lpr || []).map((p: any) => p.name).join('; '),
    (l.lpr || []).map((p: any) => p.position).join('; '),
    (l.lpr || []).length === 0 ? 'Не найден' : (l.lpr || []).every((p: any) => p.evidence) ? 'Есть цитата источника' : 'Источник не сохранён; проверить',
    (l.lpr || []).map((p: any) => p.evidence || '').filter(Boolean).join('; '),
    (l.lpr_emails || []).join('; '),
    l.email_source === 'website' ? 'Найден на сайте; не привязан к ЛПР' : l.email_source === 'import' ? 'Импортирован; проверить' : l.email_source === 'manual' ? 'Введён вручную' : l.email_source === 'none' ? 'Не найден' : 'Источник неизвестен; проверить',
    (l.brands || []).join('; '),
    l.business_size || '', l.wholesale ? 'да' : 'нет',
    l.search_task_name || 'Ручной импорт',
    (l.comments || []).join(' | ')
  ])
  const csv = '﻿' + [header, ...rows].map(r => r.map(esc).join(';')).join('\r\n')
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="leads_${new Date().toISOString().slice(0, 10)}.csv"`)
  res.send(csv)
})

// ---------- sectors / managers / analytics ----------
app.get('/api/sectors', async (req, res) => {
  res.json(await db.sectors.list())
})

app.post('/api/sectors', async (req, res) => {
  const name = String(req.body?.name || '').trim()
  if (name.length < 2 || name.length > 120) return res.status(400).json({ error: 'Название сектора должно быть от 2 до 120 символов' })
  const rawRing = req.body?.polygon?.geometry?.coordinates?.[0]
  if (!Array.isArray(rawRing) || rawRing.length < 4 || rawRing.length > 500) {
    return res.status(400).json({ error: 'Для сектора нужна замкнутая область минимум из 3 вершин' })
  }
  const ring: [number, number][] = rawRing.map((point: any) => [Number(point?.[0]), Number(point?.[1])])
  if (ring.some(([lng, lat]) => !Number.isFinite(lng) || !Number.isFinite(lat) || lng < -180 || lng > 180 || lat < -90 || lat > 90)) {
    return res.status(400).json({ error: 'В секторе обнаружены некорректные координаты' })
  }
  if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) ring.push([...ring[0]])
  const area = ring.slice(1).reduce((sum, point, index) => {
    const previous = ring[index]
    return sum + previous[0] * point[1] - point[0] * previous[1]
  }, 0)
  if (Math.abs(area) < 1e-10) return res.status(400).json({ error: 'Сектор не образует замкнутую область' })

  const managerId = String(req.body?.manager_id || '')
  if (managerId && !(await db.managers.list()).some((manager: any) => manager.id === managerId)) {
    return res.status(400).json({ error: 'Выбранный менеджер не найден' })
  }
  const color = /^#[0-9a-f]{6}$/i.test(String(req.body?.color || '')) ? String(req.body.color) : '#6366F1'
  const newSector = {
    id: `sec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name,
    manager_id: managerId || undefined,
    color,
    polygon: {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [ring] },
      properties: { shape_type: String(req.body?.polygon?.properties?.shape_type || 'polygon') },
    },
  }
  await db.sectors.create(newSector)

  const leads = await db.leads.list()
  let assigned = 0
  for (const lead of leads) {
    if (hasValidCoordinates(lead.coordinates) && pointInRing(Number(lead.coordinates.lng), Number(lead.coordinates.lat), ring)) {
      await db.leads.update(lead.id, { sector_id: newSector.id, assigned_manager_id: newSector.manager_id })
      assigned++
    }
  }
  res.json({ ...newSector, leadsCount: assigned })
})

app.put('/api/sectors/:id', async (req, res) => {
  const current = await db.sectors.get(req.params.id)
  if (!current) return res.status(404).json({ error: 'Сектор не найден' })
  const name = String(req.body?.name ?? current.name).trim()
  if (name.length < 2 || name.length > 120) return res.status(400).json({ error: 'Название сектора должно быть от 2 до 120 символов' })
  const managerId = String(req.body?.manager_id ?? current.manager_id ?? '')
  if (managerId && !(await db.managers.list()).some((manager: any) => manager.id === managerId)) {
    return res.status(400).json({ error: 'Выбранный менеджер не найден' })
  }
  const color = /^#[0-9a-f]{6}$/i.test(String(req.body?.color || '')) ? String(req.body.color) : current.color || '#6366F1'
  let polygon = current.polygon
  if (req.body?.polygon !== undefined) {
    const rawRing = req.body?.polygon?.geometry?.coordinates?.[0]
    if (!Array.isArray(rawRing) || rawRing.length < 4 || rawRing.length > 500) {
      return res.status(400).json({ error: 'Для сектора нужна замкнутая область минимум из 3 вершин' })
    }
    const ring: [number, number][] = rawRing.map((point: any) => [Number(point?.[0]), Number(point?.[1])])
    if (ring.some(([lng, lat]) => !Number.isFinite(lng) || !Number.isFinite(lat) || lng < -180 || lng > 180 || lat < -90 || lat > 90)) {
      return res.status(400).json({ error: 'В секторе обнаружены некорректные координаты' })
    }
    if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) ring.push([...ring[0]])
    const area = ring.slice(1).reduce((sum, point, index) => {
      const previous = ring[index]
      return sum + previous[0] * point[1] - point[0] * previous[1]
    }, 0)
    if (Math.abs(area) < 1e-10) return res.status(400).json({ error: 'Сектор не образует замкнутую область' })
    polygon = {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [ring] },
      properties: { shape_type: String(req.body?.polygon?.properties?.shape_type || 'polygon') },
    }
  }
  const updated = await db.sectors.update(req.params.id, {
    name,
    manager_id: managerId || undefined,
    color,
    polygon,
  })
  if (!updated) return res.status(404).json({ error: 'Сектор не найден' })
  const leads = await db.leads.list()
  let assigned = 0
  for (const lead of leads) {
    if (!hasValidCoordinates(lead.coordinates)) {
      if (lead.sector_id === updated.id) await db.leads.update(lead.id, { sector_id: undefined, assigned_manager_id: undefined })
      continue
    }
    const isInside = pointInRing(Number(lead.coordinates.lng), Number(lead.coordinates.lat), polygon.geometry.coordinates[0])
    if (isInside) {
      await db.leads.update(lead.id, { sector_id: updated.id, assigned_manager_id: updated.manager_id })
      assigned++
    } else if (lead.sector_id === updated.id) {
      await db.leads.update(lead.id, { sector_id: undefined, assigned_manager_id: undefined })
      await assignLeadToKnownSector({ ...lead, sector_id: undefined, assigned_manager_id: undefined })
    } else if (lead.sector_id === undefined || lead.sector_id === null) {
      await assignLeadToKnownSector(lead)
    }
  }
  res.json({ ...updated, leadsCount: assigned })
})

app.delete('/api/sectors/:id', async (req, res) => {
  const sector = await db.sectors.get(req.params.id)
  if (!sector) return res.status(404).json({ error: 'Сектор не найден' })
  const leads = await db.leads.list()
  let unassigned = 0
  for (const lead of leads) {
    if (lead.sector_id === sector.id) {
      await db.leads.update(lead.id, { sector_id: undefined, assigned_manager_id: undefined })
      unassigned++
    }
  }
  await db.sectors.remove(req.params.id)
  res.json({ success: true, unassigned })
})

app.get('/api/managers', async (req, res) => {
  res.json(await db.managers.list())
})

app.get('/api/analytics', async (req, res) => {
  const leads = await db.leads.list()
  const managers = await db.managers.list()
  const sectors = await db.sectors.list()
  res.json({
    total: leads.length,
    new: leads.filter((l: any) => l.status === 'new').length,
    in_progress: leads.filter((l: any) => l.status === 'in_progress').length,
    proposal_ready: leads.filter((l: any) => l.status === 'proposal_ready').length,
    contacted: leads.filter((l: any) => l.status === 'contacted').length,
    converted: leads.filter((l: any) => l.status === 'converted').length,
    not_target: leads.filter((l: any) => l.status === 'not_target').length,
    blacklisted: leads.filter((l: any) => l.status === 'blacklisted').length,
    managers: managers.map((m: any) => ({
      ...m,
      leadsCount: leads.filter((l: any) => l.assigned_manager_id === m.id).length,
      convertedCount: leads.filter((l: any) => l.assigned_manager_id === m.id && l.status === 'converted').length
    })),
    sectors: sectors.map((s: any) => ({
      ...s,
      leadsCount: leads.filter((l: any) => l.sector_id === s.id).length
    }))
  })
})

// ---------- settings ----------
app.get('/api/supplier-config', async (req, res) => {
  const profile = (await db.settings.get('supplier_config')) || {}
  const catalog = getSupplierCatalog(profile)
  res.json({
    ...profile,
    name: profile.name || catalog.supplier_name || 'УралАвтоОпт',
    contact: profile.contact || '',
    payment_terms: profile.payment_terms || catalog.payment_terms || '',
    delivery: profile.delivery || catalog.delivery || '',
    catalogItems: catalog.items,
  })
})

app.put('/api/supplier-config', async (req, res) => {
  const name = String(req.body?.name || '').trim()
  if (!name) return res.status(400).json({ error: 'Название компании обязательно' })
  const fields = ['contact', 'email', 'phone', 'website', 'inn', 'address', 'payment_terms', 'delivery', 'warranty', 'offer_validity', 'offer_text']
  const profile: any = { name }
  for (const field of fields) profile[field] = String(req.body?.[field] || '').trim().slice(0, 2000)
  const rawItems = req.body?.catalogItems
  const items = rawItems === undefined ? getSupplierCatalog((await db.settings.get('supplier_config')) || {}).items : rawItems
  if (!Array.isArray(items)) return res.status(400).json({ error: 'Предложение должно быть списком товаров' })
  if (items.length > 1000) return res.status(400).json({ error: 'Максимум 1000 товарных позиций' })
  const catalogItems: any[] = []
  for (const [index, item] of items.entries()) {
    const brand = String(item?.brand || '').trim().slice(0, 100)
    const productName = String(item?.name || '').trim().slice(0, 200)
    const price = Number(item?.price)
    const stock = Number(item?.stock || 0)
    if (!brand || !productName || !Number.isFinite(price) || price < 0 || !Number.isFinite(stock) || stock < 0) {
      return res.status(400).json({ error: `Проверьте товарную позицию ${index + 1}: нужны бренд, название и корректная цена/остаток` })
    }
    catalogItems.push({
      brand, name: productName, sku: String(item?.sku || '').trim().slice(0, 100),
      car: String(item?.car || '').trim().slice(0, 200), price, stock
    })
  }
  profile.catalogItems = catalogItems
  await db.settings.set('supplier_config', profile)
  res.json(profile)
})

app.get('/api/scoring-config', async (req, res) => {
  const cfg = (await db.settings.get('scoring_config')) || {}
  const weights = { lpr: 25, emails: 15, brands: 35, businessSize: 15, wholesale: 10, ...(cfg?.weights || {}) }
  weights.brands = Math.min(100, Number(weights.brands || 0) + Number((cfg?.weights || {}).content || 0))
  ;(weights as any).content = 0
  res.json({
    weights,
    tiers: cfg?.tiers || { a: 75, b: 50 },
    retailPenalty: typeof cfg?.retailPenalty === 'number' ? cfg.retailPenalty : 15,
    searchDefaults: loadSearchDefaults()
  })
})

app.put('/api/scoring-config', async (req, res) => {
  const b = req.body || {}
  const weights: any = {}
  for (const k of ['lpr', 'emails', 'brands', 'businessSize', 'wholesale', 'content']) {
    if (b.weights?.[k] !== undefined) {
      const n = parseInt(b.weights[k])
      if (!Number.isInteger(n) || n < 0 || n > 100) return res.status(400).json({ error: `Вес "${k}": число 0–100` })
      weights[k] = n
    }
  }
  const tiers: any = {}
  for (const k of ['a', 'b']) {
    if (b.tiers?.[k] !== undefined) {
      const n = parseInt(b.tiers[k])
      if (!Number.isInteger(n) || n < 0 || n > 100) return res.status(400).json({ error: `Порог тира "${k}": число 0–100` })
      tiers[k] = n
    }
  }
  let retailPenalty = undefined
  if (b.retailPenalty !== undefined) {
    const n = parseInt(b.retailPenalty)
    if (!Number.isInteger(n) || n < 0 || n > 100) return res.status(400).json({ error: 'Штраф за розницу: число 0–100' })
    retailPenalty = n
  }
  const searchDefaults: any = {}
  if (b.searchDefaults) {
    const city = String(b.searchDefaults.city || '').trim()
    const industry = String(b.searchDefaults.industry || '').trim()
    if (city && [...city].some(c => c.codePointAt(0) === 0xfffd)) return res.status(400).json({ error: 'Город: некорректная кодировка' })
    if (industry && [...industry].some(c => c.codePointAt(0) === 0xfffd)) return res.status(400).json({ error: 'Отрасль: некорректная кодировка' })
    if (city) searchDefaults.city = city.slice(0, 60)
    if (industry) searchDefaults.industry = industry.slice(0, 60)
    const limit = parseInt(b.searchDefaults.limit)
    if (b.searchDefaults.limit !== undefined) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 20) return res.status(400).json({ error: 'Лимит поиска: число 1–20' })
      searchDefaults.limit = limit
    }
  }

  const current = (await db.settings.get('scoring_config')) || {}
  const next = {
    ...current,
    ...(Object.keys(weights).length ? { weights: { ...(current.weights || {}), ...weights } } : {}),
    ...(Object.keys(tiers).length ? { tiers: { ...(current.tiers || {}), ...tiers } } : {}),
    ...(retailPenalty !== undefined ? { retailPenalty } : {}),
    ...(Object.keys(searchDefaults).length ? { searchDefaults: { ...(current.searchDefaults || {}), ...searchDefaults } } : {})
  }
  await db.settings.set('scoring_config', next)
  res.json(next)
})

// ---------- users (admin) ----------
app.get('/api/users', requireAdmin, async (req, res) => {
  res.json(await db.users.list())
})

app.post('/api/users', requireAdmin, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase()
  const password = String(req.body?.password || '')
  const name = String(req.body?.name || '').trim()
  const role = req.body?.role === 'admin' ? 'admin' : 'manager'
  if (!email || !password || password.length < 6) {
    return res.status(400).json({ error: 'Нужны email и пароль (минимум 6 символов)' })
  }
  const existing = await db.users.findByEmail(email)
  if (existing) return res.status(400).json({ error: 'Пользователь с таким email уже есть' })
  const bcrypt = await import('bcryptjs')
  const password_hash = await bcrypt.hash(password, 10)
  await db.users.create({ email, name, password_hash, role })
  res.json({ email, name, role })
})

// ---------- пайплайн (джобы в БД) ----------
const pipelineJobs: Record<string, any> = {}

async function updateJob(jobId: string, patch: any) {
  pipelineJobs[jobId] = { ...pipelineJobs[jobId], ...patch }
  await db.jobs.update(jobId, pipelineJobs[jobId]).catch(() => {})
}

async function launchPipelineJob(params: {
  city: string; industry: string; limit: number
  options?: any
  source?: { search_task_id?: string; search_task_name?: string }
  onStart?: (jobId: string) => Promise<void> | void
  onComplete?: (result: { status: string; found: number; added: number; error?: string }) => void
}): Promise<{ jobId: string } | null> {
  const { city, industry, limit, options, source, onComplete } = params
  const safeLimit = Math.min(Math.max(parseInt(limit as any) || 5, 1), 20)

  const running = Object.values(pipelineJobs).find((j: any) => j.status === 'running')
  if (running) return null

  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const acquired = await db.jobs.acquirePipelineLock(jobId)
  if (!acquired) return null

  // После получения lease завершаем статусы задач, оставшиеся без активного владельца.
  await db.jobs.markStaleRunningAsError(jobId).catch((e: any) => console.error('⚠️ Не удалось обновить прерванные задачи:', e))
  const initial = {
    id: jobId,
    status: 'running',
    stage: 'search',
    processed: 0,
    total: safeLimit,
    added: 0,
    totalFound: 0,
    message: 'Поиск компаний...',
    startedAt: new Date().toISOString(),
    search_task_id: source?.search_task_id
  }
  pipelineJobs[jobId] = initial
  try {
    await db.jobs.create(initial)
  } catch (error) {
    delete pipelineJobs[jobId]
    await db.jobs.releasePipelineLock(jobId).catch(() => {})
    console.error('❌ Не удалось сохранить задачу пайплайна:', error)
    return null
  }

  try {
    await params.onStart?.(jobId)
  } catch (error) {
    const message = 'Не удалось обновить статус задачи поиска перед запуском'
    await updateJob(jobId, { status: 'error', error: message })
    delete pipelineJobs[jobId]
    await db.jobs.releasePipelineLock(jobId).catch(() => {})
    console.error('❌ Не удалось подготовить задачу поиска:', error)
    return null
  }
  console.log(`📥 Запуск поиска: city=${city}, industry=${industry}, limit=${safeLimit} (job ${jobId})`)

  const stageText: Record<string, string> = {
    search: 'Поиск компаний...',
    enrich: 'Проверка сайтов и оценка лидов...',
    save: 'Проверка дублей и сохранение...',
    done: 'Поиск завершён'
  }

  ;(async () => {
    const lockHeartbeat = setInterval(async () => {
      try {
        const renewed = await db.jobs.renewPipelineLock(jobId)
        if (!renewed) console.error(`⚠️ Lease задачи ${jobId} потерян; обновление статуса может быть прервано`)
      } catch (error) {
        console.error(`⚠️ Не удалось продлить lease задачи ${jobId}:`, error)
      }
    }, 60_000)

    try {
      const supplier = (await db.settings.get('supplier_config')) || {}
      const supplierCatalog = getSupplierCatalog(supplier)
      const globalScoring = (await db.settings.get('scoring_config')) || {}
      const taskScoring = options?.scoring || {}
      const scoring = {
        ...globalScoring,
        ...taskScoring,
        weights: { ...(globalScoring.weights || {}), ...(taskScoring.weights || {}) },
        tiers: { ...(globalScoring.tiers || {}), ...(taskScoring.tiers || {}) },
        businessSizeScores: { ...(globalScoring.businessSizeScores || {}), ...(taskScoring.businessSizeScores || {}) },
      }
      const newLeads = await runPipeline(city, industry, safeLimit, '', (stage, processed, total) => {
        void updateJob(jobId, { stage, processed, total: Math.max(total, 1), message: stageText[stage] || stage })
      }, { ...options, scoring, supplierCatalog })

      if (newLeads.length === 0) {
        await updateJob(jobId, {
          status: 'error',
          error: 'Компании не найдены. Попробуйте изменить город/отрасль или проверьте API-ключи.'
        })
        onComplete?.({ status: 'error', found: 0, added: 0 })
        return
      }

      // Дедупликация по домену, затем по названию и городу; так учитываются и импортированные записи.
      const existingLeads = await db.leads.list()
      const knownLeadKeys = new Set(existingLeads.flatMap((lead: any) => getLeadDedupeKeys(lead)))

      let addedCount = 0
      await updateJob(jobId, { stage: 'save', processed: 0, total: newLeads.length, message: stageText.save })
      for (const [index, lead] of newLeads.entries()) {
        const dedupeKeys = getLeadDedupeKeys(lead)
        if (!dedupeKeys.some(key => knownLeadKeys.has(key))) {
          const savedLead = {
            ...lead,
            ...source,
            id: `lead_${Date.now()}_${addedCount}`,
            status: 'new',
            pdf_file: null,
            comments: [],
            status_history: [{ status: 'new', date: new Date().toLocaleString('ru-RU') }],
            sector_id: undefined,
            assigned_manager_id: undefined
          }
          await db.leads.create(savedLead)
          await assignLeadToKnownSector(savedLead)
          dedupeKeys.forEach(key => knownLeadKeys.add(key))
          addedCount++
        }
        await updateJob(jobId, { stage: 'save', processed: index + 1, total: newLeads.length, message: stageText.save })
      }

      const message = addedCount > 0
        ? `Найдено ${newLeads.length}, добавлено ${addedCount} новых лидов`
        : `Найдено ${newLeads.length} компаний, все уже есть в базе`
      await updateJob(jobId, { status: 'done', stage: 'done', processed: newLeads.length, total: newLeads.length, added: addedCount, totalFound: newLeads.length, message })
      console.log(`✅ Job ${jobId}: ${message}`)
      onComplete?.({ status: 'done', found: newLeads.length, added: addedCount })
    } catch (error) {
      console.error('❌ Ошибка пайплайна:', error)
      const msg = 'Ошибка при запуске пайплайна: ' + String(error)
      await updateJob(jobId, { status: 'error', error: msg })
      onComplete?.({ status: 'error', found: 0, added: 0, error: msg })
    } finally {
      clearInterval(lockHeartbeat)
      await db.jobs.releasePipelineLock(jobId).catch((e: any) => console.error('⚠️ Не удалось освободить lease:', e))
    }
  })()

  return { jobId }
}

async function respondWithActiveJob(res: any) {
  const active = await db.jobs.getActive()
  if (!active) return res.status(503).json({ error: 'Не удалось запустить задачу поиска. Попробуйте ещё раз.' })
  return res.json({ jobId: active.id, alreadyRunning: true })
}

async function recoverOrphanedRunningSearchTasks(): Promise<number> {
  const activeJob = await db.jobs.getActive()
  const tasks = await db.tasks.list()
  const orphaned = orphanedRunningSearchTasks(tasks, activeJob)
  for (const task of orphaned) {
    await db.tasks.update(task.id, {
      status: 'error',
      last_run: new Date().toISOString(),
      last_error: 'Поиск прерван: активный процесс не найден. Запустите задачу повторно.',
      active_job_id: undefined,
    })
  }
  return orphaned.length
}

app.post('/api/run-pipeline', runCooldown, async (req, res) => {
  const { city = 'Екатеринбург', industry = 'автозапчасти', limit = 5 } = req.body || {}
  const launched = await launchPipelineJob({ city, industry, limit })
  if (!launched) return respondWithActiveJob(res)
  res.json({ jobId: launched.jobId })
})

app.get('/api/pipeline-status/:jobId', async (req, res) => {
  const job = pipelineJobs[req.params.jobId] || await db.jobs.get(req.params.jobId)
  if (!job) return res.status(404).json({ error: 'Задача не найдена' })
  res.json(job)
})

// ---------- задачи поиска ----------
const validateTaskBody = (body: any): { error?: string; value?: any } => {
  const clean: any = {}
  const name = String(body?.name ?? '').trim()
  const city = String(body?.city ?? '').trim()
  const industry = String(body?.industry ?? '').trim()
  if (name.length < 2 || name.length > 80) return { error: 'Название задачи: 2–80 символов' }
  for (const [label, val] of [['Город', city], ['Отрасль', industry]] as const) {
    if (val.length < 2 || val.length > 60) return { error: `${label}: 2–60 символов` }
    if ([...val].some(c => c.codePointAt(0) === 0xfffd)) return { error: `${label}: некорректная кодировка (введите текст заново)` }
    if (!/[a-zA-Zа-яА-ЯёЁ]/.test(val)) return { error: `${label}: должны быть буквы` }
  }
  clean.name = name
  clean.city = city
  clean.industry = industry

  const limit = parseInt(body?.limit)
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) return { error: 'Лимит: число от 1 до 20' }
  clean.limit = limit

  clean.use_ai = body?.use_ai !== false
  clean.use_geocode = body?.use_geocode !== false

  if (body?.scoring) {
    const w = body.scoring.weights || {}
    const weights: any = {}
    for (const k of ['lpr', 'emails', 'brands', 'businessSize', 'wholesale', 'content']) {
      if (w[k] !== undefined) {
        const n = parseInt(w[k])
        if (!Number.isInteger(n) || n < 0 || n > 100) return { error: `Вес скоринга "${k}": число 0–100` }
        weights[k] = n
      }
    }
    clean.scoring = { weights }
  } else {
    clean.scoring = null
  }
  return { value: clean }
}

app.get('/api/search-tasks', async (req, res) => {
  res.json(await db.tasks.list())
})

app.post('/api/search-tasks', async (req, res) => {
  const { error, value } = validateTaskBody(req.body)
  if (error) return res.status(400).json({ error })
  const task = {
    id: `task_${Date.now()}`,
    status: 'draft',
    last_run: null,
    leads_found: 0,
    leads_added: 0,
    created_at: new Date().toISOString(),
    ...value
  }
  await db.tasks.create(task)
  res.json(task)
})

app.put('/api/search-tasks/:id', async (req, res) => {
  const { error, value } = validateTaskBody(req.body)
  if (error) return res.status(400).json({ error })
  const updated = await db.tasks.update(req.params.id, value)
  if (!updated) return res.status(404).json({ error: 'Задача не найдена' })
  res.json(updated)
})

app.delete('/api/search-tasks/:id', async (req, res) => {
  await db.tasks.remove(req.params.id)
  res.json({ success: true })
})

app.post('/api/search-tasks/:id/run', runCooldown, async (req, res) => {
  const task = await db.tasks.get(req.params.id)
  if (!task) return res.status(404).json({ error: 'Задача не найдена' })

  const launched = await launchPipelineJob({
    city: task.city,
    industry: task.industry,
    limit: task.limit,
    options: {
      scoring: task.scoring || null,
      useAI: task.use_ai !== false,
      useGeocode: task.use_geocode !== false
    },
    source: { search_task_id: task.id, search_task_name: task.name },
    onStart: async (jobId) => {
      const updated = await db.tasks.update(task.id, {
        status: 'running',
        started_at: new Date().toISOString(),
        active_job_id: jobId,
        last_error: undefined,
      })
      if (!updated) throw new Error('Задача поиска не найдена')
    },
    onComplete: async (result) => {
      await db.tasks.update(task.id, {
        status: result.status === 'done' ? 'done' : 'error',
        last_run: new Date().toISOString(),
        leads_found: result.found,
        leads_added: result.added,
        last_error: result.error,
        active_job_id: undefined,
      }).catch(() => {})
    }
  })

  if (!launched) return respondWithActiveJob(res)
  res.json({ jobId: launched.jobId })
})

// ---------- boot ----------
async function main() {
  assertAuthConfig()
  const mode = await initDb()
  console.log(`💾 Режим хранения: ${mode === 'pg' ? 'PostgreSQL' : 'JSON-файлы (fallback)'}`)
  try {
    const counts = { leads: (await db.leads.list()).length, tasks: (await db.tasks.list()).length, users: (await db.users.list()).length }
    console.log(`📊 В базе: лидов ${counts.leads}, задач ${counts.tasks}, пользователей ${counts.users}`)
  } catch { /* ignore */ }

  // Джобы, прерванные рестартом, помечаем ошибкой
  const stale = await db.jobs.markStaleRunningAsError()
  if (stale) console.log(`⚠️ Прервано рестартом: ${stale} задач пайплайна`)
  const orphanedTasks = await recoverOrphanedRunningSearchTasks()
  if (orphanedTasks) console.log(`⚠️ Снято зависших статусов поиска: ${orphanedTasks}`)

  const staleJobSweep = setInterval(async () => {
    try {
      const recovered = await db.jobs.markStaleRunningAsError()
      if (recovered) console.log(`⚠️ Помечено прерванными после истечения lease: ${recovered} задач`)
      const orphaned = await recoverOrphanedRunningSearchTasks()
      if (orphaned) console.log(`⚠️ Снято зависших статусов поиска: ${orphaned}`)
    } catch (error) {
      console.error('⚠️ Не удалось проверить зависшие задачи:', error)
    }
  }, 60_000)

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Сервер запущен на порту ${PORT}`)
  })
  server.on('error', (err: any) => console.error('❌ Ошибка запуска сервера:', err))

  const shutdown = async () => {
    console.log('🛑 Остановка...')
    clearInterval(staleJobSweep)
    const active = Object.values(pipelineJobs).find((job: any) => job.status === 'running') as any
    if (active) {
      await updateJob(active.id, { status: 'error', error: 'Сервер остановлен во время выполнения задачи' })
      if (active.search_task_id) {
        await db.tasks.update(active.search_task_id, {
          status: 'error',
          last_error: 'Сервер остановлен во время выполнения задачи'
        }).catch(() => {})
      }
      await db.jobs.releasePipelineLock(active.id).catch(() => {})
    }
    await closeDb()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch(err => {
  console.error('❌ Фатальная ошибка при старте:', err)
  process.exit(1)
})
