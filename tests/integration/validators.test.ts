import { describe, it, expect } from 'vitest';
import {
  getActiveGame,
  getGameById,
  getPlayersInGame,
  getPlayerInGame,
  getAnyActiveGameForChat,
  getPlayerActiveGame,
} from '../../src/utils/validators';
import { createTestGame, createTestPlayer } from '../helpers/factories';
import { db } from '../../src/db/connection';
import { games } from '../../src/db/schema';
import { eq } from 'drizzle-orm';

describe('getActiveGame', () => {
  it('retorna jogo em lobby', async () => {
    await createTestGame({ chatId: -5000, status: 'lobby' });
    const game = await getActiveGame(-5000);
    expect(game).not.toBeNull();
    expect(game!.status).toBe('lobby');
  });

  it('retorna null se não há lobby', async () => {
    await createTestGame({ chatId: -5001, status: 'round_active' });
    const game = await getActiveGame(-5001);
    expect(game).toBeNull();
  });
});

describe('getGameById', () => {
  it('retorna jogo existente', async () => {
    const created = await createTestGame({ id: 'game_findme' });
    const game = await getGameById('game_findme');
    expect(game).not.toBeNull();
    expect(game!.id).toBe('game_findme');
  });

  it('retorna falsy para ID inexistente', async () => {
    const game = await getGameById('game_nope');
    expect(game).toBeFalsy();
  });
});

describe('getPlayersInGame', () => {
  it('retorna apenas jogadores ativos', async () => {
    const game = await createTestGame();
    await createTestPlayer(game.id, { userId: 2001, isActive: 1 });
    await createTestPlayer(game.id, { userId: 2002, isActive: 0 }); // saiu
    await createTestPlayer(game.id, { userId: 2003, isActive: 1 });

    const players = await getPlayersInGame(game.id);
    expect(players).toHaveLength(2);
    expect(players.map(p => p.userId)).toContain(2001);
    expect(players.map(p => p.userId)).toContain(2003);
    expect(players.map(p => p.userId)).not.toContain(2002);
  });
});

describe('getPlayerInGame (Bug #1 regression)', () => {
  it('encontra jogador ativo', async () => {
    const game = await createTestGame();
    await createTestPlayer(game.id, { userId: 3001, isActive: 1 });
    const player = await getPlayerInGame(game.id, 3001);
    expect(player).not.toBeNull();
  });

  it('NÃO encontra jogador inativo (que saiu)', async () => {
    const game = await createTestGame();
    await createTestPlayer(game.id, { userId: 3002, isActive: 0 });
    const player = await getPlayerInGame(game.id, 3002);
    expect(player).toBeFalsy();
  });

  it('retorna falsy para userId inexistente', async () => {
    const game = await createTestGame();
    const player = await getPlayerInGame(game.id, 99999);
    expect(player).toBeFalsy();
  });
});

describe('getAnyActiveGameForChat', () => {
  it('encontra jogo em lobby', async () => {
    await createTestGame({ chatId: -6000, status: 'lobby' });
    const game = await getAnyActiveGameForChat(-6000);
    expect(game).not.toBeNull();
  });

  it('encontra jogo em round_active', async () => {
    await createTestGame({ chatId: -6001, status: 'round_active' });
    const game = await getAnyActiveGameForChat(-6001);
    expect(game).not.toBeNull();
  });

  it('encontra jogo em round_ended', async () => {
    await createTestGame({ chatId: -6002, status: 'round_ended' });
    const game = await getAnyActiveGameForChat(-6002);
    expect(game).not.toBeNull();
  });

  it('ignora jogo finished', async () => {
    await createTestGame({ chatId: -6003, status: 'finished' });
    const game = await getAnyActiveGameForChat(-6003);
    expect(game).toBeNull();
  });
});

describe('getPlayerActiveGame (Bug #2 regression)', () => {
  it('retorna jogo ativo do jogador', async () => {
    const game = await createTestGame({ status: 'lobby' });
    await createTestPlayer(game.id, { userId: 4001 });
    const result = await getPlayerActiveGame(4001);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(game.id);
  });

  it('ignora jogo finished', async () => {
    const game = await createTestGame({ status: 'finished' });
    await createTestPlayer(game.id, { userId: 4002 });
    const result = await getPlayerActiveGame(4002);
    expect(result).toBeNull();
  });

  it('com múltiplos jogos, retorna o ativo e não o finalizado', async () => {
    const oldGame = await createTestGame({ status: 'finished' });
    await createTestPlayer(oldGame.id, { userId: 4003 });

    const newGame = await createTestGame({ status: 'lobby' });
    await createTestPlayer(newGame.id, { userId: 4003 });

    const result = await getPlayerActiveGame(4003);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(newGame.id);
    expect(result!.status).toBe('lobby');
  });

  it('com múltiplos jogos finalizados, retorna null', async () => {
    const game1 = await createTestGame({ status: 'finished' });
    await createTestPlayer(game1.id, { userId: 4004 });
    const game2 = await createTestGame({ status: 'finished' });
    await createTestPlayer(game2.id, { userId: 4004 });

    const result = await getPlayerActiveGame(4004);
    expect(result).toBeNull();
  });

  it('retorna jogo em round_active', async () => {
    const game = await createTestGame({ status: 'round_active' });
    await createTestPlayer(game.id, { userId: 4005 });
    const result = await getPlayerActiveGame(4005);
    expect(result).not.toBeNull();
    expect(result!.status).toBe('round_active');
  });
});
