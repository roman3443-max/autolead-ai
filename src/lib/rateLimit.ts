type RateLimitOptions = {
  windowMs: number
  max: number
  keyGenerator: (req: any) => string
  message: string
}

type Bucket = { count: number; resetAt: number }

/** Small process-local limiter for the single-instance deployment. */
export function createRateLimiter({ windowMs, max, keyGenerator, message }: RateLimitOptions) {
  const buckets = new Map<string, Bucket>()
  let checks = 0

  return (req: any, res: any, next: () => void) => {
    const now = Date.now()
    if (++checks % 100 === 0 || buckets.size > 5000) {
      for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key)
    }

    const key = keyGenerator(req) || 'unknown'
    let bucket = buckets.get(key)
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs }
      buckets.set(key, bucket)
    }

    if (bucket.count >= max) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))))
      return res.status(429).json({ error: message })
    }

    bucket.count++
    next()
  }
}
