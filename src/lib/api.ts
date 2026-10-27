export const API_URL = (import.meta as any).env?.VITE_API_URL || 'http://localhost:3001'

export const getToken = () =>
  typeof window !== 'undefined' ? localStorage.getItem('auth_token') || '' : ''

export const setToken = (token: string) => {
  if (typeof window === 'undefined') return
  if (token) localStorage.setItem('auth_token', token)
  else localStorage.removeItem('auth_token')
}

// fetch-обёртка: Bearer JWT, при 401 вызывает колбэк авторизации
export const createApiFetch = (onUnauthorized: () => void) =>
  async function apiFetch(url: string, options: RequestInit = {}) {
    const token = getToken()
    const res = await fetch(url, {
      ...options,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {})
      }
    })
    if (res.status === 401) onUnauthorized()
    return res
  }
