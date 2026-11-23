import test from 'node:test'
import assert from 'node:assert/strict'
import { createRateLimiter } from './rateLimit.ts'

function response() {
  return {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: null as any,
    setHeader(name: string, value: string) { this.headers[name] = value },
    status(code: number) { this.statusCode = code; return this },
    json(value: any) { this.body = value; return this },
  }
}

test('rate limiter allows max requests and rejects the next request with Retry-After', () => {
  const limit = createRateLimiter({ windowMs: 60_000, max: 2, keyGenerator: req => req.ip, message: 'too many' })
  let calls = 0
  const next = () => calls++
  const req = { ip: '127.0.0.1' }
  limit(req, response(), next)
  limit(req, response(), next)
  const blocked = response()
  limit(req, blocked, next)
  assert.equal(calls, 2)
  assert.equal(blocked.statusCode, 429)
  assert.equal(blocked.headers['Retry-After'], '60')
})

test('rate limiter keeps independent keys isolated', () => {
  const limit = createRateLimiter({ windowMs: 60_000, max: 1, keyGenerator: req => req.ip, message: 'too many' })
  const first = response()
  const second = response()
  limit({ ip: 'a' }, first, () => {})
  limit({ ip: 'b' }, second, () => {})
  assert.equal(first.statusCode, 200)
  assert.equal(second.statusCode, 200)
})
