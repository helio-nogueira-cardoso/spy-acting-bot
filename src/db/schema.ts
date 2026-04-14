import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// ─── games ───────────────────────────────────────────────────────
export const games = sqliteTable('games', {
  id: text('id').primaryKey(),                              // nanoid (ex: "game_xK9mP2")
  chatId: integer('chat_id').notNull(),                     // ID do grupo Telegram
  creatorId: integer('creator_id').notNull(),               // Telegram user ID do criador
  mode: text('mode').notNull().default('auto'),             // 'auto' | 'manual'
  totalRounds: integer('total_rounds').notNull().default(5),
  currentRound: integer('current_round').notNull().default(0),
  status: text('status').notNull().default('lobby'),        // 'lobby' | 'playing' | 'round_active' | 'round_ended' | 'finished'
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

// ─── players ─────────────────────────────────────────────────────
export const players = sqliteTable('players', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  gameId: text('game_id').notNull().references(() => games.id),
  userId: integer('user_id').notNull(),                     // Telegram user ID
  username: text('username'),                               // @username do Telegram
  displayName: text('display_name').notNull(),              // Nome exibido
  photoFileId: text('photo_file_id'),                       // Telegram file_id da selfie
  photoPath: text('photo_path'),                            // Caminho local da foto
  totalScore: integer('total_score').notNull().default(0),
  isActive: integer('is_active').notNull().default(1),      // 0 se saiu do jogo
  joinedAt: text('joined_at').notNull().default(sql`(datetime('now'))`),
});

// ─── rounds ──────────────────────────────────────────────────────
export const rounds = sqliteTable('rounds', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  gameId: text('game_id').notNull().references(() => games.id),
  roundNumber: integer('round_number').notNull(),
  locationKey: text('location_key').notNull(),              // Chave do local no JSON
  locationName: text('location_name').notNull(),            // Nome do local
  spyHint: text('spy_hint').notNull(),                      // Dica do espião
  spyPlayerId: integer('spy_player_id').notNull().references(() => players.id),
  status: text('status').notNull().default('active'),       // 'active' | 'closed'
  spyGuess: text('spy_guess'),                              // Chute do espião para o local
  spyGuessApproved: integer('spy_guess_approved'),          // NULL=pendente, 1=aprovado, 0=rejeitado
  startedAt: text('started_at').notNull().default(sql`(datetime('now'))`),
  endedAt: text('ended_at'),
});

// ─── spy_guess_votes (Votação Fair Play) ─────────────────────────
export const spyGuessVotes = sqliteTable('spy_guess_votes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  roundId: integer('round_id').notNull().references(() => rounds.id),
  voterPlayerId: integer('voter_player_id').notNull().references(() => players.id),
  vote: integer('vote').notNull(),                          // 1 = válido, 0 = inválido
  votedAt: text('voted_at').notNull().default(sql`(datetime('now'))`),
});

// ─── round_roles ─────────────────────────────────────────────────
export const roundRoles = sqliteTable('round_roles', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  roundId: integer('round_id').notNull().references(() => rounds.id),
  playerId: integer('player_id').notNull().references(() => players.id),
  role: text('role').notNull(),                             // 'agent' | 'spy'
  characterName: text('character_name').notNull(),          // Ex: "Aluno da Grifinória" ou "Intruso"
  assignedGroup: integer('assigned_group'),                 // Número do grupo (1,2,3...) — NULL para espião
  groupType: text('group_type'),                            // 'duo' | 'trio' — NULL para espião
});

// ─── pairings ────────────────────────────────────────────────────
export const pairings = sqliteTable('pairings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  roundId: integer('round_id').notNull().references(() => rounds.id),
  requesterId: integer('requester_id').notNull().references(() => players.id),
  targetId: integer('target_id').notNull().references(() => players.id),
  status: text('status').notNull().default('pending'),      // 'pending' | 'accepted' | 'rejected' | 'dissolved'
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  resolvedAt: text('resolved_at'),
});

// ─── player_round_state ──────────────────────────────────────────
export const playerRoundState = sqliteTable('player_round_state', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  roundId: integer('round_id').notNull().references(() => rounds.id),
  playerId: integer('player_id').notNull().references(() => players.id),
  pairingStatus: text('pairing_status').notNull().default('unpaired'),  // 'unpaired' | 'pending_sent' | 'pending_received' | 'paired'
  pairedWith: text('paired_with'),                          // JSON array de player_ids
  verdictActive: integer('verdict_active').notNull().default(0),
  roundScore: integer('round_score').notNull().default(0),
});

// ─── manual_configs (Modo Manual) ────────────────────────────────
export const manualConfigs = sqliteTable('manual_configs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  roundId: integer('round_id').notNull().references(() => rounds.id),
  configuratorId: integer('configurator_id').notNull(),     // Telegram user ID do configurador
  locationName: text('location_name').notNull(),
  spyHint: text('spy_hint').notNull(),
  groupsCharactersJson: text('groups_characters_json').notNull(), // JSON com sub-arrays de personagens
});
