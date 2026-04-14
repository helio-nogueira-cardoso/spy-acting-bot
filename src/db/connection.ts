import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import path from 'path';
import fs from 'fs';

const DB_DIR = path.resolve(process.cwd(), 'data');
const DB_PATH = process.env.DATABASE_URL || path.join(DB_DIR, 'spy-acting.db');

// Garante que o diretório data/ existe (não necessário para :memory:)
if (DB_PATH !== ':memory:') {
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }
}

export const sqlite: DatabaseType = new Database(DB_PATH);

// WAL mode para melhor performance de leitura concorrente
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

// Auto-create tables if they don't exist
sqlite.exec(`
CREATE TABLE IF NOT EXISTS games (
  id              TEXT PRIMARY KEY NOT NULL,
  chat_id         INTEGER NOT NULL,
  creator_id      INTEGER NOT NULL,
  mode            TEXT NOT NULL DEFAULT 'auto',
  total_rounds    INTEGER NOT NULL DEFAULT 5,
  current_round   INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'lobby',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS players (
  id              INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  game_id         TEXT NOT NULL REFERENCES games(id),
  user_id         INTEGER NOT NULL,
  username        TEXT,
  display_name    TEXT NOT NULL,
  photo_file_id   TEXT,
  photo_path      TEXT,
  total_score     INTEGER NOT NULL DEFAULT 0,
  is_active       INTEGER NOT NULL DEFAULT 1,
  joined_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rounds (
  id              INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  game_id         TEXT NOT NULL REFERENCES games(id),
  round_number    INTEGER NOT NULL,
  location_key    TEXT NOT NULL,
  location_name   TEXT NOT NULL,
  spy_hint        TEXT NOT NULL,
  spy_player_id   INTEGER NOT NULL REFERENCES players(id),
  status          TEXT NOT NULL DEFAULT 'active',
  spy_guess       TEXT,
  spy_guess_approved INTEGER,
  started_at      TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at        TEXT
);

CREATE TABLE IF NOT EXISTS spy_guess_votes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  round_id        INTEGER NOT NULL REFERENCES rounds(id),
  voter_player_id INTEGER NOT NULL REFERENCES players(id),
  vote            INTEGER NOT NULL,
  voted_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS round_roles (
  id              INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  round_id        INTEGER NOT NULL REFERENCES rounds(id),
  player_id       INTEGER NOT NULL REFERENCES players(id),
  role            TEXT NOT NULL,
  character_name  TEXT NOT NULL,
  assigned_group  INTEGER,
  group_type      TEXT
);

CREATE TABLE IF NOT EXISTS pairings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  round_id        INTEGER NOT NULL REFERENCES rounds(id),
  requester_id    INTEGER NOT NULL REFERENCES players(id),
  target_id       INTEGER NOT NULL REFERENCES players(id),
  status          TEXT NOT NULL DEFAULT 'pending',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at     TEXT
);

CREATE TABLE IF NOT EXISTS player_round_state (
  id              INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  round_id        INTEGER NOT NULL REFERENCES rounds(id),
  player_id       INTEGER NOT NULL REFERENCES players(id),
  pairing_status  TEXT NOT NULL DEFAULT 'unpaired',
  paired_with     TEXT,
  verdict_active  INTEGER NOT NULL DEFAULT 0,
  round_score     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS manual_configs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  round_id        INTEGER NOT NULL REFERENCES rounds(id),
  configurator_id INTEGER NOT NULL,
  location_name   TEXT NOT NULL,
  spy_hint        TEXT NOT NULL,
  groups_characters_json TEXT NOT NULL
);
`);

export const db = drizzle(sqlite, { schema });
