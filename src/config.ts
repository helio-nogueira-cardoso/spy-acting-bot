import dotenv from 'dotenv';

dotenv.config();

export const config = {
  botToken: process.env.BOT_TOKEN || '',
  minPlayers: 3,
  maxPlayers: 12,
  defaultRounds: 5,
  minRounds: 3,
  maxRounds: 10,
  verdictTimeoutMs: 60_000, // 60s para votação fair play
  nextRoundDelayMs: 15_000, // 15s entre rodadas
} as const;

if (!config.botToken) {
  throw new Error('BOT_TOKEN não definido! Verifique o arquivo .env');
}
