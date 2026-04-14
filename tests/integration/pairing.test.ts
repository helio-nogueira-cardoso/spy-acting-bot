import { describe, it, expect } from 'vitest';
import {
  canRequestPairing,
  createPairingRequest,
  acceptPairing,
  rejectPairing,
  addToGroup,
  undoPairing,
  getAvailablePlayers,
  isGroupComplete,
} from '../../src/engine/pairing';
import { createFullRoundScenario, createTestPlayerRoundState, createTestRoundRole } from '../helpers/factories';
import { db } from '../../src/db/connection';
import { playerRoundState } from '../../src/db/schema';
import { eq, and } from 'drizzle-orm';

describe('canRequestPairing', () => {
  it('permite pareamento entre dois jogadores livres', async () => {
    const { round, players } = await createFullRoundScenario({ playerCount: 4 });
    const result = await canRequestPairing(round.id, players[1].id, players[2].id);
    expect(result.allowed).toBe(true);
  });

  it('proíbe auto-pareamento', async () => {
    const { round, players } = await createFullRoundScenario({ playerCount: 3 });
    const result = await canRequestPairing(round.id, players[0].id, players[0].id);
    expect(result.allowed).toBe(false);
  });

  it('proíbe se requester já está pareado', async () => {
    const { round, players } = await createFullRoundScenario({ playerCount: 5 });
    // Simular que player[1] já está pareado
    await db.update(playerRoundState)
      .set({ pairingStatus: 'paired', pairedWith: JSON.stringify([players[1].id, players[2].id]) })
      .where(and(eq(playerRoundState.roundId, round.id), eq(playerRoundState.playerId, players[1].id)));

    const result = await canRequestPairing(round.id, players[1].id, players[3].id);
    expect(result.allowed).toBe(false);
  });

  it('proíbe se target tem convite pendente', async () => {
    const { round, players } = await createFullRoundScenario({ playerCount: 5 });
    await db.update(playerRoundState)
      .set({ pairingStatus: 'pending_received' })
      .where(and(eq(playerRoundState.roundId, round.id), eq(playerRoundState.playerId, players[3].id)));

    const result = await canRequestPairing(round.id, players[1].id, players[3].id);
    expect(result.allowed).toBe(false);
  });
});

describe('createPairingRequest + acceptPairing', () => {
  it('cria request e atualiza estados para pending', async () => {
    const { round, players } = await createFullRoundScenario({ playerCount: 5 });
    const pairingId = await createPairingRequest(round.id, players[1].id, players[2].id);
    expect(pairingId).toBeGreaterThan(0);

    const reqState = await db.query.playerRoundState.findFirst({
      where: and(eq(playerRoundState.roundId, round.id), eq(playerRoundState.playerId, players[1].id)),
    });
    expect(reqState!.pairingStatus).toBe('pending_sent');

    const tgtState = await db.query.playerRoundState.findFirst({
      where: and(eq(playerRoundState.roundId, round.id), eq(playerRoundState.playerId, players[2].id)),
    });
    expect(tgtState!.pairingStatus).toBe('pending_received');
  });

  it('aceitar pairing de dupla marca grupo como completo', async () => {
    const { round, players } = await createFullRoundScenario({ playerCount: 5 });
    // players[1] e players[2] são do mesmo grupo duo
    const pairingId = await createPairingRequest(round.id, players[1].id, players[2].id);
    const result = await acceptPairing(pairingId);
    expect(result.success).toBe(true);
    expect(result.groupComplete).toBe(true);

    const state = await db.query.playerRoundState.findFirst({
      where: and(eq(playerRoundState.roundId, round.id), eq(playerRoundState.playerId, players[1].id)),
    });
    expect(state!.pairingStatus).toBe('paired');
    expect(state!.pairedWith).toBeDefined();
  });
});

describe('rejectPairing', () => {
  it('volta ambos para unpaired', async () => {
    const { round, players } = await createFullRoundScenario({ playerCount: 4 });
    const pairingId = await createPairingRequest(round.id, players[1].id, players[2].id);
    const result = await rejectPairing(pairingId);
    expect(result.success).toBe(true);

    const reqState = await db.query.playerRoundState.findFirst({
      where: and(eq(playerRoundState.roundId, round.id), eq(playerRoundState.playerId, players[1].id)),
    });
    expect(reqState!.pairingStatus).toBe('unpaired');

    const tgtState = await db.query.playerRoundState.findFirst({
      where: and(eq(playerRoundState.roundId, round.id), eq(playerRoundState.playerId, players[2].id)),
    });
    expect(tgtState!.pairingStatus).toBe('unpaired');
  });
});

describe('undoPairing', () => {
  it('desfaz par e volta membros para unpaired', async () => {
    const { round, players } = await createFullRoundScenario({ playerCount: 5 });
    const pairingId = await createPairingRequest(round.id, players[1].id, players[2].id);
    await acceptPairing(pairingId);

    const result = await undoPairing(round.id, players[1].id);
    expect(result.success).toBe(true);
    expect(result.affectedPlayerIds).toContain(players[1].id);
    expect(result.affectedPlayerIds).toContain(players[2].id);

    const state = await db.query.playerRoundState.findFirst({
      where: and(eq(playerRoundState.roundId, round.id), eq(playerRoundState.playerId, players[1].id)),
    });
    expect(state!.pairingStatus).toBe('unpaired');
    expect(state!.verdictActive).toBe(0);
  });

  it('falha se jogador não está pareado', async () => {
    const { round, players } = await createFullRoundScenario({ playerCount: 3 });
    const result = await undoPairing(round.id, players[0].id);
    expect(result.success).toBe(false);
  });
});

describe('getAvailablePlayers', () => {
  it('retorna apenas jogadores unpaired, excluindo o solicitante', async () => {
    const { round, players } = await createFullRoundScenario({ playerCount: 5 });

    // Parear players[1] e players[2]
    const pid = await createPairingRequest(round.id, players[1].id, players[2].id);
    await acceptPairing(pid);

    const available = await getAvailablePlayers(round.id, players[3].id);
    const availIds = available.map(a => a.playerId);

    expect(availIds).not.toContain(players[1].id); // paired
    expect(availIds).not.toContain(players[2].id); // paired
    expect(availIds).not.toContain(players[3].id); // self
    expect(availIds).toContain(players[0].id);      // spy, unpaired
    expect(availIds).toContain(players[4].id);      // unpaired
  });
});

describe('isGroupComplete', () => {
  it('dupla com 2 membros está completa', async () => {
    const { round, players } = await createFullRoundScenario({ playerCount: 5 });
    // players[1] é agente com groupType 'duo'
    const complete = await isGroupComplete([players[1].id, players[2].id], round.id);
    expect(complete).toBe(true);
  });

  it('dupla com 1 membro está incompleta', async () => {
    const { round, players } = await createFullRoundScenario({ playerCount: 5 });
    const complete = await isGroupComplete([players[1].id], round.id);
    expect(complete).toBe(false);
  });
});
