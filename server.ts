import express from 'express'
import cors from 'cors'
import path from 'path'
import { runPipeline, rescoreLead, loadSearchDefaults } from './src/pipeline.ts'
import { db, initDb, closeDb, dbMode } from './src/db/index.ts'
import { authMiddleware, loginHandler, requireAdmin } from './src/auth.ts'

const app = express()
const PORT = process.env.PORT || 3001
const rootDir = process.cwd()

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

app.use('/kp_final', express.static(path.join(rootDir, 'kp_final')))

// Безопасное имя файла КП (защита от path traversal)
const kpFileName = (fileName: any): string | null => {
  if (typeof fileName !== 'string' || fileName.length === 0 || fileName.length > 120) return null
  if (fileName !== path.basename(fileName)) return null
  return fileName
}

// ---------- auth ----------
app.get('/api/health', async (req, res) => {
  let counts: any = null
  try {
    counts = {
      leads: (await db.leads.list()).length,
      tasks: (await db.tasks.list()).length,
      users: (await db.users.list()).length
    }
  } catch { /* ignore */ }
  res.json({ ok: true, mode: dbMode(), counts })
})

app.post('/api/auth/login', loginHandler)
app.get('/api/auth/me', authMiddleware, (req: any, res) => res.json(req.user))
app.use('/api', authMiddleware)

// ---------- leads ----------
app.get('/api/leads', async (req, res) => {
  res.json(await db.leads.list())
})

app.put('/api/leads/:id', async (req, res) => {
  const body = { ...req.body }
  if (body.pdf_file !== undefined) {
    if (body.pdf_file === null || body.pdf_file === '') {
      body.pdf_file = null
    } else if (!kpFileName(body.pdf_file)) {
      return res.status(400).json({ error: 'Некорректное имя файла КП' })
    }
  }
  delete body.id
  const updated = await db.leads.update(req.params.id, body)
  if (!updated) return res.status(404).json({ error: 'Лид не найден' })
  res.json(updated)
})

app.get('/api/leads/:id/pdf', async (req, res) => {
  const lead = await db.leads.get(req.params.id)
  if (!lead?.pdf_file) return res.status(404).json({ error: 'КП не найдено' })
  const safeName = kpFileName(String(lead.pdf_file))
  if (!safeName) return res.status(404).json({ error: 'Файл не существует' })
  const content = await db.kp.get(safeName)
  if (content === null) return res.status(404).json({ error: 'Файл не существует' })
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
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
  let dist: any = { A: 0, B: 0, C: 0 }
  for (const l of leads) {
    const r = rescoreLead(l)
    dist[r.lead_tier] = (dist[r.lead_tier] || 0) + 1
    await db.leads.update(l.id, { lead_score: r.lead_score, lead_tier: r.lead_tier })
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
    new: 'Новый', contacted: 'КП отправлено', in_progress: 'В работе',
    not_target: 'Не целевой', blacklisted: 'Чёрный список', converted: 'Клиент'
  }
  const header = ['Компания', 'Сайт', 'Город', 'Адрес', 'Скор', 'Тир', 'Статус', 'ЛПР', 'Должности', 'Email', 'Бренды', 'Размер', 'Опт', 'Источник', 'Комментарии']
  const rows = leads.map((l: any) => [
    l.company_name, l.domain, l.city, l.address || '',
    l.lead_score, l.lead_tier, statusText[l.status] || l.status,
    (l.lpr || []).map((p: any) => p.name).join('; '),
    (l.lpr || []).map((p: any) => p.position).join('; '),
    (l.lpr_emails || []).join('; '),
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
  const newSector = { ...req.body, id: `sec_${Date.now()}` }
  await db.sectors.create(newSector)

  const leads = await db.leads.list()
  for (const lead of leads) {
    if (lead.coordinates && newSector.polygon) {
      const coords = newSector.polygon.geometry.coordinates[0]
      const lngs = coords.map((c: any) => c[0])
      const lats = coords.map((c: any) => c[1])
      const minLng = Math.min(...lngs), maxLng = Math.max(...lngs)
      const minLat = Math.min(...lats), maxLat = Math.max(...lats)
      if (
        lead.coordinates.lng >= minLng && lead.coordinates.lng <= maxLng &&
        lead.coordinates.lat >= minLat && lead.coordinates.lat <= maxLat
      ) {
        await db.leads.update(lead.id, { sector_id: newSector.id, assigned_manager_id: newSector.manager_id })
      }
    }
  }
  res.json(newSector)
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
    converted: leads.filter((l: any) => l.status === 'converted').length,
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
  const cfg = await db.settings.get('supplier_config')
  res.json(cfg?.name ? cfg : { name: 'УралАвтоОпт', contact: 'Петров И.С.' })
})

app.put('/api/supplier-config', async (req, res) => {
  const name = String(req.body?.name || '').trim()
  const contact = String(req.body?.contact || '').trim()
  if (!name) return res.status(400).json({ error: 'Название поставщика обязательно' })
  const cfg = { name, contact }
  await db.settings.set('supplier_config', cfg)
  res.json(cfg)
})

app.get('/api/scoring-config', async (req, res) => {
  const cfg = (await db.settings.get('scoring_config')) || {}
  res.json({
    weights: cfg?.weights || { lpr: 25, emails: 15, brands: 20, businessSize: 15, wholesale: 10, content: 15 },
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
  onComplete?: (result: { status: string; found: number; added: number; error?: string }) => void
}): Promise<{ jobId: string } | null> {
  const { city, industry, limit, options, source, onComplete } = params
  const safeLimit = Math.min(Math.max(parseInt(limit as any) || 5, 1), 20)

  const running = Object.values(pipelineJobs).find((j: any) => j.status === 'running')
  if (running) return null

  const jobId = `job_${Date.now()}`
  const initial = {
    id: jobId,
    status: 'running',
    stage: 'search',
    processed: 0,
    total: safeLimit,
    added: 0,
    totalFound: 0,
    message: 'Поиск компаний...',
    startedAt: new Date().toISOString()
  }
  pipelineJobs[jobId] = initial
  db.jobs.create(initial).catch(() => {})
  console.log(`📥 Запуск поиска: city=${city}, industry=${industry}, limit=${safeLimit} (job ${jobId})`)

  const stageText: Record<string, string> = {
    search: 'Поиск компаний...',
    enrich: 'Анализ сайтов...',
    kp: 'Генерация КП...',
    done: 'Готово'
  }

  ;(async () => {
    try {
      const supplierConfig = (await db.settings.get('supplier_config')) || {}
      const supplierName = supplierConfig?.name || 'УралАвтоОпт'

      const newLeads = await runPipeline(city, industry, safeLimit, supplierName, (stage, processed, total) => {
        updateJob(jobId, { stage, processed, total: Math.max(total, 1), message: stageText[stage] || stage })
      }, {
        ...options,
        onKP: async (filename: string, content: string) => {
          await db.kp.put(filename, null, content).catch((e: any) => console.error('⚠️ KP save:', e))
        }
      })

      if (newLeads.length === 0) {
        await updateJob(jobId, {
          status: 'error',
          error: 'Компании не найдены. Попробуйте изменить город/отрасль или проверьте API-ключи.'
        })
        onComplete?.({ status: 'error', found: 0, added: 0 })
        return
      }

      // Добавление новых лидов (дедуп по домену без учёта www., защита от дублей в прогоне)
      const rootDomain = (d: string) => String(d || '').toLowerCase().replace(/^www\./, '')
      const existingLeads = await db.leads.list()
      const existingDomains = new Set(existingLeads.map((l: any) => rootDomain(l.domain)))

      let addedCount = 0
      for (const lead of newLeads) {
        if (!existingDomains.has(rootDomain(lead.domain))) {
          await db.leads.create({
            ...lead,
            ...source,
            id: `lead_${Date.now()}_${addedCount}`,
            status: 'new',
            pdf_file: (lead as any).pdf_file || null,
            comments: [],
            status_history: [{ status: 'new', date: new Date().toLocaleString('ru-RU') }],
            sector_id: undefined,
            assigned_manager_id: undefined
          })
          existingDomains.add(rootDomain(lead.domain))
          addedCount++
        }
      }

      const message = addedCount > 0
        ? `Найдено ${newLeads.length}, добавлено ${addedCount} новых лидов`
        : `Найдено ${newLeads.length} компаний, все уже есть в базе`
      await updateJob(jobId, { status: 'done', added: addedCount, totalFound: newLeads.length, message })
      console.log(`✅ Job ${jobId}: ${message}`)
      onComplete?.({ status: 'done', found: newLeads.length, added: addedCount })
    } catch (error) {
      console.error('❌ Ошибка пайплайна:', error)
      const msg = 'Ошибка при запуске пайплайна: ' + String(error)
      await updateJob(jobId, { status: 'error', error: msg })
      onComplete?.({ status: 'error', found: 0, added: 0, error: msg })
    }
  })()

  return { jobId }
}

app.post('/api/run-pipeline', runCooldown, async (req, res) => {
  const { city = 'Екатеринбург', industry = 'автозапчасти', limit = 5 } = req.body || {}
  const launched = await launchPipelineJob({ city, industry, limit })
  if (!launched) {
    const running = Object.values(pipelineJobs).find((j: any) => j.status === 'running')
    return res.json({ jobId: (running as any)?.id, alreadyRunning: true })
  }
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
    onComplete: async (result) => {
      await db.tasks.update(task.id, {
        status: result.status === 'done' ? 'done' : 'error',
        last_run: new Date().toISOString(),
        leads_found: result.found,
        leads_added: result.added,
        last_error: result.error
      }).catch(() => {})
    }
  })

  if (!launched) {
    const running = Object.values(pipelineJobs).find((j: any) => j.status === 'running')
    return res.json({ jobId: (running as any)?.id, alreadyRunning: true })
  }

  await db.tasks.update(task.id, { status: 'running', last_error: undefined })
  res.json({ jobId: launched.jobId })
})

// ---------- boot ----------
async function main() {
  const mode = await initDb()
  console.log(`💾 Режим хранения: ${mode === 'pg' ? 'PostgreSQL' : 'JSON-файлы (fallback)'}`)
  try {
    const counts = { leads: (await db.leads.list()).length, tasks: (await db.tasks.list()).length, users: (await db.users.list()).length }
    console.log(`📊 В базе: лидов ${counts.leads}, задач ${counts.tasks}, пользователей ${counts.users}`)
  } catch { /* ignore */ }

  // Джобы, прерванные рестартом, помечаем ошибкой
  const stale = await db.jobs.markStaleRunningAsError()
  if (stale) console.log(`⚠️ Прервано рестартом: ${stale} задач пайплайна`)

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Сервер запущен на порту ${PORT}`)
  })
  server.on('error', (err: any) => console.error('❌ Ошибка запуска сервера:', err))

  const shutdown = async () => {
    console.log('🛑 Остановка...')
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
