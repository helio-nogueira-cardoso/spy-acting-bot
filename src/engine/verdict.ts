import { eq, and } from 'drizzle-orm';
import { db } from '../db/connection';
import { rounds, roundRoles, playerRoundState, players, games, spyGuessVotes } from '../db/schema';
import { getPlayersInGame } from '../utils/validators';
import { messages } from '../utils/messages';
import { logger } from '../utils/logger';
import { isSpyGuessCorrect, calculateRoundScores } from './scoring';
import { startNextRound } from './round';
import { cleanupGameData } from './cleanup';
import { sqliteNow, touchGameActivity } from './lobby';
import type { Api } from 'grammy';

export async function submitSpyGuess(roundId: number, playerId: number, guess: string): Promise<void> {
  const round = await db.query.rounds.findFirst({ where: eq(rounds.id, roundId) });
  if (round) await touchGameActivity(round.gameId);

  await db.update(rounds)
    .set({ spyGuess: guess })
    .where(eq(rounds.id, roundId));

  // Marcar veredito
  await db.update(playerRoundState)
    .set({ verdictActive: 1 })
    .where(and(eq(playerRoundState.roundId, roundId), eq(playerRoundState.playerId, playerId)));

  logger.info(`Espião (player=${playerId}) chutou "${guess}" na rodada ${roundId}`);
}

export async function checkRoundClose(roundId: number, api: Api): Promise<void> {
  const round = await db.query.rounds.findFirst({ where: eq(rounds.id, roundId) });
  if (!round || round.status !== 'active') return;

  const game = await db.query.games.findFirst({ where: eq(games.id, round.gameId) });
  if (!game) return;

  const activePlayers = await getPlayersInGame(round.gameId);
  const allStates = await db.query.playerRoundState.findMany({
    where: eq(playerRoundState.roundId, roundId),
  });

  const activePlayerIds = new Set(activePlayers.map(p => p.id));
  const activeStates = allStates.filter(s => activePlayerIds.has(s.playerId));

  // Separar jogadores pareados dos isolados (sem par)
  const pairedStates = activeStates.filter(s => s.pairingStatus === 'paired');
  const pendingStates = activeStates.filter(s => s.pairingStatus === 'pending_sent' || s.pairingStatus === 'pending_received');
  const unpairedStates = activeStates.filter(s => s.pairingStatus === 'unpaired');

  // Não fechar se há pareamentos pendentes
  if (pendingStates.length > 0) return;

  // Rodada fecha quando todos os pareados deram veredito e sobra no máximo 1 isolado
  const allPairedVerdicted = pairedStates.length > 0 && pairedStates.every(s => s.verdictActive === 1);
  const roundReady = allPairedVerdicted && unpairedStates.length <= 1;

  if (!roundReady) {
    // Notificar quantos faltam (só pareados sem veredito)
    const pending = pairedStates.filter(s => !s.verdictActive);
    const pendingNames = pending.map(s => {
      const p = activePlayers.find(pl => pl.id === s.playerId);
      return p?.displayName || '???';
    });

    if (pending.length <= 3 && pending.length > 0) {
      await api.sendMessage(game.chatId, messages.missingVerdicts(pendingNames), { parse_mode: 'Markdown' });
    }
    return;
  }

  // Auto-marcar veredito do jogador isolado (não teve interação para votar)
  for (const isolated of unpairedStates) {
    await db.update(playerRoundState)
      .set({ verdictActive: 1 })
      .where(and(eq(playerRoundState.roundId, roundId), eq(playerRoundState.playerId, isolated.playerId)));
  }

  // TODOS confirmaram — processar fechamento
  logger.info(`Rodada ${roundId} - todos vereditos confirmados. Processando...`);

  // Verificar chute do espião
  const spyGuessApproved = await resolveSpyGuess(roundId, game, api);

  // Calcular pontuação
  await calculateAndDisplayResults(roundId, game, spyGuessApproved, api);
}

async function resolveSpyGuess(roundId: number, game: any, api: Api): Promise<boolean> {
  const round = await db.query.rounds.findFirst({ where: eq(rounds.id, roundId) });
  if (!round) return false;

  const spyGuess = round.spyGuess;
  if (!spyGuess) {
    // Espião não chutou
    await db.update(rounds).set({ spyGuessApproved: 0 }).where(eq(rounds.id, roundId));
    return false;
  }

  // Etapa 1: Comparação automática
  if (isSpyGuessCorrect(spyGuess, round.locationName)) {
    await db.update(rounds).set({ spyGuessApproved: 1 }).where(eq(rounds.id, roundId));
    logger.info(`Chute do espião aprovado automaticamente: "${spyGuess}" = "${round.locationName}"`);
    return true;
  }

  // Etapa 2: Votação fair play ou decisão manual
  if (game.mode === 'manual') {
    // Modo manual: enviar para configurador
    await api.sendMessage(game.creatorId, messages.manualSpyGuessDecision(spyGuess, round.locationName), {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Sim, aceitar', callback_data: `manual_spy_yes:${roundId}` },
            { text: '❌ Não, invalidar', callback_data: `manual_spy_no:${roundId}` },
          ],
        ],
      },
    });

    // Aguardar decisão (será resolvido via callback)
    // Por enquanto, considerar como pendente — o cálculo será feito ao receber o callback
    // Para simplificar, vamos aguardar com timeout
    return await waitForManualDecision(roundId, 180_000);
  }

  // Modo automático: votação fair play
  logger.info(`Chute do espião difere: "${spyGuess}" ≠ "${round.locationName}". Iniciando votação.`);

  await api.sendMessage(game.chatId, messages.fairPlayVote(spyGuess, round.locationName), {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Sim, aceitar', callback_data: `vote_spy_yes:${roundId}` },
          { text: '❌ Não, invalidar', callback_data: `vote_spy_no:${roundId}` },
        ],
      ],
    },
  });

  // Aguardar votação por 60 segundos
  return await waitForVotingResult(roundId, 60_000);
}

async function waitForVotingResult(roundId: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const checkInterval = setInterval(async () => {
      // Verificar se já existe resultado
      const round = await db.query.rounds.findFirst({ where: eq(rounds.id, roundId) });
      if (round && round.spyGuessApproved !== null) {
        clearInterval(checkInterval);
        resolve(round.spyGuessApproved === 1);
      }
    }, 2000);

    setTimeout(async () => {
      clearInterval(checkInterval);

      // Verificar se já foi decidido
      const round = await db.query.rounds.findFirst({ where: eq(rounds.id, roundId) });
      if (round && round.spyGuessApproved !== null) {
        resolve(round.spyGuessApproved === 1);
        return;
      }

      // Contar votos
      const votes = await db.query.spyGuessVotes.findMany({
        where: eq(spyGuessVotes.roundId, roundId),
      });

      if (votes.length === 0) {
        await db.update(rounds).set({ spyGuessApproved: 0 }).where(eq(rounds.id, roundId));
        logger.info(`Votação rodada ${roundId}: nenhum voto. Chute invalidado.`);
        resolve(false);
        return;
      }

      const yesVotes = votes.filter(v => v.vote === 1).length;
      const noVotes = votes.filter(v => v.vote === 0).length;
      const approved = yesVotes >= noVotes && yesVotes > 0;

      await db.update(rounds).set({ spyGuessApproved: approved ? 1 : 0 }).where(eq(rounds.id, roundId));
      logger.info(`Votação rodada ${roundId}: ${yesVotes} sim / ${noVotes} não → ${approved ? 'aprovado' : 'rejeitado'}`);
      resolve(approved);
    }, timeoutMs);
  });
}

async function waitForManualDecision(roundId: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const checkInterval = setInterval(async () => {
      const round = await db.query.rounds.findFirst({ where: eq(rounds.id, roundId) });
      if (round && round.spyGuessApproved !== null) {
        clearInterval(checkInterval);
        resolve(round.spyGuessApproved === 1);
      }
    }, 2000);

    setTimeout(async () => {
      clearInterval(checkInterval);
      const round = await db.query.rounds.findFirst({ where: eq(rounds.id, roundId) });
      if (round && round.spyGuessApproved !== null) {
        resolve(round.spyGuessApproved === 1);
        return;
      }
      // Timeout: invalidar
      await db.update(rounds).set({ spyGuessApproved: 0 }).where(eq(rounds.id, roundId));
      resolve(false);
    }, timeoutMs);
  });
}

export async function resolveSpyGuessManual(roundId: number, approved: boolean, api: Api): Promise<void> {
  await db.update(rounds).set({ spyGuessApproved: approved ? 1 : 0 }).where(eq(rounds.id, roundId));
  logger.info(`Configurador decidiu: chute ${approved ? 'aprovado' : 'rejeitado'} na rodada ${roundId}`);
}

export async function registerVote(
  roundId: number,
  playerId: number,
  vote: number
): Promise<{ success: boolean; error?: string }> {
  // Verificar se é agente (espião não vota)
  const role = await db.query.roundRoles.findFirst({
    where: and(eq(roundRoles.roundId, roundId), eq(roundRoles.playerId, playerId)),
  });

  if (role?.role === 'spy') {
    return { success: false, error: 'O espião não pode votar!' };
  }

  // Verificar voto duplicado
  const existing = await db.query.spyGuessVotes.findFirst({
    where: and(eq(spyGuessVotes.roundId, roundId), eq(spyGuessVotes.voterPlayerId, playerId)),
  });

  if (existing) {
    return { success: false, error: 'Você já votou!' };
  }

  await db.insert(spyGuessVotes).values({
    roundId,
    voterPlayerId: playerId,
    vote,
  });

  logger.info(`Voto registrado: jogador ${playerId}, voto=${vote}, rodada ${roundId}`);
  return { success: true };
}

async function calculateAndDisplayResults(
  roundId: number,
  game: any,
  spyGuessApproved: boolean,
  api: Api
): Promise<void> {
  const round = await db.query.rounds.findFirst({ where: eq(rounds.id, roundId) });
  if (!round) return;

  // Buscar roles
  const allRoles = await db.query.roundRoles.findMany({ where: eq(roundRoles.roundId, roundId) });
  const allStates = await db.query.playerRoundState.findMany({ where: eq(playerRoundState.roundId, roundId) });
  const activePlayers = await getPlayersInGame(game.id);

  // Grupos corretos (definidos pelo bot)
  const agentRoles = allRoles.filter(r => r.role === 'agent' && r.assignedGroup !== null);
  const correctGroupMap = new Map<number, number[]>();
  for (const r of agentRoles) {
    const group = r.assignedGroup!;
    if (!correctGroupMap.has(group)) correctGroupMap.set(group, []);
    correctGroupMap.get(group)!.push(r.playerId);
  }
  const correctGroups = Array.from(correctGroupMap.values());

  // Grupos formados pelos jogadores
  const formedGroupSet = new Set<string>();
  const formedGroups: number[][] = [];

  for (const state of allStates) {
    if (state.pairedWith) {
      const group: number[] = JSON.parse(state.pairedWith);
      const key = group.sort((a, b) => a - b).join(',');
      if (!formedGroupSet.has(key)) {
        formedGroupSet.add(key);
        formedGroups.push(group);
      }
    }
  }

  // Calcular pontuação
  const scores = calculateRoundScores({
    correctGroups,
    formedGroups,
    spyPlayerId: round.spyPlayerId,
    spyGuessApproved,
  });

  // Atualizar pontuações no DB
  for (const [playerId, score] of scores) {
    await db.update(playerRoundState)
      .set({ roundScore: score })
      .where(and(eq(playerRoundState.roundId, roundId), eq(playerRoundState.playerId, playerId)));

    // Atualizar pontuação total
    const player = activePlayers.find(p => p.id === playerId);
    if (player) {
      await db.update(players)
        .set({ totalScore: player.totalScore + score })
        .where(eq(players.id, playerId));
    }
  }

  // Fechar rodada
  await db.update(rounds)
    .set({ status: 'closed', endedAt: new Date().toISOString() })
    .where(eq(rounds.id, roundId));

  await db.update(games)
    .set({ status: 'round_ended', updatedAt: sqliteNow() })
    .where(eq(games.id, game.id));

  // Montar mensagem de resultado
  const spyPlayer = activePlayers.find(p => p.id === round.spyPlayerId);

  // Grupos corretos formatados
  const correctGroupsStr = correctGroups.map((group, i) => {
    const roleInfos = group.map(pid => {
      const role = allRoles.find(r => r.playerId === pid);
      return role?.characterName || '?';
    });
    const groupType = allRoles.find(r => r.playerId === group[0])?.groupType || 'duo';
    return `  ${groupType === 'trio' ? 'Trio' : `Dupla ${i + 1}`}: ${roleInfos.join(' + ')}`;
  }).join('\n');

  // Grupos formados formatados
  const formedGroupsStr = formedGroups.map(group => {
    const memberInfos = group.map(pid => {
      const p = activePlayers.find(pl => pl.id === pid);
      const role = allRoles.find(r => r.playerId === pid);
      const isSpy = pid === round.spyPlayerId;
      return `${p?.displayName || '?'} (${role?.characterName || '?'}${isSpy ? ' 🕵️' : ''})`;
    });
    return `  ${memberInfos.join(' + ')}`;
  }).join('\n');

  // Jogadores isolados
  const pairedPlayerIds = new Set(formedGroups.flat());
  const isolated = activePlayers.filter(p => !pairedPlayerIds.has(p.id));
  const isolatedStr = isolated.map(p => {
    const isSpy = p.id === round.spyPlayerId;
    return `  ${p.displayName}${isSpy ? ' (Espião 🕵️)' : ''} ficou isolado`;
  }).join('\n');

  // Pontuação da rodada
  const scoresStr = activePlayers.map(p => {
    const score = scores.get(p.id) || 0;
    return `  ${p.displayName}: *${score > 0 ? '+' : ''}${score}*`;
  }).join('\n');

  // Placar acumulado (recarregar do DB)
  const updatedPlayers = await getPlayersInGame(game.id);
  const sorted = [...updatedPlayers].sort((a, b) => b.totalScore - a.totalScore);
  const leaderboard = sorted.map((p, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
    return `${medal} ${p.displayName}: *${p.totalScore}* pts`;
  }).join('\n');

  // Resultado do chute
  let spyGuessResult = '';
  const votes = await db.query.spyGuessVotes.findMany({ where: eq(spyGuessVotes.roundId, roundId) });

  if (round.spyGuess) {
    if (isSpyGuessCorrect(round.spyGuess, round.locationName)) {
      spyGuessResult = '✅ (aprovado automaticamente)';
    } else if (spyGuessApproved) {
      const yesVotes = votes.filter(v => v.vote === 1).length;
      const noVotes = votes.filter(v => v.vote === 0).length;
      spyGuessResult = game.mode === 'manual'
        ? '✅ (aprovado pelo configurador)'
        : `✅ (aprovado por votação: ${yesVotes} sim / ${noVotes} não)`;
    } else {
      const yesVotes = votes.filter(v => v.vote === 1).length;
      const noVotes = votes.filter(v => v.vote === 0).length;
      if (votes.length === 0 && !isSpyGuessCorrect(round.spyGuess, round.locationName)) {
        spyGuessResult = game.mode === 'manual'
          ? '❌ (rejeitado pelo configurador)'
          : '❌ (nenhum voto — invalidado)';
      } else {
        spyGuessResult = game.mode === 'manual'
          ? '❌ (rejeitado pelo configurador)'
          : `❌ (rejeitado: ${yesVotes} sim / ${noVotes} não)`;
      }
    }
  }

  await api.sendMessage(game.chatId, messages.roundResult({
    roundNumber: round.roundNumber,
    totalRounds: game.totalRounds,
    location: round.locationName,
    spyName: spyPlayer?.displayName || '???',
    spyHint: round.spyHint,
    spyGuess: round.spyGuess,
    spyGuessResult,
    correctGroups: correctGroupsStr,
    formedGroups: (formedGroupsStr || '  _Nenhum grupo formado_') + (isolatedStr ? '\n' + isolatedStr : ''),
    scores: scoresStr,
    leaderboard,
  }), { parse_mode: 'Markdown' });

  logger.info(`Resultado da rodada ${roundId} exibido`);

  // Próxima rodada ou fim
  if (round.roundNumber < game.totalRounds) {
    await api.sendMessage(game.chatId, messages.nextRound(15), { parse_mode: 'Markdown' });
    setTimeout(async () => {
      try {
        await startNextRound(game.id, api);
      } catch (error) {
        logger.error(`Erro ao iniciar próxima rodada: ${error}`);
      }
    }, 15_000);
  } else {
    // Fim do jogo
    await api.sendMessage(game.chatId, messages.finalResult(leaderboard), { parse_mode: 'Markdown' });
    logger.info(`Jogo ${game.id} finalizado!`);
    await cleanupGameData(game.id);
  }
}
