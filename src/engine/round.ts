import { eq, and } from 'drizzle-orm';
import { db } from '../db/connection';
import { games, players, rounds, roundRoles, playerRoundState } from '../db/schema';
import { getPlayersInGame } from '../utils/validators';
import { messages } from '../utils/messages';
import { logger } from '../utils/logger';
import { shuffle, calculateGroups } from './groups';
import { cleanupGameData } from './cleanup';
import { sqliteNow } from './lobby';
import type { Api } from 'grammy';

export { calculateGroups } from './groups';

export async function startNextRound(gameId: string, api: Api): Promise<void> {
  try {
    const game = await db.query.games.findFirst({ where: eq(games.id, gameId) });
    if (!game) throw new Error(`Jogo ${gameId} não encontrado`);

    const newRound = game.currentRound + 1;

    if (newRound > game.totalRounds) {
      // Fim do jogo
      const activePlayers = await getPlayersInGame(gameId);
      const sorted = [...activePlayers].sort((a, b) => b.totalScore - a.totalScore);
      const leaderboard = sorted.map((p, i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
        return `${medal} ${p.displayName}: *${p.totalScore}* pts`;
      }).join('\n');
      await api.sendMessage(game.chatId, messages.finalResult(leaderboard), { parse_mode: 'Markdown' });
      logger.info(`Jogo ${gameId} finalizado!`);
      await cleanupGameData(gameId);
      return;
    }

    // Modo manual: enviar prompt ao configurador e aguardar
    if (game.mode === 'manual') {
      try {
        await api.sendMessage(game.creatorId,
          messages.manualConfigStart(newRound) + '\n\n' + messages.manualLocationPrompt,
          { parse_mode: 'Markdown' }
        );
        // O configurador vai responder via text handler (conversations.ts)
        // Definir session step não é possível aqui, então mandamos instrução
        // O text handler vai detectar pelo estado do jogo
        logger.info(`Modo manual: aguardando configurador ${game.creatorId} para rodada ${newRound}`);
      } catch (error) {
        logger.error(`Erro ao contactar configurador: ${error}`);
        await api.sendMessage(game.chatId, '⚠️ Não consegui enviar DM ao configurador. Verifique se ele iniciou conversa comigo.');
      }
      return;
    }

    // ─── Modo automático ─────────────────────────────────

    // Atualizar rodada
    await db.update(games).set({
      currentRound: newRound,
      status: 'round_active',
      updatedAt: sqliteNow(),
    }).where(eq(games.id, gameId));

    const activePlayers = await getPlayersInGame(gameId);
    const playerIds = activePlayers.map(p => p.id);

    // Selecionar espião aleatório
    const spyPlayerId = shuffle(playerIds)[0];

    // Carregar locais
    let locations: any[];
    try {
      const locData = await import('../data/locations.json');
      locations = locData.locations || locData.default?.locations || [];
    } catch {
      // Fallback mínimo
      locations = [{
        key: 'fallback_hospital',
        name: 'Hospital',
        category: 'real',
        spy_hint: 'Pulso',
        characters: ['Cirurgião', 'Enfermeira-Chefe', 'Paciente', 'Anestesista', 'Recepcionista', 'Paramédico', 'Nutricionista', 'Faxineiro', 'Visitante', 'Residente', 'Farmacêutico', 'Voluntário'],
      }];
    }

    // Evitar locais já usados
    const usedRounds = await db.query.rounds.findMany({
      where: eq(rounds.gameId, gameId),
    });
    const usedKeys = new Set(usedRounds.map(r => r.locationKey));
    const availableLocations = locations.filter((l: any) => !usedKeys.has(l.key));
    const location = availableLocations.length > 0
      ? shuffle(availableLocations)[0]
      : shuffle(locations)[0];

    // Criar rodada no DB
    const [round] = await db.insert(rounds).values({
      gameId,
      roundNumber: newRound,
      locationKey: location.key,
      locationName: location.name,
      spyHint: location.spy_hint,
      spyPlayerId,
      status: 'active',
    }).returning();

    // Calcular grupos
    const groupAssignment = calculateGroups(playerIds, spyPlayerId);

    // Validar que o local tem personagens suficientes para os agentes
    const numAgents = activePlayers.length - 1;
    if (!location.characters || location.characters.length < numAgents) {
      logger.warn(`Local "${location.name}" tem apenas ${location.characters?.length ?? 0} personagens, precisava de ${numAgents}. Usando fallback.`);
      // Preencher com personagens genéricos
      while (location.characters.length < numAgents) {
        location.characters.push(`Agente ${location.characters.length + 1}`);
      }
    }

    // Atribuir personagens
    const shuffledChars = shuffle([...location.characters]);
    let charIndex = 0;

    const characterAssignments = new Map<number, string>();
    const groupAssignmentMap = new Map<number, { group: number; type: 'duo' | 'trio' }>();

    for (let gi = 0; gi < groupAssignment.groups.length; gi++) {
      const group = groupAssignment.groups[gi];
      const groupType = groupAssignment.groupTypes[gi];
      for (const pid of group) {
        characterAssignments.set(pid, shuffledChars[charIndex++]);
        groupAssignmentMap.set(pid, { group: gi + 1, type: groupType });
      }
    }

    // Espião recebe disfarce de "Intruso"
    const spyDisguise = 'Intruso';

    // Inserir round_roles e player_round_state
    for (const player of activePlayers) {
      const isSpy = player.id === spyPlayerId;
      const ga = groupAssignmentMap.get(player.id);

      await db.insert(roundRoles).values({
        roundId: round.id,
        playerId: player.id,
        role: isSpy ? 'spy' : 'agent',
        characterName: isSpy ? spyDisguise : (characterAssignments.get(player.id) || 'Agente'),
        assignedGroup: isSpy ? null : (ga?.group ?? null),
        groupType: isSpy ? null : (ga?.type ?? null),
      });

      await db.insert(playerRoundState).values({
        roundId: round.id,
        playerId: player.id,
        pairingStatus: 'unpaired',
        pairedWith: null,
        verdictActive: 0,
        roundScore: 0,
      });
    }

    // Enviar DMs
    for (const player of activePlayers) {
      const isSpy = player.id === spyPlayerId;

      try {
        if (isSpy) {
          await api.sendMessage(player.userId, messages.spyDm(newRound, game.totalRounds, location.spy_hint, spyDisguise), {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🕵️ Chutar Local', callback_data: `spy_guess_btn:${round.id}` }],
                [{ text: '🤝 Solicitar Par', callback_data: `pair_list:${round.id}` }],
                [{ text: '📋 Ver Meu Papel', callback_data: `view_role:${round.id}` }],
                [{ text: '📊 Ver Situação', callback_data: `view_status:${round.id}` }],
              ],
            },
          });
        } else {
          // Encontrar parceiros no grupo
          const ga = groupAssignmentMap.get(player.id);
          let partnerInfo = '';
          if (ga) {
            const groupMembers = groupAssignment.groups[ga.group - 1];
            const partners = groupMembers.filter(pid => pid !== player.id);
            const partnerChars = partners.map(pid => `"${characterAssignments.get(pid)}"`);
            if (ga.type === 'duo') {
              partnerInfo = `Seu grupo (dupla): Procure o ${partnerChars[0]}`;
            } else {
              partnerInfo = `Seu grupo (trio): Procure o ${partnerChars.join(' e o ')}`;
            }
          }

          await api.sendMessage(player.userId, messages.agentDm(newRound, game.totalRounds, location.name, characterAssignments.get(player.id) || 'Agente', partnerInfo), {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🤝 Solicitar Par', callback_data: `pair_list:${round.id}` }],
                [{ text: '📋 Ver Meu Papel', callback_data: `view_role:${round.id}` }],
                [{ text: '📊 Ver Situação', callback_data: `view_status:${round.id}` }],
              ],
            },
          });
        }
      } catch (error) {
        logger.error(`Erro ao enviar DM para jogador ${player.userId}: ${error}`);
      }
    }

    // Anunciar no grupo
    await api.sendMessage(game.chatId, messages.roundStartGroup(newRound, game.totalRounds), { parse_mode: 'Markdown' });

    logger.info(`Rodada ${newRound} iniciada para jogo ${gameId}, local: ${location.name}, espião: player_id=${spyPlayerId}`);
  } catch (error) {
    logger.error(`Erro ao iniciar rodada: ${error}`);
    throw error;
  }
}

export async function startManualRound(
  gameId: string,
  locationName: string,
  spyHint: string,
  groupsChars: string[][],
  api: Api
): Promise<void> {
  try {
    const game = await db.query.games.findFirst({ where: eq(games.id, gameId) });
    if (!game) throw new Error(`Jogo ${gameId} não encontrado`);

    const newRound = game.currentRound + 1;

    await db.update(games).set({
      currentRound: newRound,
      status: 'round_active',
      updatedAt: sqliteNow(),
    }).where(eq(games.id, gameId));

    const activePlayers = await getPlayersInGame(gameId);
    const playerIds = activePlayers.map(p => p.id);

    // Espião aleatório
    const spyPlayerId = shuffle(playerIds)[0];

    // Criar rodada no DB
    const [round] = await db.insert(rounds).values({
      gameId,
      roundNumber: newRound,
      locationKey: `manual_${newRound}`,
      locationName,
      spyHint,
      spyPlayerId,
      status: 'active',
    }).returning();

    // Montar grupos a partir dos personagens fornecidos
    const agentIds = playerIds.filter(id => id !== spyPlayerId);
    const shuffledAgents = shuffle(agentIds);

    const characterAssignments = new Map<number, string>();
    const groupAssignmentMap = new Map<number, { group: number; type: 'duo' | 'trio' }>();
    let agentIndex = 0;

    for (let gi = 0; gi < groupsChars.length; gi++) {
      const chars = groupsChars[gi];
      const groupType: 'duo' | 'trio' = chars.length === 3 ? 'trio' : 'duo';
      const shuffledChars = shuffle([...chars]);

      for (let ci = 0; ci < chars.length && agentIndex < shuffledAgents.length; ci++) {
        const pid = shuffledAgents[agentIndex++];
        characterAssignments.set(pid, shuffledChars[ci]);
        groupAssignmentMap.set(pid, { group: gi + 1, type: groupType });
      }
    }

    const spyDisguise = 'Intruso';

    // Inserir roles e states
    for (const player of activePlayers) {
      const isSpy = player.id === spyPlayerId;
      const ga = groupAssignmentMap.get(player.id);

      await db.insert(roundRoles).values({
        roundId: round.id,
        playerId: player.id,
        role: isSpy ? 'spy' : 'agent',
        characterName: isSpy ? spyDisguise : (characterAssignments.get(player.id) || 'Agente'),
        assignedGroup: isSpy ? null : (ga?.group ?? null),
        groupType: isSpy ? null : (ga?.type ?? null),
      });

      await db.insert(playerRoundState).values({
        roundId: round.id,
        playerId: player.id,
        pairingStatus: 'unpaired',
        pairedWith: null,
        verdictActive: 0,
        roundScore: 0,
      });
    }

    // Enviar DMs
    for (const player of activePlayers) {
      const isSpy = player.id === spyPlayerId;
      try {
        if (isSpy) {
          await api.sendMessage(player.userId, messages.spyDm(newRound, game.totalRounds, spyHint, spyDisguise), {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🕵️ Chutar Local', callback_data: `spy_guess_btn:${round.id}` }],
                [{ text: '🤝 Solicitar Par', callback_data: `pair_list:${round.id}` }],
                [{ text: '📋 Ver Meu Papel', callback_data: `view_role:${round.id}` }],
                [{ text: '📊 Ver Situação', callback_data: `view_status:${round.id}` }],
              ],
            },
          });
        } else {
          const ga = groupAssignmentMap.get(player.id);
          let partnerInfo = '';
          if (ga) {
            const partnersInGroup = [...characterAssignments.entries()]
              .filter(([pid]) => {
                const pga = groupAssignmentMap.get(pid);
                return pga && pga.group === ga.group && pid !== player.id;
              })
              .map(([, char]) => `"${char}"`);

            if (ga.type === 'duo') {
              partnerInfo = `Seu grupo (dupla): Procure o ${partnersInGroup[0] || '?'}`;
            } else {
              partnerInfo = `Seu grupo (trio): Procure o ${partnersInGroup.join(' e o ')}`;
            }
          }

          await api.sendMessage(player.userId, messages.agentDm(newRound, game.totalRounds, locationName, characterAssignments.get(player.id) || 'Agente', partnerInfo), {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🤝 Solicitar Par', callback_data: `pair_list:${round.id}` }],
                [{ text: '📋 Ver Meu Papel', callback_data: `view_role:${round.id}` }],
                [{ text: '📊 Ver Situação', callback_data: `view_status:${round.id}` }],
              ],
            },
          });
        }
      } catch (error) {
        logger.error(`Erro ao enviar DM manual para ${player.userId}: ${error}`);
      }
    }

    // Salvar config manual
    await db.insert((await import('../db/schema')).manualConfigs).values({
      roundId: round.id,
      configuratorId: game.creatorId,
      locationName,
      spyHint,
      groupsCharactersJson: JSON.stringify(groupsChars),
    });

    await api.sendMessage(game.chatId, messages.roundStartGroup(newRound, game.totalRounds), { parse_mode: 'Markdown' });
    logger.info(`Rodada manual ${newRound} iniciada para jogo ${gameId}`);
  } catch (error) {
    logger.error(`Erro ao iniciar rodada manual: ${error}`);
    throw error;
  }
}

export async function getRoundInfo(roundId: number) {
  return db.query.rounds.findFirst({ where: eq(rounds.id, roundId) }) ?? null;
}

export async function getRoundRolesForRound(roundId: number) {
  return db.query.roundRoles.findMany({ where: eq(roundRoles.roundId, roundId) });
}

export async function getPlayerRoundStates(roundId: number) {
  return db.query.playerRoundState.findMany({ where: eq(playerRoundState.roundId, roundId) });
}

export async function getPlayerRoundState(roundId: number, playerId: number) {
  return db.query.playerRoundState.findFirst({
    where: and(eq(playerRoundState.roundId, roundId), eq(playerRoundState.playerId, playerId)),
  }) ?? null;
}
