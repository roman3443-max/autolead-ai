-- Схема БД Lead Pipeline (идемпотентная, выполняется при каждом старте)
CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  domain TEXT,
  status TEXT DEFAULT 'new',
  lead_tier TEXT,
  lead_score INT DEFAULT 0,
  search_task_id TEXT,
  sector_id TEXT,
  assigned_manager_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  data JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_tier ON leads(lead_tier);
CREATE INDEX IF NOT EXISTS idx_leads_task ON leads(search_task_id);

CREATE TABLE IF NOT EXISTS search_tasks (
  id TEXT PRIMARY KEY,
  status TEXT DEFAULT 'draft',
  created_at TIMESTAMPTZ DEFAULT now(),
  data JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  status TEXT DEFAULT 'running',
  created_at TIMESTAMPTZ DEFAULT now(),
  data JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS managers (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS sectors (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS users (
  email TEXT PRIMARY KEY,
  name TEXT DEFAULT '',
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'manager',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kp_files (
  filename TEXT PRIMARY KEY,
  lead_id TEXT,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
