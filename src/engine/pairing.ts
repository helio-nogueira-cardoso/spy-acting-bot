import { eq, and } from 'drizzle-orm';
import { db } from '../db/connection';
import { pairings, playerRoundState, roundRoles, rounds } from '../db/schema';
import { logger } from '../utils/logger';
import { touchGameActivity, sqliteNow } from './lobby';

async function touchRoundGame(roundId: number): Promise<void> {
  const round = await db.query.rounds.findFirst({ where: eq(rounds.id, roundId) });
  if (round) await touchGameActivity(round.gameId);
}

export async function canRequestPairing(
  roundId: number,
  requesterId: number,
  targetId: number
): Promise<{ allowed: boolean; reason?: string }> {
  if (requesterId === targetId) {
    return { allowed: false, reason: 'Você não pode se convidar.' };
  }

  const requesterState = await db.query.playerRoundState.findFirst({
    where: and(eq(playerRoundState.roundId, roundId), eq(playerRoundState.playerId, requesterId)),
  });

  if (!requesterState || requesterState.pairingStatus !== 'unpaired') {
    return { allowed: false, reason: 'Você já está em um par ou com convite pendente.' };
  }

  const targetState = await db.query.playerRoundState.findFirst({
    where: and(eq(playerRoundState.roundId, roundId), eq(playerRoundState.playerId, targetId)),
  });

  if (!targetState || targetState.pairingStatus !== 'unpaired') {
    return { allowed: false, reason: 'Este jogador já está em um par ou com convite pendente.' };
  }

  return { allowed: true };
}

export async function createPairingRequest(
  roundId: number,
  requesterId: number,
  targetId: number
): Promise<number> {
  // Atualizar estados
  await db.update(playerRoundState)
    .set({ pairingStatus: 'pending_sent' })
    .where(and(eq(playerRoundState.roundId, roundId), eq(playerRoundState.playerId, requesterId)));

  await db.update(playerRoundState)
    .set({ pairingStatus: 'pending_received' })
    .where(and(eq(playerRoundState.roundId, roundId), eq(playerRoundState.playerId, targetId)));

  const [pairing] = await db.insert(pairings).values({
    roundId,
    requesterId,
    targetId,
    status: 'pending',
  }).returning();

  await touchRoundGame(roundId);
  logger.info(`Pairing request criado: ${pairing.id} (${requesterId} → ${targetId})`);
  return pairing.id;
}

export async function acceptPairing(pairingId: number): Promise<{
  success: boolean;
  requesterId?: number;
  targetId?: number;
  groupComplete?: boolean;
  error?: string;
}> {
  const pairing = await db.query.pairings.findFirst({ where: eq(pairings.id, pairingId) });
  if (!pairing || pairing.status !== 'pending') {
    return { success: false, error: 'Convite não encontrado ou já processado.' };
  }

  // Verificar se a rodada ainda está ativa
  const round = await db.query.rounds.findFirst({ where: eq(rounds.id, pairing.roundId) });
  if (!round || round.status !== 'active') {
    return { success: false, error: 'Esta rodada já foi encerrada.' };
  }

  // Atualizar pairing
  await db.update(pairings)
    .set({ status: 'accepted', resolvedAt: sqliteNow() })
    .where(eq(pairings.id, pairingId));

  const pairedWith = JSON.stringify([pairing.requesterId, pairing.targetId]);

  // Atualizar estados de ambos
  await db.update(playerRoundState)
    .set({ pairingStatus: 'paired', pairedWith })
    .where(and(eq(playerRoundState.roundId, pairing.roundId), eq(playerRoundState.playerId, pairing.requesterId)));

  await db.update(playerRoundState)
    .set({ pairingStatus: 'paired', pairedWith })
    .where(and(eq(playerRoundState.roundId, pairing.roundId), eq(playerRoundState.playerId, pairing.targetId)));

  // Verificar se grupo está completo
  const groupComplete = await isGroupComplete([pairing.requesterId, pairing.targetId], pairing.roundId);

  await touchRoundGame(pairing.roundId);
  logger.info(`Pairing ${pairingId} aceito. Grupo completo: ${groupComplete}`);
  return { success: true, requesterId: pairing.requesterId, targetId: pairing.targetId, groupComplete };
}

export async function rejectPairing(pairingId: number): Promise<{
  success: boolean;
  requesterId?: number;
  targetId?: number;
  error?: string;
}> {
  const pairing = await db.query.pairings.findFirst({ where: eq(pairings.id, pairingId) });
  if (!pairing || pairing.status !== 'pending') {
    return { success: false, error: 'Convite não encontrado ou já processado.' };
  }

  // Verificar se a rodada ainda está ativa
  const round = await db.query.rounds.findFirst({ where: eq(rounds.id, pairing.roundId) });
  if (!round || round.status !== 'active') {
    return { success: false, error: 'Esta rodada já foi encerrada.' };
  }

  await db.update(pairings)
    .set({ status: 'rejected', resolvedAt: sqliteNow() })
    .where(eq(pairings.id, pairingId));

  // Voltar ambos para unpaired
  await db.update(playerRoundState)
    .set({ pairingStatus: 'unpaired' })
    .where(and(eq(playerRoundState.roundId, pairing.roundId), eq(playerRoundState.playerId, pairing.requesterId)));

  await db.update(playerRoundState)
    .set({ pairingStatus: 'unpaired' })
    .where(and(eq(playerRoundState.roundId, pairing.roundId), eq(playerRoundState.playerId, pairing.targetId)));

  await touchRoundGame(pairing.roundId);
  logger.info(`Pairing ${pairingId} recusado`);
  return { success: true, requesterId: pairing.requesterId, targetId: pairing.targetId };
}

export async function addToGroup(
  roundId: number,
  existingGroupPlayerIds: number[],
  newPlayerId: number
): Promise<{ success: boolean; error?: string }> {
  const targetState = await db.query.playerRoundState.findFirst({
    where: and(eq(playerRoundState.roundId, roundId), eq(playerRoundState.playerId, newPlayerId)),
  });

  if (!targetState || targetState.pairingStatus !== 'unpaired') {
    return { success: false, error: 'Este jogador não está disponível.' };
  }

  const allMembers = [...existingGroupPlayerIds, newPlayerId];
  const pairedWith = JSON.stringify(allMembers);

  // Atualizar todos os membros do grupo
  for (const memberId of allMembers) {
    await db.update(playerRoundState)
      .set({ pairingStatus: 'paired', pairedWith })
      .where(and(eq(playerRoundState.roundId, roundId), eq(playerRoundState.playerId, memberId)));
  }

  // Criar pairing record
  await db.insert(pairings).values({
    roundId,
    requesterId: existingGroupPlayerIds[0],
    targetId: newPlayerId,
    status: 'accepted',
    resolvedAt: sqliteNow(),
  });

  logger.info(`Jogador ${newPlayerId} adicionado ao grupo [${existingGroupPlayerIds}] na rodada ${roundId}`);
  return { success: true };
}

export async function undoPairing(
  roundId: number,
  playerId: number
): Promise<{ success: boolean; affectedPlayerIds?: number[]; error?: string }> {
  const state = await db.query.playerRoundState.findFirst({
    where: and(eq(playerRoundState.roundId, roundId), eq(playerRoundState.playerId, playerId)),
  });

  if (!state || state.pairingStatus !== 'paired' || !state.pairedWith) {
    return { success: false, error: 'Você não está em um grupo.' };
  }

  const groupMembers: number[] = JSON.parse(state.pairedWith);

  // Voltar todos para unpaired e limpar vereditos
  for (const memberId of groupMembers) {
    await db.update(playerRoundState)
      .set({ pairingStatus: 'unpaired', pairedWith: null, verdictActive: 0 })
      .where(and(eq(playerRoundState.roundId, roundId), eq(playerRoundState.playerId, memberId)));
  }

  // Dissolver pairings no DB
  const activePairings = await db.query.pairings.findMany({
    where: and(eq(pairings.roundId, roundId), eq(pairings.status, 'accepted')),
  });

  for (const p of activePairings) {
    if (groupMembers.includes(p.requesterId) || groupMembers.includes(p.targetId)) {
      await db.update(pairings)
        .set({ status: 'dissolved', resolvedAt: sqliteNow() })
        .where(eq(pairings.id, p.id));
    }
  }

  // Se havia uma janela de graça pendente para o espião, cancela — o
  // desfazer de um par re-abre a rodada e as condições de fechamento
  // precisam ser re-avaliadas do zero.
  const { cancelSpyGraceIfActive } = await import('./verdict');
  cancelSpyGraceIfActive(roundId);

  await touchRoundGame(roundId);
  logger.info(`Par desfeito por jogador ${playerId} na rodada ${roundId}. Afetados: [${groupMembers}]`);
  return { success: true, affectedPlayerIds: groupMembers };
}

export async function getExpectedGroupSize(playerIds: number[], roundId: number): Promise<number> {
  const roles = await db.query.roundRoles.findMany({ where: eq(roundRoles.roundId, roundId) });

  for (const memberId of playerIds) {
    const role = roles.find(r => r.playerId === memberId);
    if (role && role.role === 'agent' && role.groupType) {
      return role.groupType === 'trio' ? 3 : 2;
    }
  }

  return 2; // Default: dupla
}

export async function isGroupComplete(playerIds: number[], roundId: number): Promise<boolean> {
  const expectedSize = await getExpectedGroupSize(playerIds, roundId);
  return playerIds.length >= expectedSize;
}

export async function getAvailablePlayers(roundId: number, excludePlayerId: number) {
  const allStates = await db.query.playerRoundState.findMany({
    where: eq(playerRoundState.roundId, roundId),
  });

  return allStates.filter(s =>
    s.playerId !== excludePlayerId &&
    s.pairingStatus === 'unpaired'
  );
}
