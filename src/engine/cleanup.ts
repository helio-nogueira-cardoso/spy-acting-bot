import { eq } from 'drizzle-orm';
import { db } from '../db/connection';
import { sqlite } from '../db/connection';
import {
  games,
  players,
  rounds,
  roundRoles,
  playerRoundState,
  pairings,
  spyGuessVotes,
  manualConfigs,
} from '../db/schema';
import { logger } from '../utils/logger';
import fs from 'fs';
import path from 'path';

const PHOTO_DIR = path.resolve(process.cwd(), 'data', 'photos');
const INACTIVITY_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 horas
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // verificar a cada 15 min

/**
 * Deleta todos os dados de um jogo finalizado: votes, configs, states,
 * roles, pairings, rounds, players, fotos em disco, e o jogo em si.
 */
export async function cleanupGameData(gameId: string): Promise<void> {
  try {
    // Buscar rounds do jogo para deletar dependências
    const gameRounds = await db.query.rounds.findMany({
      where: eq(rounds.gameId, gameId),
    });
    const roundIds = gameRounds.map(r => r.id);

    // Deletar na ordem certa (filhos antes de pais) por causa de FK
    for (const roundId of roundIds) {
      await db.delete(spyGuessVotes).where(eq(spyGuessVotes.roundId, roundId));
      await db.delete(manualConfigs).where(eq(manualConfigs.roundId, roundId));
      await db.delete(playerRoundState).where(eq(playerRoundState.roundId, roundId));
      await db.delete(pairings).where(eq(pairings.roundId, roundId));
      await db.delete(roundRoles).where(eq(roundRoles.roundId, roundId));
    }

    // Deletar rounds
    await db.delete(rounds).where(eq(rounds.gameId, gameId));

    // Deletar fotos do disco
    const gamePlayers = await db.query.players.findMany({
      where: eq(players.gameId, gameId),
    });
    for (const p of gamePlayers) {
      if (p.photoPath) {
        try { fs.unlinkSync(p.photoPath); } catch { /* arquivo pode não existir */ }
      }
      // Também tentar pelo padrão de nome
      const photoPath = path.join(PHOTO_DIR, `${gameId}_${p.userId}.jpg`);
      try { fs.unlinkSync(photoPath); } catch { /* ok */ }
    }

    // Deletar players
    await db.delete(players).where(eq(players.gameId, gameId));

    // Deletar jogo
    await db.delete(games).where(eq(games.id, gameId));

    logger.info(`Dados do jogo ${gameId} limpos com sucesso`);
  } catch (error) {
    logger.error(`Erro ao limpar dados do jogo ${gameId}: ${error}`);
  }
}

/**
 * Busca jogos inativos e os encerra + limpa.
 * Um jogo é considerado inativo se updatedAt > INACTIVITY_TIMEOUT_MS atrás.
 */
export async function cleanupStaleGames(api?: { sendMessage: (chatId: number, text: string, options?: any) => Promise<any> }): Promise<void> {
  try {
    // Formato compatível com datetime('now') do SQLite: 'YYYY-MM-DD HH:MM:SS'
    const cutoff = new Date(Date.now() - INACTIVITY_TIMEOUT_MS).toISOString().replace('T', ' ').slice(0, 19);

    // Buscar jogos não-finalizados com updatedAt antigo
    // SQLite: datetime strings são comparáveis lexicograficamente
    const staleGames = sqlite.prepare(`
      SELECT id, chat_id, status FROM games
      WHERE status != 'finished' AND updated_at < ?
    `).all(cutoff) as { id: string; chat_id: number; status: string }[];

    for (const game of staleGames) {
      logger.info(`Encerrando jogo inativo ${game.id} (status=${game.status}, chat=${game.chat_id})`);

      // Notificar grupo se possível
      if (api) {
        try {
          await api.sendMessage(game.chat_id,
            '⏰ *Jogo encerrado por inatividade.*\n\nNenhuma interação nas últimas 2 horas.',
            { parse_mode: 'Markdown' }
          );
        } catch { /* grupo pode não ser acessível */ }
      }

      await cleanupGameData(game.id);
    }

    if (staleGames.length > 0) {
      logger.info(`${staleGames.length} jogo(s) inativo(s) limpo(s)`);
    }
  } catch (error) {
    logger.error(`Erro no cleanup de jogos inativos: ${error}`);
  }
}

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Inicia o timer periódico de limpeza.
 */
export function startCleanupTimer(api?: { sendMessage: (chatId: number, text: string, options?: any) => Promise<any> }): void {
  if (cleanupTimer) return;

  // Limpeza inicial ao boot
  cleanupStaleGames(api);

  cleanupTimer = setInterval(() => {
    cleanupStaleGames(api);
  }, CLEANUP_INTERVAL_MS);

  logger.info(`Timer de cleanup iniciado (intervalo: ${CLEANUP_INTERVAL_MS / 1000}s, timeout: ${INACTIVITY_TIMEOUT_MS / 1000}s)`);
}

export function stopCleanupTimer(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}
