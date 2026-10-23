import express from 'express'
import cors from 'cors'
import fs from 'fs'
import path from 'path'

const app = express()
const PORT = 3001
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

// Скачать PDF
app.get('/api/leads/:id/pdf', (req, res) => {
  const leads = readJSON('leads_db.json')
  const lead = leads.find((l: any) => l.id === req.params.id)
  if (!lead?.pdf_file) return res.status(404).json({ error: 'PDF не найден' })

  const pdfPath = path.join(rootDir, 'kp_final', lead.pdf_file)
  if (!fs.existsSync(pdfPath)) return res.status(404).json({ error: 'Файл не существует' })

  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `inline; filename="${lead.pdf_file}"`)
  fs.createReadStream(pdfPath).pipe(res)
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

  // Авто-распределение лидов по bounding box сектора
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

app.listen(PORT, () => {
  console.log(`✅ Сервер запущен на http://localhost:${PORT}`)
})