import jwt from 'jsonwebtoken'
import { db, initDb, dbMode } from './db/index.ts'

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET?.trim() || ''
  if (secret.length < 32) {
    throw new Error('JWT_SECRET должен быть задан и содержать не менее 32 символов.')
  }
  return secret
}

export function assertAuthConfig(): void {
  getJwtSecret()
}

export function signToken(user: any): string {
  return jwt.sign({ email: user.email, role: user.role, name: user.name }, getJwtSecret(), { expiresIn: '7d' })
}

export function verifyToken(token: string): any | null {
  try { return jwt.verify(token, getJwtSecret()) } catch { return null }
}

// Express middleware: требует Bearer JWT для всех /api, кроме /api/auth/login
export function authMiddleware(req: any, res: any, next: any) {
  if (req.path === '/api/auth/login') return next()
  const header = String(req.headers.authorization || '')
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  const payload = token ? verifyToken(token) : null
  if (!payload) return res.status(401).json({ error: 'Требуется вход' })
  req.user = payload
  next()
}

export function requireAdmin(req: any, res: any, next: any) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Нужны права администратора' })
  next()
}

export async function loginHandler(req: any, res: any) {
  const email = String(req.body?.email || '').trim().toLowerCase()
  const password = String(req.body?.password || '')
  if (!email || !password) return res.status(400).json({ error: 'Укажите email и пароль' })
  const user = await db.users.findByEmail(email)
  if (!user) return res.status(401).json({ error: 'Неверный email или пароль' })
  const bcrypt = await import('bcryptjs')
  const ok = await bcrypt.compare(password, user.password_hash)
  if (!ok) return res.status(401).json({ error: 'Неверный email или пароль' })
  res.json({ token: signToken(user), user: { email: user.email, name: user.name, role: user.role } })
}
