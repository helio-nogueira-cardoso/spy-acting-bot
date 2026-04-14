import { eq, and } from 'drizzle-orm';
import { db } from '../db/connection';
import { games, players } from '../db/schema';
import type { GameStatus } from '../types';

export async function getActiveGame(chatId: number) {
  const result = await db.query.games.findFirst({
    where: and(
      eq(games.chatId, chatId),
      eq(games.status, 'lobby')
    ),
  });
  return result ?? null;
}

export async function getGameById(gameId: string) {
  return db.query.games.findFirst({
    where: eq(games.id, gameId),
  }) ?? null;
}

export async function getPlayersInGame(gameId: string) {
  return db.query.players.findMany({
    where: and(
      eq(players.gameId, gameId),
      eq(players.isActive, 1)
    ),
  });
}

export async function getPlayerInGame(gameId: string, userId: number) {
  return db.query.players.findFirst({
    where: and(
      eq(players.gameId, gameId),
      eq(players.userId, userId),
      eq(players.isActive, 1)
    ),
  }) ?? null;
}

export async function getAnyActiveGameForChat(chatId: number) {
  const activeStatuses: GameStatus[] = ['lobby', 'playing', 'round_active', 'round_ended'];
  for (const status of activeStatuses) {
    const game = await db.query.games.findFirst({
      where: and(
        eq(games.chatId, chatId),
        eq(games.status, status)
      ),
    });
    if (game) return game;
  }
  return null;
}

export async function getPlayerActiveGame(userId: number) {
  const activeStatuses: GameStatus[] = ['lobby', 'playing', 'round_active', 'round_ended'];

  const playerRecords = await db.query.players.findMany({
    where: and(
      eq(players.userId, userId),
      eq(players.isActive, 1)
    ),
  });

  for (const player of playerRecords) {
    const game = await db.query.games.findFirst({
      where: eq(games.id, player.gameId),
    });
    if (game && activeStatuses.includes(game.status as GameStatus)) {
      return game;
    }
  }
  return null;
}
