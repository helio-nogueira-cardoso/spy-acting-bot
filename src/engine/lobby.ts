import { nanoid } from 'nanoid';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/connection';
import { games, players } from '../db/schema';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getAnyActiveGameForChat, getPlayerInGame, getPlayersInGame } from '../utils/validators';

/** Timestamp no formato SQLite (YYYY-MM-DD HH:MM:SS) — compatível com datetime('now') */
export function sqliteNow(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

/** Atualiza updated_at do jogo para registrar atividade (evita timeout por inatividade) */
export async function touchGameActivity(gameId: string): Promise<void> {
  await db.update(games)
    .set({ updatedAt: sqliteNow() })
    .where(eq(games.id, gameId));
}

export async function createGame(chatId: number, creatorId: number): Promise<{ success: boolean; gameId?: string; error?: string }> {
  try {
    // Verificar se já existe jogo ativo no grupo
    const existing = await getAnyActiveGameForChat(chatId);
    if (existing) {
      return { success: false, error: 'Já existe um jogo ativo neste grupo! Use /endgame para encerrar.' };
    }

    const gameId = `game_${nanoid(8)}`;
    await db.insert(games).values({
      id: gameId,
      chatId,
      creatorId,
      mode: 'auto',
      totalRounds: config.defaultRounds,
      currentRound: 0,
      status: 'lobby',
    });

    logger.info(`Jogo criado: ${gameId} no chat ${chatId} por ${creatorId}`);
    return { success: true, gameId };
  } catch (error) {
    logger.error(`Erro ao criar jogo: ${error}`);
    return { success: false, error: 'Erro interno ao criar sala.' };
  }
}

export async function joinGame(
  gameId: string,
  userId: number,
  username: string | undefined,
  displayName: string
): Promise<{ success: boolean; error?: string }> {
  try {
    // Verificar se já está no jogo
    const existing = await getPlayerInGame(gameId, userId);
    if (existing) {
      return { success: false, error: 'Você já está neste jogo!' };
    }

    // Verificar limite de jogadores
    const currentPlayers = await getPlayersInGame(gameId);
    if (currentPlayers.length >= config.maxPlayers) {
      return { success: false, error: `Sala cheia! Máximo de ${config.maxPlayers} jogadores.` };
    }

    await db.insert(players).values({
      gameId,
      userId,
      username: username ?? null,
      displayName,
      totalScore: 0,
      isActive: 1,
    });

    await touchGameActivity(gameId);
    logger.info(`Jogador ${userId} (${displayName}) entrou no jogo ${gameId}`);
    return { success: true };
  } catch (error) {
    logger.error(`Erro ao entrar no jogo: ${error}`);
    return { success: false, error: 'Erro interno ao entrar na sala.' };
  }
}

export async function leaveGame(
  gameId: string,
  userId: number
): Promise<{ success: boolean; newCreatorUserId?: number; newCreatorName?: string; gameEnded?: boolean; error?: string }> {
  try {
    const player = await getPlayerInGame(gameId, userId);
    if (!player) {
      return { success: false, error: 'Você não está neste jogo.' };
    }

    await db.update(players)
      .set({ isActive: 0 })
      .where(and(eq(players.gameId, gameId), eq(players.userId, userId)));

    logger.info(`Jogador ${userId} saiu do jogo ${gameId}`);

    const game = await db.query.games.findFirst({ where: eq(games.id, gameId) });
    if (!game) return { success: true };

    const remaining = await getPlayersInGame(gameId);

    // Ninguém sobrou — encerrar e limpar
    if (remaining.length === 0) {
      const { cleanupGameData } = await import('./cleanup');
      await cleanupGameData(gameId);
      logger.info(`Jogo ${gameId} encerrado e limpo: último jogador saiu`);
      return { success: true, gameEnded: true };
    }

    // Se quem saiu era o criador, transferir para o próximo jogador ativo
    if (game.creatorId === userId) {
      const newCreator = remaining[0];
      await db.update(games)
        .set({ creatorId: newCreator.userId, updatedAt: sqliteNow() })
        .where(eq(games.id, gameId));
      logger.info(`Criador do jogo ${gameId} transferido de ${userId} para ${newCreator.userId} (${newCreator.displayName})`);
      return { success: true, newCreatorUserId: newCreator.userId, newCreatorName: newCreator.displayName };
    }

    return { success: true };
  } catch (error) {
    logger.error(`Erro ao sair do jogo: ${error}`);
    return { success: false, error: 'Erro interno ao sair da sala.' };
  }
}

export async function updateGameConfig(
  gameId: string,
  updates: { totalRounds?: number; mode?: string }
): Promise<void> {
  await db.update(games)
    .set({ ...updates, updatedAt: sqliteNow() })
    .where(eq(games.id, gameId));
}

export async function updateGameStatus(
  gameId: string,
  status: string
): Promise<void> {
  await db.update(games)
    .set({ status, updatedAt: sqliteNow() })
    .where(eq(games.id, gameId));
}

export async function updatePlayerPhoto(
  gameId: string,
  userId: number,
  photoFileId: string,
  photoPath: string
): Promise<void> {
  await db.update(players)
    .set({ photoFileId, photoPath })
    .where(and(eq(players.gameId, gameId), eq(players.userId, userId)));
}

export async function validateGameStart(gameId: string): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];

  const game = await db.query.games.findFirst({ where: eq(games.id, gameId) });
  if (!game) {
    return { valid: false, errors: ['Jogo não encontrado.'] };
  }

  if (game.status !== 'lobby') {
    return { valid: false, errors: ['O jogo já foi iniciado.'] };
  }

  const activePlayers = await getPlayersInGame(gameId);

  if (activePlayers.length < config.minPlayers) {
    errors.push(`Mínimo de ${config.minPlayers} jogadores necessário. Atual: ${activePlayers.length}.`);
  }

  const withoutPhoto = activePlayers.filter(p => !p.photoFileId);
  if (withoutPhoto.length > 0) {
    const names = withoutPhoto.map(p => p.displayName).join(', ');
    errors.push(`Jogadores sem selfie: ${names}. Todos devem enviar uma selfie no DM!`);
  }

  return { valid: errors.length === 0, errors };
}
