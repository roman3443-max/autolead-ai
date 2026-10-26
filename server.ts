import express from 'express'
import cors from 'cors'
import fs from 'fs'
import path from 'path'
import { runPipeline } from './src/pipeline.ts'

const app = express()
const PORT = process.env.PORT || 3001
const rootDir = process.cwd()

// --- Безопасность ---
// Если задан API_TOKEN, все /api-запросы требуют заголовок x-api-token
const API_TOKEN = process.env.API_TOKEN || ''
// Разрешённые источники (CORS). Переопределяется переменной ALLOWED_ORIGINS через запятую
const DEFAULT_ORIGINS = [
  'https://autolead-ai-rosy.vercel.app',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3001'
]
const allowedOrigins = (process.env.ALLOWED_ORIGINS || DEFAULT_ORIGINS.join(',')).split(',').map(s => s.trim()).filter(Boolean)

app.use(cors({
  origin: (origin, callback) => {
    // Запросы без Origin (curl, серверные скрипты) пропускаем
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true)
    callback(new Error('Not allowed by CORS'))
  },
  allowedHeaders: ['Content-Type', 'x-api-token']
}))
app.use(express.json({ limit: '1mb' }))

// Заголовки безопасности
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  next()
})

// Проверка токена (только если он задан в окружении)
app.use('/api', (req, res, next) => {
  if (!API_TOKEN) return next()
  if (req.headers['x-api-token'] === API_TOKEN) return next()
  res.status(401).json({ error: 'Требуется ключ доступа (x-api-token)' })
})

// Rate limit на запуск пайплайна: минимальный интервал между запусками
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

const readJSON = (file: string) => {
  const filePath = path.join(rootDir, file)
  if (!fs.existsSync(filePath)) return []
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
}

const writeJSON = (file: string, data: any) => {
  fs.writeFileSync(path.join(rootDir, file), JSON.stringify(data, null, 2))
}

// Безопасное имя файла внутри kp_final (защита от path traversal)
const kpFilePath = (fileName: string): string | null => {
  if (typeof fileName !== 'string' || fileName.length === 0 || fileName.length > 120) return null
  if (fileName !== path.basename(fileName)) return null // запрещаем ../ и разделители
  const resolved = path.resolve(rootDir, 'kp_final', fileName)
  const kpDir = path.resolve(rootDir, 'kp_final') + path.sep
  if (!resolved.startsWith(kpDir)) return null
  return resolved
}

// Получить все лиды
app.get('/api/leads', (req, res) => {
  res.json(readJSON('leads_db.json'))
})

// Обновить лид
app.put('/api/leads/:id', (req, res) => {
  const leads = readJSON('leads_db.json')
  const idx = leads.findIndex((l: any) => l.id === req.params.id)
  if (idx === -1) return res.status(404).json({ error: 'Лид не найден' })

  const body = { ...req.body }
  // pdf_file: только null или безопасное имя файла (иначе path traversal)
  if (body.pdf_file !== undefined) {
    if (body.pdf_file === null || body.pdf_file === '') {
      body.pdf_file = null
    } else if (!kpFilePath(String(body.pdf_file))) {
      return res.status(400).json({ error: 'Некорректное имя файла КП' })
    }
  }
  // id менять нельзя
  delete body.id

  leads[idx] = { ...leads[idx], ...body }
  writeJSON('leads_db.json', leads)
  res.json(leads[idx])
})

// Скачать КП (HTML/PDF)
app.get('/api/leads/:id/pdf', (req, res) => {
  const leads = readJSON('leads_db.json')
  const lead = leads.find((l: any) => l.id === req.params.id)
  if (!lead?.pdf_file) return res.status(404).json({ error: 'КП не найдено' })

  const filePath = kpFilePath(String(lead.pdf_file))
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'Файл не существует' })

  res.setHeader('Content-Type', 'text/html')
  res.setHeader('Content-Disposition', `inline; filename="${path.basename(String(lead.pdf_file))}"`)
  fs.createReadStream(filePath).pipe(res)
})

// Получить сектора
app.get('/api/sectors', (req, res) => {
  res.json(readJSON('sectors.json'))
})

// Создать сектор
app.post('/api/sectors', (req, res) => {
  const sectors = readJSON('sectors.json')
  const newSector = { ...req.body, id: `sec_${Date.now()}` }
  sectors.push(newSector)
  writeJSON('sectors.json', sectors)

  const leads = readJSON('leads_db.json')
  const updatedLeads = leads.map((lead: any) => {
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
        return { ...lead, sector_id: newSector.id, assigned_manager_id: newSector.manager_id }
      }
    }
    return lead
  })
  writeJSON('leads_db.json', updatedLeads)
  res.json(newSector)
})

// Получить менеджеров
app.get('/api/managers', (req, res) => {
  res.json(readJSON('managers.json'))
})

// Аналитика
app.get('/api/analytics', (req, res) => {
  const leads = readJSON('leads_db.json')
  const managers = readJSON('managers.json')
  const sectors = readJSON('sectors.json')

  const stats = {
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
  }
  res.json(stats)
})

// 🚀 Асинхронный запуск пайплайна с прогрессом
interface PipelineJob {
  id: string
  status: 'running' | 'done' | 'error'
  stage: string
  processed: number
  total: number
  added: number
  totalFound: number
  message: string
  error?: string
  startedAt: string
}

const pipelineJobs: Record<string, PipelineJob> = {}

// Единый запуск пайплайна в фоне. meta — служебные поля, которые попадут в новые лида (источник)
function launchPipelineJob(params: {
  city: string; industry: string; limit: number
  options?: any
  source?: { search_task_id?: string; search_task_name?: string }
  onComplete?: (result: { status: string; found: number; added: number; error?: string }) => void
}): { jobId: string } | null {
  const { city, industry, limit, options, source, onComplete } = params
  const safeLimit = Math.min(Math.max(parseInt(limit as any) || 5, 1), 20)

  // Пропускаем, если пайплайн уже выполняется
  const running = Object.values(pipelineJobs).find(j => j.status === 'running')
  if (running) return null

  const jobId = `job_${Date.now()}`
  pipelineJobs[jobId] = {
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
  console.log(`📥 Запуск поиска: city=${city}, industry=${industry}, limit=${safeLimit} (job ${jobId})`)

  const stageText: Record<string, string> = {
    search: 'Поиск компаний...',
    enrich: 'Анализ сайтов...',
    kp: 'Генерация КП...',
    done: 'Готово'
  }

  ;(async () => {
    try {
      const supplierConfig = readJSON('supplier_config.json')
      const supplierName = supplierConfig?.name || 'УралАвтоОпт'

      const newLeads = await runPipeline(city, industry, safeLimit, supplierName, (stage, processed, total) => {
        const job = pipelineJobs[jobId]
        if (job) {
          job.stage = stage
          job.processed = processed
          job.total = Math.max(total, 1)
          job.message = stageText[stage] || stage
        }
      }, options)

      const job = pipelineJobs[jobId]

      if (newLeads.length === 0) {
        job.status = 'error'
        job.error = 'Компании не найдены. Попробуйте изменить город/отрасль или проверьте API-ключи.'
        onComplete?.({ status: 'error', found: 0, added: 0, error: job.error })
        return
      }

      // Добавление новых лидов в базу (проверка на дубликаты по домену)
      const existingLeads = readJSON('leads_db.json')
      const existingDomains = new Set(existingLeads.map((l: any) => l.domain))

      let addedCount = 0
      for (const lead of newLeads) {
        if (!existingDomains.has(lead.domain)) {
          const newLead = {
            ...lead,
            ...source,
            id: `lead_${Date.now()}_${addedCount}`,
            status: 'new',
            pdf_file: (lead as any).pdf_file || null,
            comments: [],
            status_history: [{ status: 'new', date: new Date().toLocaleString('ru-RU') }],
            sector_id: undefined,
            assigned_manager_id: undefined
          }
          existingLeads.push(newLead)
          addedCount++
        }
      }

      writeJSON('leads_db.json', existingLeads)

      job.status = 'done'
      job.added = addedCount
      job.totalFound = newLeads.length
      job.message = addedCount > 0
        ? `Найдено ${newLeads.length}, добавлено ${addedCount} новых лидов`
        : `Найдено ${newLeads.length} компаний, все уже есть в базе`
      console.log(`✅ Job ${jobId}: ${job.message}`)
      onComplete?.({ status: 'done', found: newLeads.length, added: addedCount })
    } catch (error) {
      console.error('❌ Ошибка пайплайна:', error)
      const job = pipelineJobs[jobId]
      if (job) {
        job.status = 'error'
        job.error = 'Ошибка при запуске пайплайна: ' + String(error)
      }
      onComplete?.({ status: 'error', found: 0, added: 0, error: String(error) })
    }
  })()

  return { jobId }
}

// Быстрый разовый запуск (без сохранённой задачи)
app.post('/api/run-pipeline', runCooldown, (req, res) => {
  const { city = 'Екатеринбург', industry = 'автозапчасти', limit = 5 } = req.body || {}
  const launched = launchPipelineJob({ city, industry, limit })
  if (!launched) {
    const running = Object.values(pipelineJobs).find(j => j.status === 'running')
    return res.json({ jobId: running?.id, alreadyRunning: true })
  }
  res.json({ jobId: launched.jobId })
})

app.get('/api/pipeline-status/:jobId', (req, res) => {
  const job = pipelineJobs[req.params.jobId]
  if (!job) return res.status(404).json({ error: 'Задача не найдена' })
  res.json(job)
})

// --- Задачи поиска (сущность "Поиск лидов"): параметры что/где/сколько + скоринг + обогащение ---
const TASKS_FILE = 'search_tasks.json'

interface SearchTask {
  id: string
  name: string
  city: string
  industry: string
  limit: number
  scoring?: any | null
  use_ai?: boolean
  use_geocode?: boolean
  status: 'draft' | 'running' | 'done' | 'error'
  last_run?: string | null
  leads_found?: number
  leads_added?: number
  last_error?: string
  created_at?: string
}

const getTasks = (): SearchTask[] => readJSON(TASKS_FILE)
const saveTasks = (tasks: SearchTask[]) => writeJSON(TASKS_FILE, tasks)

app.get('/api/search-tasks', (req, res) => {
  res.json(getTasks())
})

app.post('/api/search-tasks', (req, res) => {
  const tasks = getTasks()
  const t: SearchTask = {
    id: `task_${Date.now()}`,
    status: 'draft',
    last_run: null,
    leads_found: 0,
    leads_added: 0,
    created_at: new Date().toISOString(),
    ...req.body
  }
  tasks.push(t)
  saveTasks(tasks)
  res.json(t)
})

app.put('/api/search-tasks/:id', (req, res) => {
  const tasks = getTasks()
  const idx = tasks.findIndex((t: any) => t.id === req.params.id)
  if (idx === -1) return res.status(404).json({ error: 'Задача не найдена' })
  tasks[idx] = { ...tasks[idx], ...req.body, id: req.params.id }
  saveTasks(tasks)
  res.json(tasks[idx])
})

app.delete('/api/search-tasks/:id', (req, res) => {
  const tasks = getTasks().filter((t: any) => t.id !== req.params.id)
  saveTasks(tasks)
  res.json({ success: true })
})

app.post('/api/search-tasks/:id/run', runCooldown, (req, res) => {
  const tasks = getTasks()
  const task = tasks.find((t: any) => t.id === req.params.id)
  if (!task) return res.status(404).json({ error: 'Задача не найдена' })

  const launched = launchPipelineJob({
    city: task.city,
    industry: task.industry,
    limit: task.limit,
    options: {
      scoring: task.scoring || null,
      useAI: task.use_ai !== false,
      useGeocode: task.use_geocode !== false
    },
    source: { search_task_id: task.id, search_task_name: task.name },
    onComplete: (result) => {
      const current = getTasks()
      const idx = current.findIndex((t: any) => t.id === task.id)
      if (idx === -1) return
      current[idx].status = result.status === 'done' ? 'done' : 'error'
      current[idx].last_run = new Date().toISOString()
      current[idx].leads_found = result.found
      current[idx].leads_added = result.added
      current[idx].last_error = result.error
      saveTasks(current)
    }
  })

  if (!launched) {
    const running = Object.values(pipelineJobs).find(j => j.status === 'running')
    return res.json({ jobId: running?.id, alreadyRunning: true })
  }

  // Сразу помечаем задачу как выполняющуюся
  const idx = tasks.findIndex((t: any) => t.id === task.id)
  tasks[idx].status = 'running'
  tasks[idx].last_error = undefined
  saveTasks(tasks)

  res.json({ jobId: launched.jobId })
})

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`)
})

server.on('error', (err: any) => {
  console.error('❌ Ошибка запуска сервера:', err)
})