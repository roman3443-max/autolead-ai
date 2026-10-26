export const API_URL = (import.meta as any).env?.VITE_API_URL || 'http://localhost:3001'

export const getToken = () =>
  typeof window !== 'undefined' ? localStorage.getItem('api_token') || '' : ''

// fetch-обёртка: подставляет токен, при 401 вызывает колбэк авторизации
export const createApiFetch = (onUnauthorized: () => void) =>
  async function apiFetch(url: string, options: RequestInit = {}) {
    const token = getToken()
    const res = await fetch(url, {
      ...options,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { 'x-api-token': token } : {}),
        ...(options.headers || {})
      }
    })
    if (res.status === 401) onUnauthorized()
    return res
  }
