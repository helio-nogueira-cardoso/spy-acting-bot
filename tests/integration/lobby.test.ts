import { describe, it, expect } from 'vitest';
import { createGame, joinGame, leaveGame, validateGameStart, updatePlayerPhoto, updateGameConfig } from '../../src/engine/lobby';
import { createTestGame, createTestPlayer } from '../helpers/factories';

describe('createGame', () => {
  it('cria jogo com sucesso', async () => {
    const result = await createGame(-1001, 111);
    expect(result.success).toBe(true);
    expect(result.gameId).toBeDefined();
    expect(result.gameId).toMatch(/^game_/);
  });

  it('recusa jogo duplicado no mesmo chat', async () => {
    await createTestGame({ chatId: -2000 });
    const result = await createGame(-2000, 222);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Já existe');
  });

  it('permite jogo em chat diferente', async () => {
    await createTestGame({ chatId: -3000 });
    const result = await createGame(-3001, 333);
    expect(result.success).toBe(true);
  });
});

describe('joinGame', () => {
  it('jogador entra com sucesso', async () => {
    const game = await createTestGame();
    const result = await joinGame(game.id, 500, 'carlos', 'Carlos');
    expect(result.success).toBe(true);
  });

  it('rejeita jogador duplicado', async () => {
    const game = await createTestGame();
    await joinGame(game.id, 500, 'carlos', 'Carlos');
    const result = await joinGame(game.id, 500, 'carlos', 'Carlos');
    expect(result.success).toBe(false);
    expect(result.error).toContain('já está');
  });

  it('rejeita sala cheia (12 jogadores)', async () => {
    const game = await createTestGame();
    for (let i = 0; i < 12; i++) {
      await createTestPlayer(game.id, { userId: 600 + i });
    }
    const result = await joinGame(game.id, 700, 'extra', 'Extra');
    expect(result.success).toBe(false);
    expect(result.error).toContain('cheia');
  });
});

describe('leaveGame', () => {
  it('jogador sai com sucesso', async () => {
    const game = await createTestGame();
    await createTestPlayer(game.id, { userId: 800 });
    await createTestPlayer(game.id, { userId: 801 });
    const result = await leaveGame(game.id, 800);
    expect(result.success).toBe(true);
  });

  it('rejeita se jogador não está no jogo', async () => {
    const game = await createTestGame();
    const result = await leaveGame(game.id, 999);
    expect(result.success).toBe(false);
  });

  it('transfere criador ao sair', async () => {
    const game = await createTestGame({ creatorId: 900 });
    await createTestPlayer(game.id, { userId: 900, displayName: 'Criador' });
    await createTestPlayer(game.id, { userId: 901, displayName: 'Substituto' });
    const result = await leaveGame(game.id, 900);
    expect(result.success).toBe(true);
    expect(result.newCreatorUserId).toBe(901);
    expect(result.newCreatorName).toBe('Substituto');
  });

  it('encerra jogo quando último jogador sai', async () => {
    const game = await createTestGame({ creatorId: 950 });
    await createTestPlayer(game.id, { userId: 950 });
    const result = await leaveGame(game.id, 950);
    expect(result.success).toBe(true);
    expect(result.gameEnded).toBe(true);
  });

  it('encerra jogo quando não-criador é último a sair', async () => {
    const game = await createTestGame({ creatorId: 9999 }); // criador nunca entrou como jogador
    await createTestPlayer(game.id, { userId: 960 });
    const result = await leaveGame(game.id, 960);
    expect(result.success).toBe(true);
    expect(result.gameEnded).toBe(true);
  });

  it('jogador que saiu pode reentrar', async () => {
    const game = await createTestGame();
    await joinGame(game.id, 970, 'user970', 'Player970');
    await createTestPlayer(game.id, { userId: 971 }); // manter alguém no jogo
    await leaveGame(game.id, 970);
    const result = await joinGame(game.id, 970, 'user970', 'Player970');
    expect(result.success).toBe(true);
  });
});

describe('validateGameStart', () => {
  it('rejeita com menos de 3 jogadores', async () => {
    const game = await createTestGame();
    await createTestPlayer(game.id, { photoFileId: 'photo1' });
    await createTestPlayer(game.id, { photoFileId: 'photo2' });
    const result = await validateGameStart(game.id);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Mínimo');
  });

  it('rejeita jogadores sem selfie', async () => {
    const game = await createTestGame();
    await createTestPlayer(game.id, { photoFileId: 'photo1' });
    await createTestPlayer(game.id, { photoFileId: null, displayName: 'SemFoto' });
    await createTestPlayer(game.id, { photoFileId: 'photo3' });
    const result = await validateGameStart(game.id);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('SemFoto'))).toBe(true);
  });

  it('valida com 3+ jogadores com selfie', async () => {
    const game = await createTestGame();
    for (let i = 0; i < 3; i++) {
      await createTestPlayer(game.id, { photoFileId: `photo_${i}` });
    }
    const result = await validateGameStart(game.id);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejeita se jogo já iniciou', async () => {
    const game = await createTestGame({ status: 'round_active' });
    const result = await validateGameStart(game.id);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('já foi iniciado');
  });
});

describe('updateGameConfig', () => {
  it('atualiza rodadas', async () => {
    const game = await createTestGame({ totalRounds: 5 });
    await updateGameConfig(game.id, { totalRounds: 7 });
    // Verificar via import direto
    const { db } = await import('../../src/db/connection');
    const { games } = await import('../../src/db/schema');
    const { eq } = await import('drizzle-orm');
    const updated = await db.query.games.findFirst({ where: eq(games.id, game.id) });
    expect(updated!.totalRounds).toBe(7);
  });
});

describe('updatePlayerPhoto', () => {
  it('salva fileId e path da foto', async () => {
    const game = await createTestGame();
    const player = await createTestPlayer(game.id, { userId: 1100 });
    await updatePlayerPhoto(game.id, 1100, 'file_abc', '/photos/test.jpg');

    const { db } = await import('../../src/db/connection');
    const { players } = await import('../../src/db/schema');
    const { eq } = await import('drizzle-orm');
    const updated = await db.query.players.findFirst({ where: eq(players.id, player.id) });
    expect(updated!.photoFileId).toBe('file_abc');
    expect(updated!.photoPath).toBe('/photos/test.jpg');
  });
});
