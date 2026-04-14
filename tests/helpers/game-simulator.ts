/**
 * Simulador de jogo completo para testes end-to-end.
 * Executa ações na ordem especificada e retorna o estado final.
 */
import { createGame, joinGame, leaveGame, validateGameStart, updateGameStatus, updatePlayerPhoto } from '../../src/engine/lobby';
import { getPlayersInGame } from '../../src/utils/validators';
import { createPairingRequest, acceptPairing } from '../../src/engine/pairing';
import { checkRoundClose } from '../../src/engine/verdict';
import { startNextRound, getPlayerRoundState, getRoundInfo } from '../../src/engine/round';
import { db } from '../../src/db/connection';
import { games, rounds, playerRoundState, roundRoles, players } from '../../src/db/schema';
import { eq, and } from 'drizzle-orm';

export interface PlayerDef {
  userId: number;
  displayName: string;
}

export type LobbyAction =
  | { type: 'join'; userId: number }
  | { type: 'selfie'; userId: number }
  | { type: 'leave'; userId: number };

export type RoundAction =
  | { type: 'pair_request'; fromId: number; toId: number }
  | { type: 'pair_accept'; pairingId: number }
  | { type: 'verdict'; playerId: number };

// ─── Lobby Simulation ──────────────────────────────────────────

/** Cria jogo e executa ações do lobby na ordem dada */
export async function simulateLobby(opts: {
  chatId: number;
  creatorId: number;
  players: PlayerDef[];
  actions: LobbyAction[];
}) {
  const result = await createGame(opts.chatId, opts.creatorId);
  if (!result.success) throw new Error(`createGame falhou: ${result.error}`);
  const gameId = result.gameId!;

  for (const action of opts.actions) {
    const player = opts.players.find(p => p.userId === action.userId);
    if (!player) throw new Error(`Player ${action.userId} não encontrado na lista`);

    switch (action.type) {
      case 'join':
        await joinGame(gameId, player.userId, `user${player.userId}`, player.displayName);
        break;
      case 'selfie':
        await updatePlayerPhoto(gameId, player.userId, `photo_${player.userId}`, `/photos/${player.userId}.jpg`);
        break;
      case 'leave':
        await leaveGame(gameId, player.userId);
        break;
    }
  }

  return { gameId };
}

// ─── Ordering generators ────────────────────────────────────────

/** Todos entram primeiro, depois todas as selfies */
export function orderJoinThenSelfie(playerDefs: PlayerDef[]): LobbyAction[] {
  const actions: LobbyAction[] = [];
  for (const p of playerDefs) actions.push({ type: 'join', userId: p.userId });
  for (const p of playerDefs) actions.push({ type: 'selfie', userId: p.userId });
  return actions;
}

/** Cada jogador entra e manda selfie antes do próximo */
export function orderSequential(playerDefs: PlayerDef[]): LobbyAction[] {
  const actions: LobbyAction[] = [];
  for (const p of playerDefs) {
    actions.push({ type: 'join', userId: p.userId });
    actions.push({ type: 'selfie', userId: p.userId });
  }
  return actions;
}

/** Todos entram, selfies em ordem reversa */
export function orderReverseSelfie(playerDefs: PlayerDef[]): LobbyAction[] {
  const actions: LobbyAction[] = [];
  for (const p of playerDefs) actions.push({ type: 'join', userId: p.userId });
  for (const p of [...playerDefs].reverse()) actions.push({ type: 'selfie', userId: p.userId });
  return actions;
}

/** Intercalado: A entra, B entra, B selfie, A selfie, C entra, D entra, D selfie, C selfie... */
export function orderInterleaved(playerDefs: PlayerDef[]): LobbyAction[] {
  const actions: LobbyAction[] = [];
  for (let i = 0; i < playerDefs.length; i += 2) {
    const a = playerDefs[i];
    const b = playerDefs[i + 1];
    actions.push({ type: 'join', userId: a.userId });
    if (b) {
      actions.push({ type: 'join', userId: b.userId });
      actions.push({ type: 'selfie', userId: b.userId });
    }
    actions.push({ type: 'selfie', userId: a.userId });
  }
  return actions;
}

// ─── Round Simulation ──────────────────────────────────────────

/** Encontra a rodada ativa do jogo */
export async function getActiveRound(gameId: string) {
  return db.query.rounds.findFirst({
    where: and(eq(rounds.gameId, gameId), eq(rounds.status, 'active')),
  });
}

/** Busca o player DB id a partir do userId */
async function getDbPlayerId(gameId: string, userId: number): Promise<number> {
  const p = await db.query.players.findFirst({
    where: and(eq(players.gameId, gameId), eq(players.userId, userId), eq(players.isActive, 1)),
  });
  if (!p) throw new Error(`Player ${userId} não encontrado no jogo ${gameId}`);
  return p.id;
}

/** Retorna os grupos corretos (duplas/trios de agentes) definidos pelo bot */
export async function getCorrectGroups(roundId: number): Promise<Map<number, number[]>> {
  const roles = await db.query.roundRoles.findMany({ where: eq(roundRoles.roundId, roundId) });
  const groupMap = new Map<number, number[]>();
  for (const r of roles) {
    if (r.role === 'agent' && r.assignedGroup != null) {
      if (!groupMap.has(r.assignedGroup)) groupMap.set(r.assignedGroup, []);
      groupMap.get(r.assignedGroup)!.push(r.playerId);
    }
  }
  return groupMap;
}

/** Retorna o spy DB id da rodada */
export async function getSpyId(roundId: number): Promise<number> {
  const round = await db.query.rounds.findFirst({ where: eq(rounds.id, roundId) });
  return round!.spyPlayerId;
}

/** Simula pareamento e veredito de um grupo de agentes */
export async function pairAndVerdict(roundId: number, groupPlayerIds: number[]) {
  if (groupPlayerIds.length < 2) return;

  // Primeiro par: request + accept
  const pairingId = await createPairingRequest(roundId, groupPlayerIds[0], groupPlayerIds[1]);
  await acceptPairing(pairingId);

  // Se trio, adicionar terceiro
  if (groupPlayerIds.length >= 3) {
    const { addToGroup } = await import('../../src/engine/pairing');
    await addToGroup(roundId, [groupPlayerIds[0], groupPlayerIds[1]], groupPlayerIds[2]);
  }

  // Veredito de cada membro
  for (const pid of groupPlayerIds) {
    await db.update(playerRoundState)
      .set({ verdictActive: 1 })
      .where(and(eq(playerRoundState.roundId, roundId), eq(playerRoundState.playerId, pid)));
  }
}

/** Simula uma rodada completa: pareamento na ordem dada + vereditos */
export async function simulateRound(
  roundId: number,
  groupOrder: 'sequential' | 'reverse',
  api: any,
): Promise<void> {
  const groups = await getCorrectGroups(roundId);
  const groupList = Array.from(groups.values());
  const ordered = groupOrder === 'reverse' ? [...groupList].reverse() : groupList;

  for (const group of ordered) {
    await pairAndVerdict(roundId, group);
  }

  await checkRoundClose(roundId, api);
}

/** Gera PlayerDefs para N jogadores */
export function makePlayers(count: number, startUserId: number = 30000): PlayerDef[] {
  return Array.from({ length: count }, (_, i) => ({
    userId: startUserId + i,
    displayName: `P${i + 1}`,
  }));
}
