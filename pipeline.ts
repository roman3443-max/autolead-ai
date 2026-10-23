import { tavily } from 'tavily-js'
import FirecrawlApp from '@mendable/firecrawl-js'
import { GoogleGenerativeAI } from '@google/generative-ai'
import fs from 'fs'
import path from 'path'

// Инициализация API (ключи берутся из .env)
const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY || '' })
const firecrawlApp = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY || '' })
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '')

interface LeadData {
  company_name: string
  domain: string
  city: string
  address?: string
  coordinates?: { lat: number; lng: number }
  lpr: { name: string; position: string }[]
  lpr_emails: string[]
  brands: string[]
  lead_score: number
  lead_tier: 'A' | 'B' | 'C'
}

// Этап 1: Поиск компаний через Tavily
export async function searchCompanies(city: string, industry: string, limit: number = 10) {
  console.log(`🔍 Поиск компаний: ${city}, ${industry}`)
  
  const query = `${industry} ${city} компания оптом официальный сайт`
  
  try {
    const response = await tvly.search(query, {
      search_depth: 'basic',
      max_results: limit
    })
    
    const companies = response.results.map((result: any) => ({
      company_name: result.title || 'Неизвестная компания',
      domain: new URL(result.url).hostname,
      url: result.url,
      snippet: result.content
    }))
    
    console.log(`✅ Найдено ${companies.length} компаний`)
    return companies
  } catch (error) {
    console.error('❌ Ошибка Tavily:', error)
    return []
  }
}

// Этап 2: Обогащение данных через Firecrawl
export async function enrichCompanyData(companies: any[]) {
  console.log('🕷️ Обогащение данных...')
  
  const enrichedLeads: LeadData[] = []
  
  for (const company of companies) {
    try {
      console.log(`   Парсинг ${company.domain}...`)
      
      const scrapeResult = await firecrawlApp.scrapeUrl(company.url, {
        formats: ['markdown'],
        onlyMainContent: true
      })
      
      if (!scrapeResult.success || !scrapeResult.markdown) {
        console.log(`  ⚠️ Не удалось спарсить ${company.domain}`)
        continue
      }
      
      const content = scrapeResult.markdown
      
      const lpr = extractLPR(content)
      const lpr_emails = extractEmails(content)
      const brands = extractBrands(content)
      const coordinates = await getCoordinates(company.company_name, city)
      const lead_score = calculateLeadScore(lpr.length, brands.length, content.length)
      const lead_tier = getLeadTier(lead_score)
      
      enrichedLeads.push({
        company_name: company.company_name,
        domain: company.domain,
        city: city,
        address: extractAddress(content),
        coordinates,
        lpr,
        lpr_emails: lpr_emails.slice(0, 3),
        brands,
        lead_score,
        lead_tier
      })
      
      console.log(`  ✅ ${company.domain}: ЛПР=${lpr.length}, Email=${lpr_emails.length}, Бренды=${brands.length}`)
    } catch (error) {
      console.error(`  ❌ Ошибка при парсинге ${company.domain}:`, error)
    }
  }
  
  console.log(`✅ Обогащено ${enrichedLeads.length} лидов`)
  return enrichedLeads
}

// Этап 3: Генерация КП через Gemini (сохраняем как HTML)
export async function generateKP(lead: LeadData, supplierName: string) {
  console.log(`📝 Генерация КП для ${lead.company_name}...`)
  
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' })
    
    const prompt = `
Создай персонализированное коммерческое предложение от поставщика "${supplierName}" для компании "${lead.company_name}".
Информация: Сайт: ${lead.domain}, Город: ${lead.city}, ЛПР: ${lead.lpr.map(l => `${l.name} (${l.position})`).join(', ')}, Бренды: ${lead.brands.join(', ')}.
Требования:
1. Заголовок: "Коммерческое предложение"
2. Приветствие по имени ЛПР
3. Краткое представление поставщика
4. Ассортимент (упомяни бренды клиента)
5. Условия сотрудничества (оптовые цены, доставка)
6. Призыв к действию и контакты.
Формат: Чистый HTML с базовыми тегами (<h1>, <h2>, <p>, <ul>, <li>, <b>), без <html> и <body>, только контент.
`
    
    const result = await model.generateContent(prompt)
    const kpText = result.response.text()
    
    const fileName = `${lead.company_name.replace(/[^a-z0-9а-яё]/gi, '_')}.html`
    const filePath = path.join(process.cwd(), 'kp_final', fileName)
    
    // Создаем папку, если её нет
    if (!fs.existsSync(path.join(process.cwd(), 'kp_final'))) {
      fs.mkdirSync(path.join(process.cwd(), 'kp_final'))
    }
    
    fs.writeFileSync(filePath, kpText, 'utf-8')
    console.log(`✅ КП сохранено: ${fileName}`)
    return fileName
  } catch (error) {
    console.error('❌ Ошибка генерации КП:', error)
    return null
  }
}

// --- Вспомогательные функции ---

function extractLPR(content: string): { name: string; position: string }[] {
  const lpr: { name: string; position: string }[] = []
  const patterns = [/директор[:\s]+([А-Яа-яЁё\s]+)/gi, /руководитель[:\s]+([А-Яа-яЁё\s]+)/gi, /менеджер[:\s]+([А-Яа-яЁё\s]+)/gi]
  
  for (const pattern of patterns) {
    const matches = [...content.matchAll(pattern)]
    for (const match of matches) {
      if (lpr.length >= 2) break
      lpr.push({ name: match[1].trim(), position: 'Контактное лицо' })
    }
  }
  if (lpr.length === 0) lpr.push({ name: 'Руководитель', position: 'Директор' }) // Заглушка
  return lpr.slice(0, 2)
}

function extractEmails(content: string): string[] {
  const emails = content.match(/[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || []
  return [...new Set(emails)].slice(0, 3)
}

function extractBrands(content: string): string[] {
  const known = ['Toyota', 'Nissan', 'Honda', 'Mazda', 'Bosch', 'Denso', 'LADA', 'ВАЗ', 'ГАЗ', 'КАМАЗ']
  const found = known.filter(b => content.toLowerCase().includes(b.toLowerCase()))
  return found.length > 0 ? found : ['Автозапчасти']
}

function extractAddress(content: string): string {
  const match = content.match(/адрес[:\s]+(.+?)(?:\n|,|$)/gi)
  return match ? match[0].replace(/адрес[:\s]+/i, '').trim() : ''
}

async function getCoordinates(companyName: string, city: string) {
  // Заглушка координат вокруг центра города
  return {
    lat: 56.838011 + (Math.random() - 0.5) * 0.05,
    lng: 60.597474 + (Math.random() - 0.5) * 0.05
  }
}

function calculateLeadScore(lprCount: number, brandsCount: number, contentLength: number): number {
  let score = 50
  if (lprCount > 0) score += 20
  if (brandsCount > 2) score += 15
  if (contentLength > 1000) score += 15
  return Math.min(score, 100)
}

function getLeadTier(score: number): 'A' | 'B' | 'C' {
  if (score >= 80) return 'A'
  if (score >= 60) return 'B'
  return 'C'
}

// Главная функция
export async function runPipeline(city: string = 'Екатеринбург', industry: string = 'автозапчасти', limit: number = 5, supplierName: string = 'УралАвтоОпт') {
  console.log('🚀 Запуск пайплайна...')
  const companies = await searchCompanies(city, industry, limit)
  if (companies.length === 0) return []
  
  const leads = await enrichCompanyData(companies)
  for (const lead of leads) {
    await generateKP(lead, supplierName)
  }
  console.log('✅ Пайплайн завершен!')
  return leads
}