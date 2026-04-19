import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { submitSpyGuess, checkRoundClose, registerVote, __resetSpyGraceTimers } from '../../src/engine/verdict';
import { createFullRoundScenario } from '../helpers/factories';
import { createMockApi } from '../helpers/mock-api';
import { db } from '../../src/db/connection';
import { playerRoundState, rounds } from '../../src/db/schema';
import { eq, and } from 'drizzle-orm';

beforeEach(() => {
  __resetSpyGraceTimers();
});

afterEach(() => {
  __resetSpyGraceTimers();
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
    // Cenário: 4 jogadores, spy isolado (unpaired)
    const { round, spyPlayer } = await createFullRoundScenario({ playerCount: 4, spyIndex: 0 });

    // Espião permanece unpaired (default) e chuta
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
    // 4 jogadores: spy + 3 agentes (1 trio)
    // O spy será isolado (unpaired) mas com chute registrado
    const { round, players, spyPlayer } = await createFullRoundScenario({
      playerCount: 4,
      spyIndex: 0,
    });

    const agents = players.filter(p => p.id !== spyPlayer.id);

    // Parear os 3 agentes como trio e dar veredito
    const pairedWith = JSON.stringify(agents.map(a => a.id));
    for (const agent of agents) {
      await db.update(playerRoundState)
        .set({ pairingStatus: 'paired', pairedWith, verdictActive: 1 })
        .where(and(eq(playerRoundState.roundId, round.id), eq(playerRoundState.playerId, agent.id)));
    }

    // Spy registrou chute: grace é pulada, rodada fecha imediatamente
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

    // Espião SEM chute: grace inicia, rodada ainda não fecha
    const api = createMockApi();
    await checkRoundClose(round.id, api);

    const updatedRound = await db.query.rounds.findFirst({ where: eq(rounds.id, round.id) });
    expect(updatedRound!.status).toBe('active');

    // Notificação de graça enviada ao espião
    const spyNotified = (api.sendMessage as any).mock.calls.some(
      (call: any[]) => call[0] === spyPlayer.userId && String(call[1]).includes('segundos para chutar')
    );
    expect(spyNotified).toBe(true);
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
    // Primeira chamada: dispara graça
    await checkRoundClose(round.id, api);
    expect((await db.query.rounds.findFirst({ where: eq(rounds.id, round.id) }))!.status).toBe('active');

    // Espião chuta dentro da graça → nova verificação deve fechar
    await submitSpyGuess(round.id, spyPlayer.id, 'Hospital');
    await checkRoundClose(round.id, api);

    const finalRound = await db.query.rounds.findFirst({ where: eq(rounds.id, round.id) });
    expect(finalRound!.status).toBe('closed');
  });

  it('NÃO fecha se há pareamentos pendentes', async () => {
    const { round, players, spyPlayer } = await createFullRoundScenario({
      playerCount: 5,
      spyIndex: 0,
    });

    // Um jogador com pending_sent
    await db.update(playerRoundState)
      .set({ pairingStatus: 'pending_sent' })
      .where(and(eq(playerRoundState.roundId, round.id), eq(playerRoundState.playerId, players[1].id)));

    const api = createMockApi();
    await checkRoundClose(round.id, api);

    const updatedRound = await db.query.rounds.findFirst({ where: eq(rounds.id, round.id) });
    expect(updatedRound!.status).toBe('active'); // Não fechou
  });

  it('NÃO fecha se algum pareado não deu veredito', async () => {
    const { round, players, spyPlayer } = await createFullRoundScenario({
      playerCount: 5,
      spyIndex: 0,
    });

    const agents = players.filter(p => p.id !== spyPlayer.id);
    const pairedWith = JSON.stringify([agents[0].id, agents[1].id]);

    // Par 1: ambos com veredito
    await db.update(playerRoundState)
      .set({ pairingStatus: 'paired', pairedWith, verdictActive: 1 })
      .where(and(eq(playerRoundState.roundId, round.id), eq(playerRoundState.playerId, agents[0].id)));
    await db.update(playerRoundState)
      .set({ pairingStatus: 'paired', pairedWith, verdictActive: 1 })
      .where(and(eq(playerRoundState.roundId, round.id), eq(playerRoundState.playerId, agents[1].id)));

    // Par 2: pareados mas SEM veredito
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

    // O spy (isolado) deve ter verdictActive = 1 agora
    const spyState = await db.query.playerRoundState.findFirst({
      where: and(eq(playerRoundState.roundId, round.id), eq(playerRoundState.playerId, spyPlayer.id)),
    });
    expect(spyState!.verdictActive).toBe(1);
  });
});
