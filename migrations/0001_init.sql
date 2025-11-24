-- Migration number: 0001 	 2024-05-24T10:00:00.000Z
-- Table for Sales Entries
CREATE TABLE IF NOT EXISTS entries (
    id TEXT PRIMARY KEY,
    kv TEXT,
    projectNumber TEXT,
    data TEXT NOT NULL, -- JSON content
    updatedAt INTEGER
);

CREATE INDEX IF NOT EXISTS idx_entries_kv ON entries(kv);
CREATE INDEX IF NOT EXISTS idx_entries_projectNumber ON entries(projectNumber);

-- Table for People/Staff
CREATE TABLE IF NOT EXISTS people (
    id TEXT PRIMARY KEY,
    email TEXT,
    data TEXT NOT NULL, -- JSON content
    updatedAt INTEGER
);

CREATE INDEX IF NOT EXISTS idx_people_email ON people(email);

-- Table for Logs
CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL, -- YYYY-MM-DD
    data TEXT NOT NULL, -- JSON content
    createdAt INTEGER
);

CREATE INDEX IF NOT EXISTS idx_logs_date ON logs(date);
