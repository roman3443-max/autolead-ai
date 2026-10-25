import express from 'express'
import cors from 'cors'
import fs from 'fs'
import path from 'path'
import { runPipeline } from './src/pipeline.ts'

const app = express()
const PORT = process.env.PORT || 3001
const rootDir = process.cwd()

app.use(cors())
app.use(express.json())
app.use('/kp_final', express.static(path.join(rootDir, 'kp_final')))

const readJSON = (file: string) => {
  const filePath = path.join(rootDir, file)
  if (!fs.existsSync(filePath)) return []
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
}

const writeJSON = (file: string, data: any) => {
  fs.writeFileSync(path.join(rootDir, file), JSON.stringify(data, null, 2))
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

  leads[idx] = { ...leads[idx], ...req.body }
  writeJSON('leads_db.json', leads)
  res.json(leads[idx])
})

// Скачать КП (HTML/PDF)
app.get('/api/leads/:id/pdf', (req, res) => {
  const leads = readJSON('leads_db.json')
  const lead = leads.find((l: any) => l.id === req.params.id)
  if (!lead?.pdf_file) return res.status(404).json({ error: 'КП не найдено' })

  const filePath = path.join(rootDir, 'kp_final', lead.pdf_file)
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Файл не существует' })

  res.setHeader('Content-Type', 'text/html')
  res.setHeader('Content-Disposition', `inline; filename="${lead.pdf_file}"`)
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

app.post('/api/run-pipeline', (req, res) => {
  const { city = 'Екатеринбург', industry = 'автозапчасти', limit = 5 } = req.body || {}
  const safeLimit = Math.min(Math.max(parseInt(limit) || 5, 1), 20)

  // Пропускаем, если пайплайн уже выполняется
  const running = Object.values(pipelineJobs).find(j => j.status === 'running')
  if (running) {
    return res.json({ jobId: running.id, alreadyRunning: true })
  }

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
  console.log(`📥 Запрос на поиск: city=${city}, industry=${industry}, limit=${safeLimit} (job ${jobId})`)

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
      })

      const job = pipelineJobs[jobId]

      if (newLeads.length === 0) {
        job.status = 'error'
        job.error = 'Компании не найдены. Попробуйте изменить город/отрасль или проверьте API-ключи.'
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
    } catch (error) {
      console.error('❌ Ошибка пайплайна:', error)
      const job = pipelineJobs[jobId]
      if (job) {
        job.status = 'error'
        job.error = 'Ошибка при запуске пайплайна: ' + String(error)
      }
    }
  })()

  res.json({ jobId })
})

app.get('/api/pipeline-status/:jobId', (req, res) => {
  const job = pipelineJobs[req.params.jobId]
  if (!job) return res.status(404).json({ error: 'Задача не найдена' })
  res.json(job)
})

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`)
})

server.on('error', (err: any) => {
  console.error('❌ Ошибка запуска сервера:', err)
})