# AutoLead AI

Веб-приложение для поиска и обогащения B2B-лидов. Интерфейс работает на Vite/React, API — на Express, для постоянного хранения рекомендуется PostgreSQL.

## Локальный запуск

Требуется Node.js 20 или новее.

1. Установите зависимости: `npm install`.
2. Создайте файл `.env` в корне проекта.
3. Добавьте настройки:

```dotenv
JWT_SECRET=replace-with-a-random-secret-of-at-least-32-characters
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=replace-with-a-unique-password-at-least-12-characters
DATABASE_URL=postgresql://...
TAVILY_API_KEY=
FIRECRAWL_API_KEY=
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.8-flash
ALLOWED_ORIGINS=http://localhost:5173
VITE_API_URL=http://localhost:3001
```

`JWT_SECRET` обязателен при каждом запуске. `ADMIN_EMAIL` и `ADMIN_PASSWORD` нужны только при первом запуске, если база пользователей пуста. Для последующих запусков используйте ту же базу данных или сохранённый файл `users.json`.

`DATABASE_URL` можно не задавать для локальной проверки: приложение переключится на JSON-файлы. Для развёртывания используйте PostgreSQL, так как локальные файлы могут не сохраняться между перезапусками платформы.

4. Запустите API в одном терминале: `npm run start`.
5. Запустите интерфейс во втором терминале: `npm run dev`.

Откройте URL, напечатанный Vite (обычно `http://localhost:5173`). Не добавляйте `.env` в Git.

## Сторонние сервисы

Поиск использует Tavily, анализ сайтов — Firecrawl, AI-обогащение и генерация коммерческих предложений — Gemini. Для запуска пайплайна нужны соответствующие API-ключи. Геокодирование выполняется через Nominatim.
