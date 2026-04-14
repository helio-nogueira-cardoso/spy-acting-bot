/**
 * Testes de regressão para lacunas identificadas na auditoria.
 *
 * Bug #1: Consistência entre queries após leave/rejoin
 * Bug #3: Edge case 3 jogadores (mínimo)
 * Obs #1: Spy pareia com agente de trio
 * Obs A:  Criador nunca entrou como jogador, todos saem
 */
import { describe, it, expect } from 'vitest';
import { joinGame, leaveGame } from '../../src/engine/lobby';
import { getPlayersInGame, getPlayerInGame, getPlayerActiveGame, getAnyActiveGameForChat } from '../../src/utils/validators';
import {
  canRequestPairing,
  createPairingRequest,
  acceptPairing,
  isGroupComplete,
  getExpectedGroupSize,
  getAvailablePlayers,
} from '../../src/engine/pairing';
import { checkRoundClose } from '../../src/engine/verdict';
import {
  createTestGame,
  createTestPlayer,
  createFullRoundScenario,
  createTestRoundRole,
  createTestPlayerRoundState,
  createTestRound,
} from '../helpers/factories';
import { createMockApi } from '../helpers/mock-api';
import { db } from '../../src/db/connection';
import { playerRoundState, rounds } from '../../src/db/schema';
import { eq, and } from 'drizzle-orm';

// ═══════════════════════════════════════════════════════════════
// Bug #1 — Consistência entre queries após leave e rejoin
// ═══════════════════════════════════════════════════════════════
describe('Bug #1: consistência de estado após leave e rejoin', () => {
  it('após leave, TODAS as queries concordam que o jogador não está no jogo', async () => {
    const game = await createTestGame({ chatId: -9000, status: 'lobby' });
    await joinGame(game.id, 7001, 'ana', 'Ana');
    await createTestPlayer(game.id, { userId: 7002 }); // manter alguém no jogo

    // Leave
    await leaveGame(game.id, 7001);

    // Cross-verify: TODAS as queries devem excluir o jogador
    const playersInGame = await getPlayersInGame(game.id);
    expect(playersInGame.map(p => p.userId)).not.toContain(7001);

    const playerInGame = await getPlayerInGame(game.id, 7001);
    expect(playerInGame).toBeFalsy();

    const activeGame = await getPlayerActiveGame(7001);
    expect(activeGame).toBeNull();
  });

  it('após leave + rejoin, TODAS as queries concordam que o jogador ESTÁ no jogo', async () => {
    const game = await createTestGame({ chatId: -9001, status: 'lobby' });
    await joinGame(game.id, 7010, 'bob', 'Bob');
    await createTestPlayer(game.id, { userId: 7011 }); // manter alguém

    // Leave e rejoin
    await leaveGame(game.id, 7010);
    await joinGame(game.id, 7010, 'bob', 'Bob');

    // Cross-verify: TODAS as queries devem incluir o jogador
    const playersInGame = await getPlayersInGame(game.id);
    expect(playersInGame.map(p => p.userId)).toContain(7010);

    const playerInGame = await getPlayerInGame(game.id, 7010);
    expect(playerInGame).toBeTruthy();
    expect(playerInGame!.userId).toBe(7010);

    const activeGame = await getPlayerActiveGame(7010);
    expect(activeGame).not.toBeNull();
    expect(activeGame!.id).toBe(game.id);
  });
});

// ═══════════════════════════════════════════════════════════════
// Bug #3 — Edge case: 3 jogadores (mínimo do jogo)
// ═══════════════════════════════════════════════════════════════
describe('Bug #3: rodada fecha com 3 jogadores (mínimo)', () => {
  it('3 jogadores: 1 spy isolado + 1 dupla com veredito → rodada fecha', async () => {
    // 3 jogadores = 1 spy + 2 agentes (1 dupla). Spy fica isolado.
    const { round, players, spyPlayer, game } = await createFullRoundScenario({
      playerCount: 3,
      spyIndex: 0,
    });

    const agents = players.filter(p => p.id !== spyPlayer.id);
    expect(agents).toHaveLength(2);

    // Parear os 2 agentes como dupla e dar veredito
    const pairedWith = JSON.stringify(agents.map(a => a.id));
    for (const agent of agents) {
      await db.update(playerRoundState)
        .set({ pairingStatus: 'paired', pairedWith, verdictActive: 1 })
        .where(and(eq(playerRoundState.roundId, round.id), eq(playerRoundState.playerId, agent.id)));
    }

    // Spy continua unpaired
    const api = createMockApi();
    await checkRoundClose(round.id, api);

    const updatedRound = await db.query.rounds.findFirst({ where: eq(rounds.id, round.id) });
    expect(updatedRound!.status).toBe('closed');
  });

  it('5 jogadores: spy isolado + 2 duplas com veredito → rodada fecha', async () => {
    const { round, players, spyPlayer } = await createFullRoundScenario({
      playerCount: 5,
      spyIndex: 0,
    });

    const agents = players.filter(p => p.id !== spyPlayer.id);
    expect(agents).toHaveLength(4); // 2 duplas

    // Parear dupla 1
    const pair1 = JSON.stringify([agents[0].id, agents[1].id]);
    for (const a of [agents[0], agents[1]]) {
      await db.update(playerRoundState)
        .set({ pairingStatus: 'paired', pairedWith: pair1, verdictActive: 1 })
        .where(and(eq(playerRoundState.roundId, round.id), eq(playerRoundState.playerId, a.id)));
    }

    // Parear dupla 2
    const pair2 = JSON.stringify([agents[2].id, agents[3].id]);
    for (const a of [agents[2], agents[3]]) {
      await db.update(playerRoundState)
        .set({ pairingStatus: 'paired', pairedWith: pair2, verdictActive: 1 })
        .where(and(eq(playerRoundState.roundId, round.id), eq(playerRoundState.playerId, a.id)));
    }

    const api = createMockApi();
    await checkRoundClose(round.id, api);

    const updatedRound = await db.query.rounds.findFirst({ where: eq(rounds.id, round.id) });
    expect(updatedRound!.status).toBe('closed');
  });
});

// ═══════════════════════════════════════════════════════════════
// Obs #1 — Spy pode parear com agente de trio
// ═══════════════════════════════════════════════════════════════
describe('Obs #1: spy pareia com agente de trio', () => {
  it('spy + agente-trio → grupo esperado = 3 → grupo incompleto com 2', async () => {
    // 4 jogadores: spy + 3 agentes formando 1 trio
    const { round, players, spyPlayer } = await createFullRoundScenario({
      playerCount: 4,
      spyIndex: 0,
    });

    const agents = players.filter(p => p.id !== spyPlayer.id);
    // Todos os agentes devem ter groupType = 'trio' (3 agentes = 1 trio)
    const trioAgent = agents[0];

    // Spy tenta parear com agente do trio
    const canPair = await canRequestPairing(round.id, spyPlayer.id, trioAgent.id);
    expect(canPair.allowed).toBe(true);

    // Criar pareamento
    const pairingId = await createPairingRequest(round.id, spyPlayer.id, trioAgent.id);
    const result = await acceptPairing(pairingId);
    expect(result.success).toBe(true);

    // Grupo de [spy, trioAgent] → esperado 3 (do agente-trio) → incompleto!
    const expectedSize = await getExpectedGroupSize([spyPlayer.id, trioAgent.id], round.id);
    expect(expectedSize).toBe(3);

    const complete = await isGroupComplete([spyPlayer.id, trioAgent.id], round.id);
    expect(complete).toBe(false); // Precisa de mais 1 membro
  });

  it('spy + 2 agentes-trio → grupo completo com 3', async () => {
    const { round, players, spyPlayer } = await createFullRoundScenario({
      playerCount: 4,
      spyIndex: 0,
    });

    const agents = players.filter(p => p.id !== spyPlayer.id);

    // Spy + agent[0] formam par
    const p1 = await createPairingRequest(round.id, spyPlayer.id, agents[0].id);
    await acceptPairing(p1);

    // Grupo incompleto — spy pode ver jogadores disponíveis para adicionar
    const available = await getAvailablePlayers(round.id, spyPlayer.id);
    const availIds = available.map(a => a.playerId);
    expect(availIds).toContain(agents[1].id);
    expect(availIds).toContain(agents[2].id);

    // Spy adiciona segundo agente ao grupo → trio completo
    const { addToGroup } = await import('../../src/engine/pairing');
    const addResult = await addToGroup(round.id, [spyPlayer.id, agents[0].id], agents[1].id);
    expect(addResult.success).toBe(true);

    // Agora grupo tem 3 membros → completo
    const complete = await isGroupComplete([spyPlayer.id, agents[0].id, agents[1].id], round.id);
    expect(complete).toBe(true);
  });

  it('spy aparece como disponível para agentes de trio', async () => {
    const { round, players, spyPlayer } = await createFullRoundScenario({
      playerCount: 4,
      spyIndex: 0,
    });

    const trioAgent = players.find(p => p.id !== spyPlayer.id)!;
    const available = await getAvailablePlayers(round.id, trioAgent.id);
    const availIds = available.map(a => a.playerId);
    expect(availIds).toContain(spyPlayer.id);
  });
});

// ═══════════════════════════════════════════════════════════════
// Obs A — Criador nunca entrou como jogador, todos saem
// ═══════════════════════════════════════════════════════════════
describe('Obs A: criador nunca entrou como jogador, todos saem', () => {
  it('criador cria sala sem /join, jogadores entram e saem → jogo é limpo', async () => {
    // Criador (userId 8000) cria jogo mas NÃO entra como player
    const game = await createTestGame({ chatId: -9500, creatorId: 8000, status: 'lobby' });

    // Dois jogadores entram
    await createTestPlayer(game.id, { userId: 8001, displayName: 'Player1' });
    await createTestPlayer(game.id, { userId: 8002, displayName: 'Player2' });

    // Player1 sai (não é criador, não é o último)
    const r1 = await leaveGame(game.id, 8001);
    expect(r1.success).toBe(true);
    expect(r1.gameEnded).toBeFalsy();

    // Player2 sai (último jogador, mas NÃO é o criador)
    const r2 = await leaveGame(game.id, 8002);
    expect(r2.success).toBe(true);
    expect(r2.gameEnded).toBe(true); // Deve encerrar pois 0 jogadores restam

    // Jogo deve ter sido completamente removido
    const afterGame = await getAnyActiveGameForChat(-9500);
    expect(afterGame).toBeNull();
  });

  it('criador nunca entrou, 3 jogadores saem um por um → criador transfere entre jogadores e limpa no final', async () => {
    const game = await createTestGame({ chatId: -9600, creatorId: 8100, status: 'lobby' });
    await createTestPlayer(game.id, { userId: 8101, displayName: 'A' });
    await createTestPlayer(game.id, { userId: 8102, displayName: 'B' });
    await createTestPlayer(game.id, { userId: 8103, displayName: 'C' });

    // A sai (não-criador)
    const r1 = await leaveGame(game.id, 8101);
    expect(r1.gameEnded).toBeFalsy();

    // B sai (não-criador)
    const r2 = await leaveGame(game.id, 8102);
    expect(r2.gameEnded).toBeFalsy();

    // C sai (último, não-criador) → game deve ser limpo
    const r3 = await leaveGame(game.id, 8103);
    expect(r3.gameEnded).toBe(true);
  });
});
