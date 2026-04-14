import { db } from '../../src/db/connection';
import { games, players, rounds, roundRoles, playerRoundState } from '../../src/db/schema';

let gameSeq = 0;
let userSeq = 1000;

export async function createTestGame(overrides: Record<string, any> = {}) {
  const id = overrides.id ?? `game_test_${++gameSeq}`;
  const data = {
    id,
    chatId: overrides.chatId ?? -(1000 + gameSeq),
    creatorId: overrides.creatorId ?? 9999,
    mode: overrides.mode ?? 'auto',
    totalRounds: overrides.totalRounds ?? 5,
    currentRound: overrides.currentRound ?? 0,
    status: overrides.status ?? 'lobby',
  };
  await db.insert(games).values(data);
  return data;
}

export async function createTestPlayer(gameId: string, overrides: Record<string, any> = {}) {
  const userId = overrides.userId ?? ++userSeq;
  const data = {
    gameId,
    userId,
    username: overrides.username ?? `user${userId}`,
    displayName: overrides.displayName ?? `Player${userId}`,
    photoFileId: overrides.photoFileId ?? null,
    photoPath: overrides.photoPath ?? null,
    totalScore: overrides.totalScore ?? 0,
    isActive: overrides.isActive ?? 1,
  };
  const [result] = await db.insert(players).values(data).returning();
  return result;
}

export async function createTestRound(gameId: string, overrides: Record<string, any> = {}) {
  const data = {
    gameId,
    roundNumber: overrides.roundNumber ?? 1,
    locationKey: overrides.locationKey ?? 'test_hospital',
    locationName: overrides.locationName ?? 'Hospital',
    spyHint: overrides.spyHint ?? 'Pulso',
    spyPlayerId: overrides.spyPlayerId,
    status: overrides.status ?? 'active',
  };
  const [result] = await db.insert(rounds).values(data).returning();
  return result;
}

export async function createTestRoundRole(roundId: number, playerId: number, overrides: Record<string, any> = {}) {
  const data = {
    roundId,
    playerId,
    role: overrides.role ?? 'agent',
    characterName: overrides.characterName ?? 'Médico',
    assignedGroup: overrides.assignedGroup ?? null,
    groupType: overrides.groupType ?? null,
  };
  const [result] = await db.insert(roundRoles).values(data).returning();
  return result;
}

export async function createTestPlayerRoundState(roundId: number, playerId: number, overrides: Record<string, any> = {}) {
  const data = {
    roundId,
    playerId,
    pairingStatus: overrides.pairingStatus ?? 'unpaired',
    pairedWith: overrides.pairedWith ?? null,
    verdictActive: overrides.verdictActive ?? 0,
    roundScore: overrides.roundScore ?? 0,
  };
  const [result] = await db.insert(playerRoundState).values(data).returning();
  return result;
}

/** Monta um cenário completo: jogo + N jogadores + rodada + roles + states */
export async function createFullRoundScenario(opts: {
  playerCount: number;
  spyIndex?: number;
  gameOverrides?: Record<string, any>;
}) {
  const game = await createTestGame({
    status: 'round_active',
    currentRound: 1,
    ...opts.gameOverrides,
  });

  const testPlayers = [];
  for (let i = 0; i < opts.playerCount; i++) {
    const p = await createTestPlayer(game.id, { photoFileId: `photo_${i}` });
    testPlayers.push(p);
  }

  const spyIdx = opts.spyIndex ?? 0;
  const spyPlayer = testPlayers[spyIdx];

  const round = await createTestRound(game.id, { spyPlayerId: spyPlayer.id });

  // Calcular grupos de agentes
  const agents = testPlayers.filter((_, i) => i !== spyIdx);
  let groupNum = 1;
  const agentGroups: { playerId: number; group: number; type: 'duo' | 'trio' }[] = [];

  if (agents.length % 2 === 0) {
    for (let i = 0; i < agents.length; i += 2) {
      agentGroups.push({ playerId: agents[i].id, group: groupNum, type: 'duo' });
      agentGroups.push({ playerId: agents[i + 1].id, group: groupNum, type: 'duo' });
      groupNum++;
    }
  } else {
    agentGroups.push({ playerId: agents[0].id, group: groupNum, type: 'trio' });
    agentGroups.push({ playerId: agents[1].id, group: groupNum, type: 'trio' });
    agentGroups.push({ playerId: agents[2].id, group: groupNum, type: 'trio' });
    groupNum++;
    for (let i = 3; i < agents.length; i += 2) {
      agentGroups.push({ playerId: agents[i].id, group: groupNum, type: 'duo' });
      agentGroups.push({ playerId: agents[i + 1].id, group: groupNum, type: 'duo' });
      groupNum++;
    }
  }

  // Criar roles
  for (const p of testPlayers) {
    const isSpy = p.id === spyPlayer.id;
    const ag = agentGroups.find(a => a.playerId === p.id);
    await createTestRoundRole(round.id, p.id, {
      role: isSpy ? 'spy' : 'agent',
      characterName: isSpy ? 'Intruso' : `Char${p.id}`,
      assignedGroup: isSpy ? null : ag?.group,
      groupType: isSpy ? null : ag?.type,
    });
  }

  // Criar player_round_state
  const states = [];
  for (const p of testPlayers) {
    const s = await createTestPlayerRoundState(round.id, p.id);
    states.push(s);
  }

  return { game, players: testPlayers, spyPlayer, round, states };
}
