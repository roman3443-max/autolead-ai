// Проверка подключения к БД и содержимого таблиц
// Запуск: npx tsx scripts/check-db.mts
import { initDb, db, closeDb, dbMode } from '../src/db/index.ts'

const mode = await initDb()
console.log('Режим:', dbMode())

const leads = await db.leads.list()
const tasks = await db.tasks.list()
const managers = await db.managers.list()
const sectors = await db.sectors.list()
const supplier = await db.settings.get('supplier_config')
const scoring = await db.settings.get('scoring_config')
const users = await db.users.list()

console.log('─'.repeat(40))
console.log('leads:    ', leads.length)
console.log('tasks:    ', tasks.length)
console.log('managers: ', managers.length)
console.log('sectors:  ', sectors.length)
console.log('users:    ', users.map((u: any) => `${u.email} (${u.role})`).join(', ') || '-')
console.log('supplier: ', supplier?.name || '-')
console.log('scoring:  ', scoring ? `веса ${Object.keys(scoring.weights || {}).length}, штраф ${scoring.retailPenalty}` : '-')

// проверка round-trip: запись + чтение тестового лида
const testId = 'dbcheck_test_lead'
await db.leads.update(testId, { company_name: 'DB CHECK', domain: 'dbcheck.local', status: 'new', lead_tier: 'C', lead_score: 1 })
const got = await db.leads.get(testId)
console.log('round-trip запись/чтение:', got?.company_name === 'DB CHECK' ? 'OK' : 'FAIL')
await db.leads.remove(testId)
console.log('удаление тестового лида:', (await db.leads.get(testId)) === null ? 'OK' : 'FAIL')

await closeDb()
console.log('✅ Проверка БД завершена (режим:', mode + ')')
