import express from 'express'
import cors from 'cors'
import fs from 'fs'
import path from 'path'
import * as turf from '@turf/turf'

const app = express()
const PORT = 3001
const rootDir = process.cwd()

app.use(cors())
app.use(express.json())
app.use('/kp_final', express.static(path.join(rootDir, 'kp_final')))

// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ---
const readJSON = (file: string) => JSON.parse(fs.readFileSync(path.join(rootDir, file), 'utf-8'))
const writeJSON = (file: string, data: any) => fs.writeFileSync(path.join(rootDir, file), JSON.stringify(data, null, 2))

// --- API ЛИДОВ ---
app.get('/api/leads', (req, res) => res.json(readJSON('leads_db.json')))

app.put('/api/leads/:id', (req, res) => {
  const leads = readJSON('leads_db.json')
  const idx = leads.findIndex((l: any) => l.id === req.params.id)
  if (idx === -1) return res.status(404).json({ error: 'Лид не найден' })
  
  leads[idx] = { ...leads[idx], ...req.body }
  writeJSON('leads_db.json', leads)
  
  // Авто-назначение сектора при смене координат или статуса (упрощенно)
  res.json(leads[idx])
})

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

// --- API СЕКТОРОВ ---
app.get('/api/sectors', (req, res) => res.json(readJSON('sectors.json')))
app.post('/api/sectors', (req, res) => {
  const sectors = readJSON('sectors.json')
  const newSector = { ...req.body, id: `sec_${Date.now()}` }
  sectors.push(newSector)
  writeJSON('sectors.json', sectors)
  
  // Авто-распределение лидов в новый сектор
  const leads = readJSON('leads_db.json')
  const updatedLeads = leads.map((lead: any) => {
    if (lead.coordinates) {
      const point = turf.point([lead.coordinates.lng, lead.coordinates.lat])
      const poly = turf.polygon(newSector.polygon.geometry.coordinates)
      if (turf.booleanPointInPolygon(point, poly)) {
        return { ...lead, sector_id: newSector.id, assigned_manager_id: newSector.manager_id }
      }
    }
    return lead
  })
  writeJSON('leads_db.json', updatedLeads)
  
  res.json(newSector)
})

// --- API МЕНЕДЖЕРОВ ---
app.get('/api/managers', (req, res) => res.json(readJSON('managers.json')))

// --- API АНАЛИТИКИ ---
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

app.listen(PORT, () => console.log(`✅ Сервер запущен на http://localhost:${PORT}`))