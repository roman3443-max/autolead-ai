import fs from 'fs'
import path from 'path'
import { rescoreLead } from '../src/pipeline.ts'

const rootDir = process.cwd()
const dbPath = path.join(rootDir, 'leads_db.json')

if (!fs.existsSync(dbPath)) {
  console.error('leads_db.json не найден')
  process.exit(1)
}

const leads = JSON.parse(fs.readFileSync(dbPath, 'utf-8'))
const rescored = leads.map((l: any) => rescoreLead(l))
fs.writeFileSync(dbPath, JSON.stringify(rescored, null, 2))

const dist = { A: 0, B: 0, C: 0 }
rescored.forEach((l: any) => { dist[l.lead_tier] = (dist[l.lead_tier] || 0) + 1 })
console.log(`✅ Пересчитано ${rescored.length} лидов. Распределение: A=${dist.A}, B=${dist.B}, C=${dist.C}`)
