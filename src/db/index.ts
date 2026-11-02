// Унифицированный слой данных: PostgreSQL (Supabase) / pg-mem (тесты) / JSON-fallback.
// Когда DATABASE_URL не задан — работаем на старых JSON-файлах (режим совместимости).
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

// Загружаем .env независимо от точки входа (скрипты, тесты, сервер)
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

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = process.cwd()
const SCHEMA = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8')

type Exec = (sql: string, params?: any[]) => Promise<any[]>

let mode: 'pg' | 'json' = 'json'
let exec: Exec | null = null
let pgPool: any = null
let pgClient: any = null
let pgmemDb: any = null
let jsonPipelineLock: string | null = null
const PIPELINE_LOCK_TTL_MS = 5 * 60 * 1000

// ---------- JSON-fallback ----------
const jsonStore = {
  read(file: string, fallback: any) {
    const p = path.join(rootDir, file)
    if (!fs.existsSync(p)) return fallback
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')) } catch { return fallback }
  },
  write(file: string, data: any) {
    fs.writeFileSync(path.join(rootDir, file), JSON.stringify(data, null, 2))
  }
}

// ---------- init ----------
// Схему выполняем по одному выражению: идемпотентно и устойчиво к обрывам/пулерам
const SCHEMA_CLEAN = SCHEMA.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
const SCHEMA_STATEMENTS = SCHEMA_CLEAN.split(';').map(s => s.trim()).filter(Boolean)

async function runSchema() {
  for (const stmt of SCHEMA_STATEMENTS) {
    await exec!(stmt)
  }
}

export async function initDb(): Promise<'pg' | 'json'> {
  const url = process.env.DATABASE_URL || ''

  if (url === 'pgmem://test') {
    const { newDb } = await import('pg-mem')
    pgmemDb = newDb()
    const adapter = pgmemDb.adapters.createPg()
    pgClient = new adapter.Client()
    await pgClient.connect()
    exec = async (sql, params) => (await pgClient.query(sql, params)).rows
    await runSchema()
    mode = 'pg'
    await seedFromJsonIfEmpty()
    await seedAdminIfEmpty()
    return mode
  }

  if (url) {
    const { Pool } = await import('pg')
    pgPool = new Pool({
      connectionString: url,
      ssl: url.includes('supabase') ? { rejectUnauthorized: false } : undefined,
      keepAlive: true
    })
    const RETRYABLE = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EPIPE']
    exec = async (sql, params) => {
      for (let attempt = 1; attempt <= 4; attempt++) {
        try {
          return (await pgPool.query(sql, params)).rows
        } catch (e: any) {
          if (!RETRYABLE.includes(e?.code) || attempt === 4) throw e
        }
      }
      return []
    }
    await runSchema()
    mode = 'pg'
    await seedFromJsonIfEmpty()
    await seedAdminIfEmpty()
    return mode
  }

  mode = 'json'
  await seedUsersJsonIfEmpty()
  return mode
}

export function dbMode() { return mode }

export async function closeDb() {
  if (pgPool) await pgPool.end().catch(() => {})
  if (pgClient) await pgClient.end().catch(() => {})
  if (pgmemDb) pgmemDb.close && pgmemDb.close()
}

// ---------- seed ----------
// Все вставки — идемпотентные (ON CONFLICT), поэтому сид можно безопасно
// запускать при каждом старте: дорисует недостающее после обрывов/рестартов.
async function seedFromJsonIfEmpty() {
  if (fs.existsSync(path.join(rootDir, 'leads_db.json'))) {
    const leads = jsonStore.read('leads_db.json', [])
    for (const l of leads) await insertLead(l)
  }
  if (fs.existsSync(path.join(rootDir, 'search_tasks.json'))) {
    const tasks = jsonStore.read('search_tasks.json', [])
    for (const t of tasks) await insertTask(t)
  }
  if (fs.existsSync(path.join(rootDir, 'managers.json'))) {
    const m = jsonStore.read('managers.json', [])
    for (const x of m) await exec!('INSERT INTO managers (id, data) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [x.id, JSON.stringify(x)])
  }
  if (fs.existsSync(path.join(rootDir, 'sectors.json'))) {
    const s = jsonStore.read('sectors.json', [])
    for (const x of s) await exec!('INSERT INTO sectors (id, data) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [x.id, JSON.stringify(x)])
  }
  for (const key of ['supplier_config', 'scoring_config']) {
    const f = `${key}.json`
    if (fs.existsSync(path.join(rootDir, f))) {
      await exec!('INSERT INTO settings (key, data) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [key, JSON.stringify(jsonStore.read(f, {}))])
    }
  }
  // КП-файлы из kp_final
  const kpDir = path.join(rootDir, 'kp_final')
  if (fs.existsSync(kpDir)) {
    let n = 0
    for (const f of fs.readdirSync(kpDir).filter(f => f.endsWith('.html'))) {
      const leads = await exec!('SELECT id FROM leads WHERE data->>\'pdf_file\' = $1 LIMIT 1', [f])
      await exec!('INSERT INTO kp_files (filename, lead_id, content) VALUES ($1, $2, $3) ON CONFLICT (filename) DO NOTHING',
        [f, leads[0]?.id || null, fs.readFileSync(path.join(kpDir, f), 'utf-8')])
      n++
    }
  }
}

function requireAdminBootstrapCredentials(): { email: string; password: string } {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase() || ''
  const password = process.env.ADMIN_PASSWORD || ''
  if (!email || !password || password.length < 12) {
    throw new Error('Для первого запуска задайте ADMIN_EMAIL и ADMIN_PASSWORD (не менее 12 символов).')
  }
  return { email, password }
}

async function seedAdminIfEmpty() {
  const rows = await exec!('SELECT COUNT(*)::int AS n FROM users')
  if (rows[0].n === 0) {
    const { email, password } = requireAdminBootstrapCredentials()
    const bcrypt = await import('bcryptjs')
    const hash = await bcrypt.hash(password, 10)
    await exec!('INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, $4)', [email, 'Администратор', hash, 'admin'])
    console.log(`👤 Создан аккаунт администратора: ${email}`)
  }
}

async function seedUsersJsonIfEmpty() {
  const p = path.join(rootDir, 'users.json')
  let users: any[] = []
  if (fs.existsSync(p)) {
    try { users = JSON.parse(fs.readFileSync(p, 'utf-8')) } catch { users = [] }
  }
  if (users.length === 0) {
    const { email, password } = requireAdminBootstrapCredentials()
    const bcrypt = await import('bcryptjs')
    const password_hash = await bcrypt.hash(password, 10)
    users = [{ email, name: 'Администратор', password_hash, role: 'admin' }]
    jsonStore.write('users.json', users)
    console.log(`👤 Создан аккаунт администратора: ${email}`)
  }
}

// ---------- helpers ----------
function normalizeLead(l: any) {
  return {
    ...l.data,
    id: l.id,
    status: l.status ?? l.data?.status,
    lead_tier: l.lead_tier ?? l.data?.lead_tier,
    lead_score: l.lead_score ?? l.data?.lead_score,
  }
}

async function insertLead(lead: any) {
  await exec!(
    `INSERT INTO leads (id, domain, status, lead_tier, lead_score, search_task_id, sector_id, assigned_manager_id, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (id) DO UPDATE SET domain=$2, status=$3, lead_tier=$4, lead_score=$5,
       search_task_id=$6, sector_id=$7, assigned_manager_id=$8, data=$9`,
    [lead.id, lead.domain || null, lead.status || 'new', lead.lead_tier || null,
     lead.lead_score || 0, lead.search_task_id || null, lead.sector_id || null,
     lead.assigned_manager_id || null, JSON.stringify(lead)]
  )
}

async function insertTask(task: any) {
  await exec!(
    `INSERT INTO search_tasks (id, status, data) VALUES ($1,$2,$3)
     ON CONFLICT (id) DO UPDATE SET status=$2, data=$3`,
    [task.id, task.status || 'draft', JSON.stringify(task)]
  )
}

// ---------- public API ----------
export const db = {
  leads: {
    async list(): Promise<any[]> {
      if (mode === 'json') return jsonStore.read('leads_db.json', [])
      const rows = await exec!('SELECT * FROM leads ORDER BY created_at ASC')
      return rows.map(normalizeLead)
    },
    async get(id: string): Promise<any | null> {
      if (mode === 'json') return jsonStore.read('leads_db.json', []).find((l: any) => l.id === id) || null
      const rows = await exec!('SELECT * FROM leads WHERE id = $1', [id])
      return rows[0] ? normalizeLead(rows[0]) : null
    },
    async create(lead: any): Promise<void> {
      if (mode === 'json') {
        const all = jsonStore.read('leads_db.json', [])
        all.push(lead)
        jsonStore.write('leads_db.json', all)
        return
      }
      await insertLead(lead)
    },
    async update(id: string, patch: any): Promise<any | null> {
      if (mode === 'json') {
        const all = jsonStore.read('leads_db.json', [])
        const idx = all.findIndex((l: any) => l.id === id)
        if (idx === -1) return null
        all[idx] = { ...all[idx], ...patch }
        jsonStore.write('leads_db.json', all)
        return all[idx]
      }
      const cur = await db.leads.get(id)
      if (!cur) return null
      const next = { ...cur, ...patch }
      await insertLead(next)
      return next
    },
    async remove(id: string): Promise<boolean> {
      if (mode === 'json') {
        const all = jsonStore.read('leads_db.json', [])
        const next = all.filter((l: any) => l.id !== id)
        if (next.length === all.length) return false
        jsonStore.write('leads_db.json', next)
        return true
      }
      const r = await exec!('DELETE FROM leads WHERE id = $1', [id])
      return (r as any).rowCount !== 0
    },
  },

  tasks: {
    async list(): Promise<any[]> {
      if (mode === 'json') return jsonStore.read('search_tasks.json', [])
      const rows = await exec!('SELECT * FROM search_tasks ORDER BY created_at ASC')
      return rows.map(r => ({ ...r.data, id: r.id, status: r.status }))
    },
    async get(id: string): Promise<any | null> {
      if (mode === 'json') return jsonStore.read('search_tasks.json', []).find((t: any) => t.id === id) || null
      const rows = await exec!('SELECT * FROM search_tasks WHERE id = $1', [id])
      return rows[0] ? { ...rows[0].data, id: rows[0].id, status: rows[0].status } : null
    },
    async create(task: any): Promise<void> {
      if (mode === 'json') {
        const all = jsonStore.read('search_tasks.json', [])
        all.push(task)
        jsonStore.write('search_tasks.json', all)
        return
      }
      await insertTask(task)
    },
    async update(id: string, patch: any): Promise<any | null> {
      if (mode === 'json') {
        const all = jsonStore.read('search_tasks.json', [])
        const idx = all.findIndex((t: any) => t.id === id)
        if (idx === -1) return null
        all[idx] = { ...all[idx], ...patch, id }
        jsonStore.write('search_tasks.json', all)
        return all[idx]
      }
      const cur = await db.tasks.get(id)
      if (!cur) return null
      const next = { ...cur, ...patch, id }
      await insertTask(next)
      return next
    },
    async remove(id: string): Promise<void> {
      if (mode === 'json') {
        jsonStore.write('search_tasks.json', jsonStore.read('search_tasks.json', []).filter((t: any) => t.id !== id))
        return
      }
      await exec!('DELETE FROM search_tasks WHERE id = $1', [id])
    },
  },

  jobs: {
    async create(job: any): Promise<void> {
      if (mode === 'json') {
        const all = jsonStore.read('jobs_db.json', [])
        const index = all.findIndex((item: any) => item.id === job.id)
        if (index >= 0) all[index] = job
        else all.push(job)
        jsonStore.write('jobs_db.json', all)
        return
      }
      await exec!('INSERT INTO jobs (id, status, data) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET status=$2, data=$3',
        [job.id, job.status || 'running', JSON.stringify(job)])
    },
    async update(id: string, patch: any): Promise<void> {
      if (mode === 'json') {
        const all = jsonStore.read('jobs_db.json', [])
        const index = all.findIndex((item: any) => item.id === id)
        if (index < 0) return
        all[index] = { ...all[index], ...patch, id }
        jsonStore.write('jobs_db.json', all)
        return
      }
      const rows = await exec!('SELECT data FROM jobs WHERE id = $1', [id])
      if (!rows[0]) return
      const next = { ...rows[0].data, ...patch, id }
      await exec!('UPDATE jobs SET status = $2, data = $3 WHERE id = $1', [id, next.status || 'running', JSON.stringify(next)])
    },
    async get(id: string): Promise<any | null> {
      if (mode === 'json') return jsonStore.read('jobs_db.json', []).find((job: any) => job.id === id) || null
      const rows = await exec!('SELECT * FROM jobs WHERE id = $1', [id])
      return rows[0] ? { ...rows[0].data, id: rows[0].id } : null
    },
    async hasRunning(): Promise<boolean> {
      if (mode === 'json') return jsonStore.read('jobs_db.json', []).some((job: any) => job.status === 'running')
      const rows = await exec!('SELECT COUNT(*)::int AS n FROM jobs WHERE status = \'running\'')
      return rows[0].n > 0
    },
    async getActive(): Promise<any | null> {
      if (mode === 'json') {
        if (!jsonPipelineLock) return null
        return await db.jobs.get(jsonPipelineLock) || { id: jsonPipelineLock, status: 'running' }
      }
      const rows = await exec!('SELECT owner_job_id FROM pipeline_locks WHERE lock_key = $1 AND expires_at > NOW()', ['pipeline'])
      if (!rows[0]) return null
      return await db.jobs.get(rows[0].owner_job_id) || { id: rows[0].owner_job_id, status: 'running' }
    },
    async acquirePipelineLock(jobId: string): Promise<boolean> {
      if (mode === 'json') {
        if (jsonPipelineLock && jsonPipelineLock !== jobId) return false
        jsonPipelineLock = jobId
        return true
      }
      const expiresAt = new Date(Date.now() + PIPELINE_LOCK_TTL_MS)
      const rows = await exec!(
        `INSERT INTO pipeline_locks (lock_key, owner_job_id, expires_at)
         VALUES ('pipeline', $1, $2)
         ON CONFLICT (lock_key) DO UPDATE
           SET owner_job_id = EXCLUDED.owner_job_id, expires_at = EXCLUDED.expires_at
         WHERE pipeline_locks.expires_at < NOW()
         RETURNING owner_job_id`,
        [jobId, expiresAt]
      )
      return rows[0]?.owner_job_id === jobId
    },
    async renewPipelineLock(jobId: string): Promise<boolean> {
      if (mode === 'json') return jsonPipelineLock === jobId
      const expiresAt = new Date(Date.now() + PIPELINE_LOCK_TTL_MS)
      const rows = await exec!(
        'UPDATE pipeline_locks SET expires_at = $2 WHERE lock_key = $1 AND owner_job_id = $3 RETURNING owner_job_id',
        ['pipeline', expiresAt, jobId]
      )
      return rows.length > 0
    },
    async releasePipelineLock(jobId: string): Promise<void> {
      if (mode === 'json') {
        if (jsonPipelineLock === jobId) jsonPipelineLock = null
        return
      }
      await exec!('DELETE FROM pipeline_locks WHERE lock_key = $1 AND owner_job_id = $2', ['pipeline', jobId])
    },
    async markStaleRunningAsError(exceptJobId?: string): Promise<number> {
      let rows: any[]
      if (mode === 'json') {
        const all = jsonStore.read('jobs_db.json', [])
        rows = all.filter((job: any) => job.status === 'running' && job.id !== exceptJobId && job.id !== jsonPipelineLock)
        for (const row of rows) {
          const next = { ...row, status: 'error', error: 'Прервано остановкой или перезапуском сервера' }
          const index = all.findIndex((job: any) => job.id === row.id)
          if (index >= 0) all[index] = next
          if (row.search_task_id) {
            await db.tasks.update(row.search_task_id, {
              status: 'error',
              last_error: 'Поиск прерван остановкой или перезапуском сервера'
            })
          }
        }
        if (rows.length) jsonStore.write('jobs_db.json', all)
        return rows.length
      }
      rows = await exec!(
        `SELECT j.id, j.data
         FROM jobs j
         WHERE j.status = 'running'
           AND ($1::text IS NULL OR j.id <> $1)
           AND NOT EXISTS (
             SELECT 1 FROM pipeline_locks l
             WHERE l.lock_key = 'pipeline'
               AND l.owner_job_id = j.id
               AND l.expires_at > NOW()
           )`,
        [exceptJobId || null]
      )
      for (const row of rows) {
        const data = { ...row.data, status: 'error', error: 'Прервано остановкой или перезапуском сервера' }
        await exec!('UPDATE jobs SET status = \'error\', data = $2 WHERE id = $1', [row.id, JSON.stringify(data)])
        if (data.search_task_id) {
          await db.tasks.update(data.search_task_id, {
            status: 'error',
            last_error: 'Поиск прерван остановкой или перезапуском сервера'
          })
        }
      }
      return rows.length
    },
  },

  managers: {
    async list(): Promise<any[]> {
      if (mode === 'json') return jsonStore.read('managers.json', [])
      const rows = await exec!('SELECT * FROM managers')
      return rows.map(r => r.data)
    },
  },

  sectors: {
    async list(): Promise<any[]> {
      if (mode === 'json') return jsonStore.read('sectors.json', [])
      const rows = await exec!('SELECT * FROM sectors')
      return rows.map(r => r.data)
    },
    async create(sector: any): Promise<void> {
      if (mode === 'json') {
        const all = jsonStore.read('sectors.json', [])
        all.push(sector)
        jsonStore.write('sectors.json', all)
        return
      }
      await exec!('INSERT INTO sectors (id, data) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING', [sector.id, JSON.stringify(sector)])
    },
  },

  settings: {
    async get(key: string): Promise<any> {
      if (mode === 'json') return jsonStore.read(`${key}.json`, null)
      const rows = await exec!('SELECT data FROM settings WHERE key = $1', [key])
      return rows[0]?.data ?? null
    },
    async set(key: string, value: any): Promise<void> {
      if (mode === 'json') {
        jsonStore.write(`${key}.json`, value)
        return
      }
      await exec!('INSERT INTO settings (key, data) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET data=$2', [key, JSON.stringify(value)])
    },
  },

  users: {
    async findByEmail(email: string): Promise<any | null> {
      if (mode === 'json') return jsonStore.read('users.json', []).find((u: any) => u.email === email) || null
      const rows = await exec!('SELECT * FROM users WHERE email = $1', [email])
      return rows[0] || null
    },
    async create(user: any): Promise<void> {
      if (mode === 'json') {
        const all = jsonStore.read('users.json', [])
        all.push(user)
        jsonStore.write('users.json', all)
        return
      }
      await exec!('INSERT INTO users (email, name, password_hash, role) VALUES ($1,$2,$3,$4) ON CONFLICT (email) DO NOTHING',
        [user.email, user.name || '', user.password_hash, user.role || 'manager'])
    },
    async list(): Promise<any[]> {
      if (mode === 'json') return jsonStore.read('users.json', []).map(({ password_hash, ...u }: any) => u)
      const rows = await exec!('SELECT email, name, role, created_at FROM users')
      return rows
    },
  },

  kp: {
    async put(filename: string, leadId: string | null, content: string): Promise<void> {
      if (mode === 'json') {
        const dir = path.join(rootDir, 'kp_final')
        if (!fs.existsSync(dir)) fs.mkdirSync(dir)
        fs.writeFileSync(path.join(dir, filename), content, 'utf-8')
        return
      }
      await exec!('INSERT INTO kp_files (filename, lead_id, content) VALUES ($1,$2,$3) ON CONFLICT (filename) DO UPDATE SET content=$3, lead_id=$2',
        [filename, leadId, content])
    },
    async get(filename: string): Promise<string | null> {
      if (mode === 'json') {
        const p = path.join(rootDir, 'kp_final', filename)
        return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null
      }
      const rows = await exec!('SELECT content FROM kp_files WHERE filename = $1', [filename])
      return rows[0]?.content ?? null
    },
    async removeIfUnused(filename: string, leadId: string): Promise<void> {
      if (mode === 'json') {
        const p = path.join(rootDir, 'kp_final', filename)
        const leads = jsonStore.read('leads_db.json', [])
        const used = leads.some((l: any) => l.pdf_file === filename && l.id !== leadId)
        if (!used && fs.existsSync(p)) { try { fs.unlinkSync(p) } catch { /* ignore */ } }
        return
      }
      const rows = await exec!('SELECT COUNT(*)::int AS n FROM leads WHERE data->>\'pdf_file\' = $1 AND id <> $2', [filename, leadId])
      if (rows[0].n === 0) await exec!('DELETE FROM kp_files WHERE filename = $1', [filename])
    },
  },
}
