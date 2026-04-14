import { describe, it, expect } from 'vitest';
import { cleanupGameData, cleanupStaleGames } from '../../src/engine/cleanup';
import { createFullRoundScenario, createTestGame, createTestPlayer } from '../helpers/factories';
import { createMockApi } from '../helpers/mock-api';
import { db, sqlite } from '../../src/db/connection';
import { games, players, rounds, roundRoles, playerRoundState, pairings } from '../../src/db/schema';
import { eq, and } from 'drizzle-orm';

describe('cleanupGameData', () => {
  it('deleta todos os dados de um jogo', async () => {
    const { game, players: ps, round } = await createFullRoundScenario({ playerCount: 4 });

    // Verificar que existem dados
    const beforePlayers = await db.query.players.findMany({ where: eq(players.gameId, game.id) });
    expect(beforePlayers.length).toBeGreaterThan(0);

    const beforeRounds = await db.query.rounds.findMany({ where: eq(rounds.gameId, game.id) });
    expect(beforeRounds.length).toBeGreaterThan(0);

    await cleanupGameData(game.id);

    // Verificar que tudo foi deletado
    const afterGame = await db.query.games.findFirst({ where: eq(games.id, game.id) });
    expect(afterGame).toBeUndefined();

    const afterPlayers = await db.query.players.findMany({ where: eq(players.gameId, game.id) });
    expect(afterPlayers).toHaveLength(0);

    const afterRounds = await db.query.rounds.findMany({ where: eq(rounds.gameId, game.id) });
    expect(afterRounds).toHaveLength(0);

    const afterRoles = await db.query.roundRoles.findMany({ where: eq(roundRoles.roundId, round.id) });
    expect(afterRoles).toHaveLength(0);

    const afterStates = await db.query.playerRoundState.findMany({ where: eq(playerRoundState.roundId, round.id) });
    expect(afterStates).toHaveLength(0);
  });

  it('não afeta dados de outros jogos', async () => {
    const scenario1 = await createFullRoundScenario({ playerCount: 3 });
    const scenario2 = await createFullRoundScenario({ playerCount: 3 });

    await cleanupGameData(scenario1.game.id);

    // Jogo 2 permanece intacto
    const game2 = await db.query.games.findFirst({ where: eq(games.id, scenario2.game.id) });
    expect(game2).toBeDefined();

    const players2 = await db.query.players.findMany({ where: eq(players.gameId, scenario2.game.id) });
    expect(players2).toHaveLength(3);
  });
});

describe('cleanupStaleGames', () => {
  it('remove jogos com updatedAt antigo', async () => {
    // Formato SQLite: 'YYYY-MM-DD HH:MM:SS' (sem T e Z)
    const oldTime = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const game = await createTestGame({ status: 'lobby' });
    await createTestPlayer(game.id);

    // Forçar updatedAt antigo via SQL direto
    sqlite.prepare('UPDATE games SET updated_at = ? WHERE id = ?').run(oldTime, game.id);

    const api = createMockApi();
    await cleanupStaleGames(api);

    const afterGame = await db.query.games.findFirst({ where: eq(games.id, game.id) });
    expect(afterGame).toBeUndefined();
  });

  it('mantém jogos recentes', async () => {
    const game = await createTestGame({ status: 'round_active' });
    await createTestPlayer(game.id);
    // updatedAt padrão é now() — recente

    const api = createMockApi();
    await cleanupStaleGames(api);

    const afterGame = await db.query.games.findFirst({ where: eq(games.id, game.id) });
    expect(afterGame).toBeDefined();
  });

  it('ignora jogos já finalizados (já foram limpos ou não precisam)', async () => {
    const oldTime = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const game = await createTestGame({ status: 'finished' });
    sqlite.prepare('UPDATE games SET updated_at = ? WHERE id = ?').run(oldTime, game.id);

    const api = createMockApi();
    await cleanupStaleGames(api);

    // Jogo finished não é alvo do cleanup de stale (query filtra status != 'finished')
    // Ele permanece no DB (já está "finalizado")
    const afterGame = await db.query.games.findFirst({ where: eq(games.id, game.id) });
    // O cleanupStaleGames só atua em jogos com status != 'finished'
    expect(afterGame).toBeDefined();
  });

  it('envia notificação ao grupo antes de limpar', async () => {
    const oldTime = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const game = await createTestGame({ status: 'lobby', chatId: -7777 });
    sqlite.prepare('UPDATE games SET updated_at = ? WHERE id = ?').run(oldTime, game.id);

    const api = createMockApi();
    await cleanupStaleGames(api);

    expect(api.sendMessage).toHaveBeenCalledWith(
      -7777,
      expect.stringContaining('inatividade'),
      expect.any(Object),
    );
  });
});

describe('touchGameActivity mantém jogo vivo', () => {
  it('interação de pareamento atualiza updated_at e impede timeout', async () => {
    const { game, round, players: ps } = await createFullRoundScenario({ playerCount: 5 });

    // Forçar updated_at para 3h atrás (formato SQLite)
    const oldTime = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    sqlite.prepare('UPDATE games SET updated_at = ? WHERE id = ?').run(oldTime, game.id);

    // Verificar que o jogo SERIA limpo neste estado
    const beforeGame = sqlite.prepare('SELECT updated_at FROM games WHERE id = ?').get(game.id) as any;
    expect(beforeGame.updated_at).toBe(oldTime);

    // Fazer uma interação de pareamento — deve atualizar updated_at
    const { createPairingRequest } = await import('../../src/engine/pairing');
    await createPairingRequest(round.id, ps[1].id, ps[2].id);

    // Agora updated_at deve ter sido atualizado para "agora"
    const afterGame = sqlite.prepare('SELECT updated_at FROM games WHERE id = ?').get(game.id) as any;
    expect(afterGame.updated_at).not.toBe(oldTime);

    // cleanupStaleGames NÃO deve limpar o jogo (updated_at é recente)
    const api = createMockApi();
    await cleanupStaleGames(api);

    const gameStillExists = await db.query.games.findFirst({ where: eq(games.id, game.id) });
    expect(gameStillExists).toBeDefined();
  });

  it('veredito de agente atualiza updated_at', async () => {
    const { game, round, players: ps, spyPlayer } = await createFullRoundScenario({ playerCount: 4 });

    // Forçar updated_at antigo
    const oldTime = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    sqlite.prepare('UPDATE games SET updated_at = ? WHERE id = ?').run(oldTime, game.id);

    // Parear agentes e dar veredito via submitSpyGuess (que faz touch)
    const { submitSpyGuess } = await import('../../src/engine/verdict');
    await submitSpyGuess(round.id, spyPlayer.id, 'Hospital');

    const afterGame = sqlite.prepare('SELECT updated_at FROM games WHERE id = ?').get(game.id) as any;
    expect(afterGame.updated_at).not.toBe(oldTime);
  });

  it('joinGame atualiza updated_at', async () => {
    const game = await createTestGame({ status: 'lobby' });

    const oldTime = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    sqlite.prepare('UPDATE games SET updated_at = ? WHERE id = ?').run(oldTime, game.id);

    const { joinGame } = await import('../../src/engine/lobby');
    await joinGame(game.id, 55555, 'test', 'TestPlayer');

    const afterGame = sqlite.prepare('SELECT updated_at FROM games WHERE id = ?').get(game.id) as any;
    expect(afterGame.updated_at).not.toBe(oldTime);
  });

  it('formato de updated_at é SQLite-compatível (sem T e Z)', async () => {
    const game = await createTestGame({ status: 'lobby' });
    const { joinGame } = await import('../../src/engine/lobby');
    await joinGame(game.id, 55556, 'test2', 'TestPlayer2');

    const row = sqlite.prepare('SELECT updated_at FROM games WHERE id = ?').get(game.id) as any;
    // Formato deve ser YYYY-MM-DD HH:MM:SS (sem T, sem Z, sem milissegundos)
    expect(row.updated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});
