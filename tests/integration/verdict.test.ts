import { describe, it, expect } from 'vitest';
import { submitSpyGuess, checkRoundClose, registerVote } from '../../src/engine/verdict';
import { createFullRoundScenario } from '../helpers/factories';
import { createMockApi } from '../helpers/mock-api';
import { db } from '../../src/db/connection';
import { playerRoundState, rounds } from '../../src/db/schema';
import { eq, and } from 'drizzle-orm';

describe('submitSpyGuess', () => {
  it('salva o chute do espião na rodada', async () => {
    const { round, spyPlayer } = await createFullRoundScenario({ playerCount: 4 });
    await submitSpyGuess(round.id, spyPlayer.id, 'Hospital');

    const updated = await db.query.rounds.findFirst({ where: eq(rounds.id, round.id) });
    expect(updated!.spyGuess).toBe('Hospital');
  });

  it('marca verdictActive do espião', async () => {
    const { round, spyPlayer } = await createFullRoundScenario({ playerCount: 4 });
    await submitSpyGuess(round.id, spyPlayer.id, 'Escola');

    const state = await db.query.playerRoundState.findFirst({
      where: and(eq(playerRoundState.roundId, round.id), eq(playerRoundState.playerId, spyPlayer.id)),
    });
    expect(state!.verdictActive).toBe(1);
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
  it('fecha rodada quando todos pareados deram veredito e 1 está isolado', async () => {
    // 4 jogadores: spy + 3 agentes (1 trio)
    // O spy será isolado (unpaired)
    const { round, players, spyPlayer, game } = await createFullRoundScenario({
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

    // Spy continua unpaired (isolado) — sem veredito
    const api = createMockApi();
    await checkRoundClose(round.id, api);

    // A rodada deve ter sido fechada
    const updatedRound = await db.query.rounds.findFirst({ where: eq(rounds.id, round.id) });
    expect(updatedRound!.status).toBe('closed');
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
