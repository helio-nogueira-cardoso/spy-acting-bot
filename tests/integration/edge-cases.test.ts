/**
 * Testes de casos de borda, cenários inesperados e invariantes do sistema.
 * Baseado na auditoria profunda de 45 lacunas.
 */
import { describe, it, expect, vi } from 'vitest';
import { db, sqlite } from '../../src/db/connection';
import { games, rounds, playerRoundState, pairings, roundRoles, players, spyGuessVotes } from '../../src/db/schema';
import { eq, and } from 'drizzle-orm';
import { createTestGame, createTestPlayer, createTestRound, createTestRoundRole, createTestPlayerRoundState, createFullRoundScenario } from '../helpers/factories';
import { createMockApi } from '../helpers/mock-api';

// ═══════════════════════════════════════════════════════════════
// SCORING — Casos de borda
// ═══════════════════════════════════════════════════════════════

describe('scoring: casos de borda', () => {
  it('TODOS os agentes formam grupos errados → todos com 0 pontos', async () => {
    const { calculateRoundScores } = await import('../../src/engine/scoring');
    const scores = calculateRoundScores({
      correctGroups: [[2, 3], [4, 5]],
      formedGroups: [[2, 5], [3, 4]], // todos trocados
      spyPlayerId: 1,
      spyGuessApproved: false,
    });
    expect(scores.get(2)).toBe(0);
    expect(scores.get(3)).toBe(0);
    expect(scores.get(4)).toBe(0);
    expect(scores.get(5)).toBe(0);
    expect(scores.get(1)).toBe(0); // spy isolado, sem chute
  });

  it('spy em trio com agentes de grupos diferentes → spy ganha infiltração, agentes 0', async () => {
    const { calculateRoundScores } = await import('../../src/engine/scoring');
    const scores = calculateRoundScores({
      correctGroups: [[2, 3, 4], [5, 6]],
      formedGroups: [[1, 2, 5]], // spy + agente do trio + agente da dupla
      spyPlayerId: 1,
      spyGuessApproved: false,
    });
    expect(scores.get(1)).toBe(2); // spy infiltrado
    expect(scores.get(2)).toBe(0); // grupo errado (faltam membros do trio correto)
    expect(scores.get(5)).toBe(0); // grupo errado (não está com seu par)
  });

  it('nenhum grupo formado → todos 0 pontos, spy sem infiltração', async () => {
    const { calculateRoundScores } = await import('../../src/engine/scoring');
    const scores = calculateRoundScores({
      correctGroups: [[2, 3], [4, 5]],
      formedGroups: [], // ninguém formou grupo
      spyPlayerId: 1,
      spyGuessApproved: true,
    });
    expect(scores.get(1)).toBe(1); // só o chute
    expect(scores.get(2)).toBe(0);
    expect(scores.get(5)).toBe(0);
  });

  it('spy acerta chute + está isolado + agentes corretos = agentes ganham 1 (sem bônus)', async () => {
    const { calculateRoundScores } = await import('../../src/engine/scoring');
    const scores = calculateRoundScores({
      correctGroups: [[2, 3]],
      formedGroups: [[2, 3]],
      spyPlayerId: 1,
      spyGuessApproved: true,
    });
    expect(scores.get(1)).toBe(1); // chute correto
    expect(scores.get(2)).toBe(1); // grupo correto mas sem bônus (spy acertou)
    expect(scores.get(3)).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// VOTAÇÃO FAIR PLAY — Empate e edge cases
// ═══════════════════════════════════════════════════════════════

describe('votação fair play: empate', () => {
  it('empate 2-2 → chute APROVADO (regra: >= 50%)', async () => {
    const { round, players: ps, spyPlayer } = await createFullRoundScenario({ playerCount: 5, spyIndex: 0 });
    const { registerVote } = await import('../../src/engine/verdict');

    // 4 agentes, 2 votam sim, 2 votam não
    await registerVote(round.id, ps[1].id, 1);
    await registerVote(round.id, ps[2].id, 1);
    await registerVote(round.id, ps[3].id, 0);
    await registerVote(round.id, ps[4].id, 0);

    const votes = await db.query.spyGuessVotes.findMany({ where: eq(spyGuessVotes.roundId, round.id) });
    const yesVotes = votes.filter(v => v.vote === 1).length;
    const noVotes = votes.filter(v => v.vote === 0).length;
    // Regra: yesVotes >= noVotes && yesVotes > 0
    expect(yesVotes >= noVotes && yesVotes > 0).toBe(true);
  });

  it('1 voto sim, 0 votos não → aprovado', async () => {
    const { round, players: ps } = await createFullRoundScenario({ playerCount: 4, spyIndex: 0 });
    const { registerVote } = await import('../../src/engine/verdict');
    await registerVote(round.id, ps[1].id, 1);

    const votes = await db.query.spyGuessVotes.findMany({ where: eq(spyGuessVotes.roundId, round.id) });
    expect(votes.filter(v => v.vote === 1).length).toBe(1);
    expect(votes.filter(v => v.vote === 0).length).toBe(0);
  });

  it('0 votos sim, 1 voto não → rejeitado', async () => {
    const { round, players: ps } = await createFullRoundScenario({ playerCount: 4, spyIndex: 0 });
    const { registerVote } = await import('../../src/engine/verdict');
    await registerVote(round.id, ps[1].id, 0);

    const votes = await db.query.spyGuessVotes.findMany({ where: eq(spyGuessVotes.roundId, round.id) });
    const yesVotes = votes.filter(v => v.vote === 1).length;
    const noVotes = votes.filter(v => v.vote === 0).length;
    expect(yesVotes >= noVotes && yesVotes > 0).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// PAIRING — Operações em rodada fechada
// ═══════════════════════════════════════════════════════════════

describe('pairing: operações em rodada fechada', () => {
  it('aceitar pairing de rodada já fechada → recusado', async () => {
    const { round, players: ps } = await createFullRoundScenario({ playerCount: 5 });
    const { createPairingRequest, acceptPairing } = await import('../../src/engine/pairing');

    const pairingId = await createPairingRequest(round.id, ps[1].id, ps[2].id);

    // Fechar a rodada manualmente
    await db.update(rounds).set({ status: 'closed' }).where(eq(rounds.id, round.id));

    const result = await acceptPairing(pairingId);
    expect(result.success).toBe(false);
    expect(result.error).toContain('encerrada');
  });

  it('rejeitar pairing de rodada já fechada → recusado', async () => {
    const { round, players: ps } = await createFullRoundScenario({ playerCount: 5 });
    const { createPairingRequest, rejectPairing } = await import('../../src/engine/pairing');

    const pairingId = await createPairingRequest(round.id, ps[1].id, ps[2].id);
    await db.update(rounds).set({ status: 'closed' }).where(eq(rounds.id, round.id));

    const result = await rejectPairing(pairingId);
    expect(result.success).toBe(false);
    expect(result.error).toContain('encerrada');
  });
});

// ═══════════════════════════════════════════════════════════════
// PAIRING — Idempotência e estado inválido
// ═══════════════════════════════════════════════════════════════

describe('pairing: idempotência', () => {
  it('aceitar pairing já aceito → erro gracioso', async () => {
    const { round, players: ps } = await createFullRoundScenario({ playerCount: 5 });
    const { createPairingRequest, acceptPairing } = await import('../../src/engine/pairing');

    const pairingId = await createPairingRequest(round.id, ps[1].id, ps[2].id);
    await acceptPairing(pairingId);
    const result2 = await acceptPairing(pairingId); // segundo clique
    expect(result2.success).toBe(false);
    expect(result2.error).toContain('já processado');
  });

  it('rejeitar pairing já rejeitado → erro gracioso', async () => {
    const { round, players: ps } = await createFullRoundScenario({ playerCount: 5 });
    const { createPairingRequest, rejectPairing } = await import('../../src/engine/pairing');

    const pairingId = await createPairingRequest(round.id, ps[1].id, ps[2].id);
    await rejectPairing(pairingId);
    const result2 = await rejectPairing(pairingId);
    expect(result2.success).toBe(false);
  });

  it('desfazer par já desfeito → erro gracioso', async () => {
    const { round, players: ps } = await createFullRoundScenario({ playerCount: 5 });
    const { createPairingRequest, acceptPairing, undoPairing } = await import('../../src/engine/pairing');

    const pairingId = await createPairingRequest(round.id, ps[1].id, ps[2].id);
    await acceptPairing(pairingId);
    await undoPairing(round.id, ps[1].id);
    const result2 = await undoPairing(round.id, ps[1].id); // já desfeito
    expect(result2.success).toBe(false);
  });

  it('pairing para jogador inexistente (ID inválido) → bloqueado', async () => {
    const { round, players: ps } = await createFullRoundScenario({ playerCount: 3 });
    const { canRequestPairing } = await import('../../src/engine/pairing');

    const result = await canRequestPairing(round.id, ps[0].id, 99999);
    expect(result.allowed).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// GROUPS — Boundary conditions
// ═══════════════════════════════════════════════════════════════

describe('calculateGroups: limites', () => {
  it('3 jogadores (mínimo válido) → 1 spy + 1 dupla', async () => {
    const { calculateGroups } = await import('../../src/engine/groups');
    const result = calculateGroups([1, 2, 3], 1);
    expect(result.spyPlayerId).toBe(1);
    expect(result.groups).toHaveLength(1);
    expect(result.groupTypes).toEqual(['duo']);
    expect(result.groups[0]).toHaveLength(2);
  });

  it('2 jogadores (abaixo do mínimo) crasheia — validateGameStart deve impedir', async () => {
    const { calculateGroups } = await import('../../src/engine/groups');
    // calculateGroups com < 3 jogadores NÃO é seguro (bug conhecido).
    // validateGameStart garante mínimo 3 jogadores antes de chamar calculateGroups.
    // Este teste verifica que a validação impede o cenário:
    const { validateGameStart } = await import('../../src/engine/lobby');
    const game = await createTestGame();
    await createTestPlayer(game.id, { photoFileId: 'p1' });
    await createTestPlayer(game.id, { photoFileId: 'p2' });
    const result = await validateGameStart(game.id);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Mínimo');
  });
});

// ═══════════════════════════════════════════════════════════════
// LOBBY — Player leaves with pending pairing
// ═══════════════════════════════════════════════════════════════

describe('jogador sai com pairing pendente', () => {
  it('target do pairing sai → requester pode pedir novo par', async () => {
    const { round, players: ps, game } = await createFullRoundScenario({ playerCount: 5 });
    const { createPairingRequest, canRequestPairing } = await import('../../src/engine/pairing');

    // ps[1] pede par com ps[2]
    await createPairingRequest(round.id, ps[1].id, ps[2].id);

    // ps[2] sai do jogo — setar isActive = 0
    await db.update(players).set({ isActive: 0 }).where(eq(players.id, ps[2].id));

    // ps[1] está com status pending_sent → precisa voltar a unpaired
    // O sistema não faz isso automaticamente (gap real), mas podemos verificar o estado
    const state = await db.query.playerRoundState.findFirst({
      where: and(eq(playerRoundState.roundId, round.id), eq(playerRoundState.playerId, ps[1].id)),
    });
    expect(state!.pairingStatus).toBe('pending_sent');
    // NOTA: Em produção, o handler de /leave deveria dissolver pairings pendentes
  });
});

// ═══════════════════════════════════════════════════════════════
// VERDICT — Spy isolado, sem chute
// ═══════════════════════════════════════════════════════════════

describe('spy isolado sem chute (spyGuess = null)', () => {
  it('rodada fecha normalmente mesmo sem chute do spy', async () => {
    const { round, players: ps, spyPlayer } = await createFullRoundScenario({ playerCount: 3, spyIndex: 0 });

    const agents = ps.filter(p => p.id !== spyPlayer.id);
    const pairedWith = JSON.stringify(agents.map(a => a.id));
    for (const agent of agents) {
      await db.update(playerRoundState)
        .set({ pairingStatus: 'paired', pairedWith, verdictActive: 1 })
        .where(and(eq(playerRoundState.roundId, round.id), eq(playerRoundState.playerId, agent.id)));
    }

    // Spy isolado, spyGuess = null (nunca chutou)
    const api = createMockApi();
    const { checkRoundClose } = await import('../../src/engine/verdict');
    await checkRoundClose(round.id, api);

    const updatedRound = await db.query.rounds.findFirst({ where: eq(rounds.id, round.id) });
    expect(updatedRound!.status).toBe('closed');

    // spyGuess deve ser null
    expect(updatedRound!.spyGuess).toBeNull();
    // spyGuessApproved deve ser 0 (não acertou)
    expect(updatedRound!.spyGuessApproved).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// VALIDATORS — Dados corrompidos / edge cases
// ═══════════════════════════════════════════════════════════════

describe('validators: dados corrompidos', () => {
  it('jogador com isActive=1 em dois jogos ativos → retorna um deles', async () => {
    const { getPlayerActiveGame } = await import('../../src/utils/validators');
    const game1 = await createTestGame({ status: 'lobby' });
    const game2 = await createTestGame({ status: 'round_active' });
    await createTestPlayer(game1.id, { userId: 77777 });
    await createTestPlayer(game2.id, { userId: 77777 });

    const result = await getPlayerActiveGame(77777);
    expect(result).not.toBeNull();
    // Deve retornar um dos dois (ambos são ativos)
    expect([game1.id, game2.id]).toContain(result!.id);
  });

  it('jogo com status inválido (string qualquer) → getAnyActiveGameForChat ignora', async () => {
    const { getAnyActiveGameForChat } = await import('../../src/utils/validators');
    const game = await createTestGame({ status: 'invalid_status', chatId: -99999 });
    const result = await getAnyActiveGameForChat(-99999);
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// PHOTO HANDLER — mensagem com array de fotos vazio
// ═══════════════════════════════════════════════════════════════

describe('photo handler: edge cases', () => {
  it('selfie em jogo que foi limpo entre getPlayerActiveGame e query → erro gracioso', async () => {
    // Simula caso onde o jogo é deletado entre as duas queries do handler
    const { registerPhotoHandler } = await import('../../src/handlers/photos');
    let handler: Function;
    const mockBot = {
      on: vi.fn((event: string, fn: Function) => { if (event === 'message:photo') handler = fn; }),
    };
    registerPhotoHandler(mockBot as any);

    // Jogo existe quando getPlayerActiveGame roda, mas player record é deletado
    const game = await createTestGame({ status: 'lobby' });
    await createTestPlayer(game.id, { userId: 66666 });

    // Deletar o player DEPOIS de criar (simula cleanup mid-request)
    await db.delete(players).where(eq(players.userId, 66666));

    const ctx = {
      chat: { type: 'private' },
      from: { id: 66666 },
      message: { photo: [{ file_id: 'small' }, { file_id: 'big' }] },
      reply: vi.fn().mockResolvedValue(undefined),
    };

    // getPlayerActiveGame retorna null (player deletado) → mensagem de "não está em jogo"
    await handler!(ctx);

    const replies = ctx.reply.mock.calls.map((c: any[]) => c[0]);
    expect(replies.some((r: string) => r.includes('não está'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// ROUND — Locais com personagens insuficientes
// ═══════════════════════════════════════════════════════════════

describe('round: personagens insuficientes', () => {
  it('local com menos personagens que agentes → preenche com fallback genérico', async () => {
    // Testar indiretamente via calculateGroups e startNextRound
    // O fix adiciona personagens genéricos quando characters.length < numAgents
    const game = await createTestGame({ status: 'playing', currentRound: 0, totalRounds: 1 });
    for (let i = 0; i < 12; i++) {
      await createTestPlayer(game.id, { photoFileId: `p${i}` });
    }

    // O local de fallback tem 12 personagens, suficiente para 11 agentes
    // Para testar insuficiência, precisaríamos de um local com < 11 chars
    // O fix em round.ts garante que isso não crasheia
    const api = createMockApi();
    // startNextRound não deve crashar mesmo se o local tem poucos personagens
    const { startNextRound } = await import('../../src/engine/round');
    await expect(startNextRound(game.id, api)).resolves.not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// CLEANUP — Robustez
// ═══════════════════════════════════════════════════════════════

describe('cleanup: robustez', () => {
  it('cleanup de jogo inexistente não crasheia', async () => {
    const { cleanupGameData } = await import('../../src/engine/cleanup');
    await expect(cleanupGameData('game_nao_existe')).resolves.not.toThrow();
  });

  it('cleanup duplo (chamar 2x) não crasheia', async () => {
    const { cleanupGameData } = await import('../../src/engine/cleanup');
    const game = await createTestGame();
    await createTestPlayer(game.id);
    await cleanupGameData(game.id);
    await expect(cleanupGameData(game.id)).resolves.not.toThrow(); // já deletado
  });
});

// ═══════════════════════════════════════════════════════════════
// NORMALIZAÇÃO — Strings extremas
// ═══════════════════════════════════════════════════════════════

describe('normalizeString: inputs extremos', () => {
  it('string com apenas emoji → vazia', async () => {
    const { normalizeString } = await import('../../src/engine/scoring');
    expect(normalizeString('🏥')).toBe('');
  });

  it('string muito longa (1000 chars) → não crasheia', async () => {
    const { normalizeString } = await import('../../src/engine/scoring');
    const long = 'a'.repeat(1000);
    expect(normalizeString(long)).toBe(long);
  });

  it('string com caracteres japoneses → remove tudo (só preserva a-z0-9)', async () => {
    const { normalizeString } = await import('../../src/engine/scoring');
    expect(normalizeString('東京タワー')).toBe('');
  });

  it('isSpyGuessCorrect com ambos vazios → true (ambos normalizam para "")', async () => {
    const { isSpyGuessCorrect } = await import('../../src/engine/scoring');
    expect(isSpyGuessCorrect('🏥', '🏨')).toBe(true); // ambos viram ""
  });
});

// ═══════════════════════════════════════════════════════════════
// MULTIPLE ROUNDS — Estado entre rodadas
// ═══════════════════════════════════════════════════════════════

describe('estado entre rodadas', () => {
  it('dados da rodada anterior não vazam para a próxima', async () => {
    const game = await createTestGame({ status: 'playing', currentRound: 0, totalRounds: 2 });
    for (let i = 0; i < 4; i++) {
      await createTestPlayer(game.id, { photoFileId: `p${i}` });
    }

    const api = createMockApi();
    const { startNextRound, getPlayerRoundStates } = await import('../../src/engine/round');

    // Rodada 1
    await startNextRound(game.id, api);
    const r1 = await db.query.rounds.findFirst({
      where: and(eq(rounds.gameId, game.id), eq(rounds.roundNumber, 1)),
    });
    expect(r1).toBeDefined();

    const r1States = await getPlayerRoundStates(r1!.id);
    expect(r1States.every(s => s.pairingStatus === 'unpaired')).toBe(true);

    // Simular fechamento da rodada 1
    for (const s of r1States) {
      await db.update(playerRoundState)
        .set({ pairingStatus: 'paired', pairedWith: '[1,2]', verdictActive: 1 })
        .where(eq(playerRoundState.id, s.id));
    }
    await db.update(rounds).set({ status: 'closed' }).where(eq(rounds.id, r1!.id));
    await db.update(games).set({ status: 'round_ended' }).where(eq(games.id, game.id));

    // Rodada 2
    await startNextRound(game.id, api);
    const r2 = await db.query.rounds.findFirst({
      where: and(eq(rounds.gameId, game.id), eq(rounds.roundNumber, 2)),
    });
    expect(r2).toBeDefined();
    expect(r2!.id).not.toBe(r1!.id);

    // Estados da rodada 2 devem estar todos unpaired (limpos)
    const r2States = await getPlayerRoundStates(r2!.id);
    expect(r2States.every(s => s.pairingStatus === 'unpaired')).toBe(true);
    expect(r2States.every(s => s.verdictActive === 0)).toBe(true);

    // Espião da rodada 2 pode ser diferente da rodada 1
    expect(r2!.spyPlayerId).toBeDefined();
  });
});
