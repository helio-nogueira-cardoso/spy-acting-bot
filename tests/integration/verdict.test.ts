import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  submitSpyGuess,
  checkRoundClose,
  registerVote,
  isSpyGraceActive,
  __resetSpyGraceTimers,
  __resetVotingSessions,
  __resetClosingRounds,
  __setFairPlayVotingTimeoutMs,
  __resetFairPlayVotingTimeoutMs,
} from '../../src/engine/verdict';
import { createFullRoundScenario } from '../helpers/factories';
import { createMockApi } from '../helpers/mock-api';
import { db } from '../../src/db/connection';
import { playerRoundState, rounds } from '../../src/db/schema';
import { eq, and } from 'drizzle-orm';

beforeEach(() => {
  __resetSpyGraceTimers();
  __resetVotingSessions();
  __resetClosingRounds();
  __resetFairPlayVotingTimeoutMs();
});

afterEach(() => {
  __resetSpyGraceTimers();
  __resetVotingSessions();
  __resetClosingRounds();
  __resetFairPlayVotingTimeoutMs();
});

describe('submitSpyGuess', () => {
  it('salva o chute do espião na rodada', async () => {
    const { round, spyPlayer } = await createFullRoundScenario({ playerCount: 4 });
    await submitSpyGuess(round.id, spyPlayer.id, 'Hospital');

    const updated = await db.query.rounds.findFirst({ where: eq(rounds.id, round.id) });
    expect(updated!.spyGuess).toBe('Hospital');
  });

  it('permite alterar o chute (Bug #2)', async () => {
    const { round, spyPlayer } = await createFullRoundScenario({ playerCount: 4 });
    await submitSpyGuess(round.id, spyPlayer.id, 'Hospital');
    await submitSpyGuess(round.id, spyPlayer.id, 'Escola');

    const updated = await db.query.rounds.findFirst({ where: eq(rounds.id, round.id) });
    expect(updated!.spyGuess).toBe('Escola');
  });

  it('NÃO marca verdictActive automaticamente (Bug #2 — desacoplamento)', async () => {
    const { round, spyPlayer } = await createFullRoundScenario({ playerCount: 4 });
    await submitSpyGuess(round.id, spyPlayer.id, 'Escola');

    const state = await db.query.playerRoundState.findFirst({
      where: and(eq(playerRoundState.roundId, round.id), eq(playerRoundState.playerId, spyPlayer.id)),
    });
    // Chute e veredito são independentes: chutar não marca veredito
    expect(state!.verdictActive).toBe(0);
  });

  it('chute funciona mesmo com espião sem par (Bug #2)', async () => {
    const { round, spyPlayer } = await createFullRoundScenario({ playerCount: 4, spyIndex: 0 });
    await submitSpyGuess(round.id, spyPlayer.id, 'Hospital');

    const updated = await db.query.rounds.findFirst({ where: eq(rounds.id, round.id) });
    expect(updated!.spyGuess).toBe('Hospital');

    const state = await db.query.playerRoundState.findFirst({
      where: and(eq(playerRoundState.roundId, round.id), eq(playerRoundState.playerId, spyPlayer.id)),
    });
    expect(state!.pairingStatus).toBe('unpaired');
  });
});

describe('registerVote', () => {
  it('agente pode votar', async () => {
    const { round, players } = await createFullRoundScenario({ playerCount: 4, spyIndex: 0 });
    const result = await registerVote(round.id, players[1].id, 1);
    expect(result.success).toBe(true);
  });

  it('espião não pode votar', async () => {
    const { round, spyPlayer } = await createFullRoundScenario({ playerCount: 4 });
    const result = await registerVote(round.id, spyPlayer.id, 1);
    expect(result.success).toBe(false);
    expect(result.error).toContain('espião');
  });

  it('não permite voto duplicado', async () => {
    const { round, players } = await createFullRoundScenario({ playerCount: 4, spyIndex: 0 });
    await registerVote(round.id, players[1].id, 1);
    const result = await registerVote(round.id, players[1].id, 0);
    expect(result.success).toBe(false);
    expect(result.error).toContain('já votou');
  });
});

describe('checkRoundClose (Bug #3 regression)', () => {
  it('fecha rodada quando todos pareados deram veredito, spy chutou e está isolado', async () => {
    const { round, players, spyPlayer } = await createFullRoundScenario({
      playerCount: 4,
      spyIndex: 0,
    });

    const agents = players.filter(p => p.id !== spyPlayer.id);
    const pairedWith = JSON.stringify(agents.map(a => a.id));
    for (const agent of agents) {
      await db.update(playerRoundState)
        .set({ pairingStatus: 'paired', pairedWith, verdictActive: 1 })
        .where(and(eq(playerRoundState.roundId, round.id), eq(playerRoundState.playerId, agent.id)));
    }

    await submitSpyGuess(round.id, spyPlayer.id, 'Hospital');

    const api = createMockApi();
    await checkRoundClose(round.id, api);

    const updatedRound = await db.query.rounds.findFirst({ where: eq(rounds.id, round.id) });
    expect(updatedRound!.status).toBe('closed');
  });

  it('NÃO fecha imediatamente se espião não chutou — inicia janela de graça (Bug #2)', async () => {
    const { round, players, spyPlayer } = await createFullRoundScenario({
      playerCount: 4,
      spyIndex: 0,
    });

    const agents = players.filter(p => p.id !== spyPlayer.id);
    const pairedWith = JSON.stringify(agents.map(a => a.id));
    for (const agent of agents) {
      await db.update(playerRoundState)
        .set({ pairingStatus: 'paired', pairedWith, verdictActive: 1 })
        .where(and(eq(playerRoundState.roundId, round.id), eq(playerRoundState.playerId, agent.id)));
    }

    const api = createMockApi();
    await checkRoundClose(round.id, api);

    const updatedRound = await db.query.rounds.findFirst({ where: eq(rounds.id, round.id) });
    expect(updatedRound!.status).toBe('active');

    // Notificação de graça enviada ao espião + grace timer ativo
    const spyNotified = (api.sendMessage as any).mock.calls.some(
      (call: any[]) => call[0] === spyPlayer.userId && String(call[1]).includes('segundos para chutar')
    );
    expect(spyNotified).toBe(true);
    expect(isSpyGraceActive(round.id)).toBe(true);
  });

  it('fecha rodada ao receber chute do espião durante graça (Bug #2)', async () => {
    const { round, players, spyPlayer } = await createFullRoundScenario({
      playerCount: 4,
      spyIndex: 0,
    });

    const agents = players.filter(p => p.id !== spyPlayer.id);
    const pairedWith = JSON.stringify(agents.map(a => a.id));
    for (const agent of agents) {
      await db.update(playerRoundState)
        .set({ pairingStatus: 'paired', pairedWith, verdictActive: 1 })
        .where(and(eq(playerRoundState.roundId, round.id), eq(playerRoundState.playerId, agent.id)));
    }

    const api = createMockApi();
    await checkRoundClose(round.id, api);
    expect((await db.query.rounds.findFirst({ where: eq(rounds.id, round.id) }))!.status).toBe('active');
    expect(isSpyGraceActive(round.id)).toBe(true);

    // Espião chuta dentro da graça → nova verificação deve fechar
    await submitSpyGuess(round.id, spyPlayer.id, 'Hospital');
    await checkRoundClose(round.id, api);

    const finalRound = await db.query.rounds.findFirst({ where: eq(rounds.id, round.id) });
    expect(finalRound!.status).toBe('closed');
    // Graça foi cancelada: chute único durante o tempo extra
    expect(isSpyGraceActive(round.id)).toBe(false);
  });

  it('NÃO fecha se há pareamentos pendentes', async () => {
    const { round, players } = await createFullRoundScenario({
      playerCount: 5,
      spyIndex: 0,
    });

    await db.update(playerRoundState)
      .set({ pairingStatus: 'pending_sent' })
      .where(and(eq(playerRoundState.roundId, round.id), eq(playerRoundState.playerId, players[1].id)));

    const api = createMockApi();
    await checkRoundClose(round.id, api);

    const updatedRound = await db.query.rounds.findFirst({ where: eq(rounds.id, round.id) });
    expect(updatedRound!.status).toBe('active');
  });

  it('NÃO fecha se algum pareado não deu veredito', async () => {
    const { round, players, spyPlayer } = await createFullRoundScenario({
      playerCount: 5,
      spyIndex: 0,
    });

    const agents = players.filter(p => p.id !== spyPlayer.id);
    const pairedWith = JSON.stringify([agents[0].id, agents[1].id]);

    await db.update(playerRoundState)
      .set({ pairingStatus: 'paired', pairedWith, verdictActive: 1 })
      .where(and(eq(playerRoundState.roundId, round.id), eq(playerRoundState.playerId, agents[0].id)));
    await db.update(playerRoundState)
      .set({ pairingStatus: 'paired', pairedWith, verdictActive: 1 })
      .where(and(eq(playerRoundState.roundId, round.id), eq(playerRoundState.playerId, agents[1].id)));

    const paired2 = JSON.stringify([agents[2].id, agents[3].id]);
    await db.update(playerRoundState)
      .set({ pairingStatus: 'paired', pairedWith: paired2, verdictActive: 0 })
      .where(and(eq(playerRoundState.roundId, round.id), eq(playerRoundState.playerId, agents[2].id)));
    await db.update(playerRoundState)
      .set({ pairingStatus: 'paired', pairedWith: paired2, verdictActive: 0 })
      .where(and(eq(playerRoundState.roundId, round.id), eq(playerRoundState.playerId, agents[3].id)));

    const api = createMockApi();
    await checkRoundClose(round.id, api);

    const updatedRound = await db.query.rounds.findFirst({ where: eq(rounds.id, round.id) });
    expect(updatedRound!.status).toBe('active');
  });

  it('auto-marca veredito do jogador isolado ao fechar', async () => {
    const { round, players, spyPlayer } = await createFullRoundScenario({
      playerCount: 4,
      spyIndex: 0,
    });

    const agents = players.filter(p => p.id !== spyPlayer.id);
    const pairedWith = JSON.stringify(agents.map(a => a.id));

    for (const agent of agents) {
      await db.update(playerRoundState)
        .set({ pairingStatus: 'paired', pairedWith, verdictActive: 1 })
        .where(and(eq(playerRoundState.roundId, round.id), eq(playerRoundState.playerId, agent.id)));
    }

    const api = createMockApi();
    await checkRoundClose(round.id, api);

    const spyState = await db.query.playerRoundState.findFirst({
      where: and(eq(playerRoundState.roundId, round.id), eq(playerRoundState.playerId, spyPlayer.id)),
    });
    expect(spyState!.verdictActive).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// VOTAÇÃO FAIR PLAY (integração com checkRoundClose)
// ═══════════════════════════════════════════════════════════════

/**
 * Helper: monta cenário onde todos os agentes estão em um grupo com veredito,
 * e o espião está isolado e já chutou (errado, forçando votação fair play).
 */
async function setupReadyForVoting(playerCount = 4, spyIndex = 0, wrongGuess = 'Escola') {
  const scenario = await createFullRoundScenario({ playerCount, spyIndex });
  const { round, players, spyPlayer } = scenario;
  const agents = players.filter(p => p.id !== spyPlayer.id);
  const pairedWith = JSON.stringify(agents.map(a => a.id));
  for (const agent of agents) {
    await db.update(playerRoundState)
      .set({ pairingStatus: 'paired', pairedWith, verdictActive: 1 })
      .where(and(eq(playerRoundState.roundId, round.id), eq(playerRoundState.playerId, agent.id)));
  }
  await submitSpyGuess(round.id, spyPlayer.id, wrongGuess);
  return scenario;
}

describe('votação fair play (integração)', () => {
  it('computa votos quando todos votam antes do timeout (bug principal)', async () => {
    __setFairPlayVotingTimeoutMs(30_000); // tempo longo para garantir que encerra por votos, não timeout
    vi.useFakeTimers();
    try {
      const { round, players, spyPlayer } = await setupReadyForVoting(4, 0, 'Escola');
      const agents = players.filter(p => p.id !== spyPlayer.id);

      const api = createMockApi();
      const closePromise = checkRoundClose(round.id, api);

      // Deixar micro-tasks rodarem até a mensagem de votação ser enviada
      await vi.advanceTimersByTimeAsync(50);

      // Todos os 3 agentes votam SIM
      await registerVote(round.id, agents[0].id, 1);
      await registerVote(round.id, agents[1].id, 1);
      await registerVote(round.id, agents[2].id, 1);

      // Após o último voto, a sessão deve fechar antecipadamente e o fluxo prosseguir
      await vi.advanceTimersByTimeAsync(100);
      await closePromise;

      const finalRound = await db.query.rounds.findFirst({ where: eq(rounds.id, round.id) });
      expect(finalRound!.status).toBe('closed');
      expect(finalRound!.spyGuessApproved).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejeita chute quando maioria vota NÃO', async () => {
    __setFairPlayVotingTimeoutMs(30_000);
    vi.useFakeTimers();
    try {
      const { round, players, spyPlayer } = await setupReadyForVoting(5, 0, 'Aeroporto');
      const agents = players.filter(p => p.id !== spyPlayer.id);

      const api = createMockApi();
      const closePromise = checkRoundClose(round.id, api);
      await vi.advanceTimersByTimeAsync(50);

      // 4 agentes: 1 sim, 3 não
      await registerVote(round.id, agents[0].id, 1);
      await registerVote(round.id, agents[1].id, 0);
      await registerVote(round.id, agents[2].id, 0);
      await registerVote(round.id, agents[3].id, 0);

      await vi.advanceTimersByTimeAsync(100);
      await closePromise;

      const finalRound = await db.query.rounds.findFirst({ where: eq(rounds.id, round.id) });
      expect(finalRound!.status).toBe('closed');
      expect(finalRound!.spyGuessApproved).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fechamento antecipado: não aguarda o timeout completo quando todos votaram', async () => {
    __setFairPlayVotingTimeoutMs(60_000);
    vi.useFakeTimers();
    try {
      const { round, players, spyPlayer } = await setupReadyForVoting(4, 0, 'Escola');
      const agents = players.filter(p => p.id !== spyPlayer.id);

      const api = createMockApi();
      const closePromise = checkRoundClose(round.id, api);
      await vi.advanceTimersByTimeAsync(50);

      // Todos votam muito antes do timeout
      await registerVote(round.id, agents[0].id, 1);
      await registerVote(round.id, agents[1].id, 1);
      await registerVote(round.id, agents[2].id, 0);

      // Avança apenas 1s — ainda longe dos 60s. Deve ter fechado por "todos votaram".
      await vi.advanceTimersByTimeAsync(1_000);
      await closePromise;

      const finalRound = await db.query.rounds.findFirst({ where: eq(rounds.id, round.id) });
      expect(finalRound!.status).toBe('closed');
      expect(finalRound!.spyGuessApproved).toBe(1); // 2 sim / 1 não → aprovado
    } finally {
      vi.useRealTimers();
    }
  });

  it('timeout expira sem votos → chute invalidado', async () => {
    __setFairPlayVotingTimeoutMs(30_000);
    vi.useFakeTimers();
    try {
      const { round } = await setupReadyForVoting(4, 0, 'Escola');

      const api = createMockApi();
      const closePromise = checkRoundClose(round.id, api);
      await vi.advanceTimersByTimeAsync(50);

      // Ninguém vota, avança além do timeout
      await vi.advanceTimersByTimeAsync(31_000);
      await closePromise;

      const finalRound = await db.query.rounds.findFirst({ where: eq(rounds.id, round.id) });
      expect(finalRound!.status).toBe('closed');
      expect(finalRound!.spyGuessApproved).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('votação considera apenas votos de jogadores elegíveis (agentes ativos, não-espião)', async () => {
    __setFairPlayVotingTimeoutMs(30_000);
    vi.useFakeTimers();
    try {
      const { round, players, spyPlayer } = await setupReadyForVoting(4, 0, 'Escola');
      const agents = players.filter(p => p.id !== spyPlayer.id);

      const api = createMockApi();
      const closePromise = checkRoundClose(round.id, api);
      await vi.advanceTimersByTimeAsync(50);

      // Tentar voto do espião: deve ser rejeitado
      const spyVoteResult = await registerVote(round.id, spyPlayer.id, 1);
      expect(spyVoteResult.success).toBe(false);

      // Agentes votam
      await registerVote(round.id, agents[0].id, 1);
      await registerVote(round.id, agents[1].id, 1);
      await registerVote(round.id, agents[2].id, 1);

      await vi.advanceTimersByTimeAsync(100);
      await closePromise;

      const finalRound = await db.query.rounds.findFirst({ where: eq(rounds.id, round.id) });
      expect(finalRound!.spyGuessApproved).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fechamento antecipado funciona com 1 agente só (3 jogadores)', async () => {
    __setFairPlayVotingTimeoutMs(30_000);
    vi.useFakeTimers();
    try {
      // 3 jogadores: spy + 2 agentes (dupla)
      const scenario = await createFullRoundScenario({ playerCount: 3, spyIndex: 0 });
      const { round, players, spyPlayer } = scenario;
      const agents = players.filter(p => p.id !== spyPlayer.id);
      const pairedWith = JSON.stringify(agents.map(a => a.id));
      for (const agent of agents) {
        await db.update(playerRoundState)
          .set({ pairingStatus: 'paired', pairedWith, verdictActive: 1 })
          .where(and(eq(playerRoundState.roundId, round.id), eq(playerRoundState.playerId, agent.id)));
      }
      await submitSpyGuess(round.id, spyPlayer.id, 'Escola');

      const api = createMockApi();
      const closePromise = checkRoundClose(round.id, api);
      await vi.advanceTimersByTimeAsync(50);

      // 2 agentes votam SIM → fecha antecipadamente
      await registerVote(round.id, agents[0].id, 1);
      await registerVote(round.id, agents[1].id, 1);

      await vi.advanceTimersByTimeAsync(100);
      await closePromise;

      const finalRound = await db.query.rounds.findFirst({ where: eq(rounds.id, round.id) });
      expect(finalRound!.status).toBe('closed');
      expect(finalRound!.spyGuessApproved).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('grace period — chute único no tempo extra', () => {
  it('chute durante grace fecha rodada e cancela o timer', async () => {
    vi.useFakeTimers();
    try {
      const { round, players, spyPlayer } = await createFullRoundScenario({
        playerCount: 4,
        spyIndex: 0,
      });

      const agents = players.filter(p => p.id !== spyPlayer.id);
      const pairedWith = JSON.stringify(agents.map(a => a.id));
      for (const agent of agents) {
        await db.update(playerRoundState)
          .set({ pairingStatus: 'paired', pairedWith, verdictActive: 1 })
          .where(and(eq(playerRoundState.roundId, round.id), eq(playerRoundState.playerId, agent.id)));
      }

      const api = createMockApi();
      // Primeira chamada: inicia grace
      await checkRoundClose(round.id, api);
      expect(isSpyGraceActive(round.id)).toBe(true);

      // Espião chuta corretamente durante o grace
      await submitSpyGuess(round.id, spyPlayer.id, 'Hospital');
      await checkRoundClose(round.id, api);

      // Grace foi cancelado: chute único
      expect(isSpyGraceActive(round.id)).toBe(false);
      const finalRound = await db.query.rounds.findFirst({ where: eq(rounds.id, round.id) });
      expect(finalRound!.status).toBe('closed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('isSpyGraceActive reflete estado do timer', async () => {
    const { round, players, spyPlayer } = await createFullRoundScenario({
      playerCount: 4,
      spyIndex: 0,
    });
    const agents = players.filter(p => p.id !== spyPlayer.id);
    const pairedWith = JSON.stringify(agents.map(a => a.id));
    for (const agent of agents) {
      await db.update(playerRoundState)
        .set({ pairingStatus: 'paired', pairedWith, verdictActive: 1 })
        .where(and(eq(playerRoundState.roundId, round.id), eq(playerRoundState.playerId, agent.id)));
    }

    expect(isSpyGraceActive(round.id)).toBe(false);
    const api = createMockApi();
    await checkRoundClose(round.id, api);
    expect(isSpyGraceActive(round.id)).toBe(true);
  });
});
