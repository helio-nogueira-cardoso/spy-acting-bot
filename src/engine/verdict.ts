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

// Janela pós-vereditos para o espião chutar (ou alterar o chute)
const SPY_GRACE_MS = 60_000;
export const SPY_GRACE_SECONDS = SPY_GRACE_MS / 1000;

// Janela para votação fair play
const FAIR_PLAY_VOTING_MS = 60_000;
export const FAIR_PLAY_VOTING_SECONDS = FAIR_PLAY_VOTING_MS / 1000;

// Override do timeout — usado apenas em testes para acelerar o fluxo
let fairPlayVotingTimeoutMs: number = FAIR_PLAY_VOTING_MS;

/** Testes: permite sobrescrever o timeout da votação fair play (ms). */
export function __setFairPlayVotingTimeoutMs(ms: number): void {
  fairPlayVotingTimeoutMs = ms;
}

/** Testes: restaura o timeout padrão da votação fair play. */
export function __resetFairPlayVotingTimeoutMs(): void {
  fairPlayVotingTimeoutMs = FAIR_PLAY_VOTING_MS;
}

// Timers de grace ativos, chaveados por roundId
const spyGraceTimers = new Map<number, ReturnType<typeof setTimeout>>();

function cancelSpyGrace(roundId: number): boolean {
  const timer = spyGraceTimers.get(roundId);
  if (timer) {
    clearTimeout(timer);
    spyGraceTimers.delete(roundId);
    return true;
  }
  return false;
}

/** Cancela um grace pendente — usado quando o estado da rodada muda (ex: undo de par). */
export function cancelSpyGraceIfActive(roundId: number): void {
  cancelSpyGrace(roundId);
}

/** True se o espião ainda está na janela de graça (timer ativo). */
export function isSpyGraceActive(roundId: number): boolean {
  return spyGraceTimers.has(roundId);
}

/** Testes: limpa timers pendentes entre cenários. */
export function __resetSpyGraceTimers(): void {
  for (const timer of spyGraceTimers.values()) clearTimeout(timer);
  spyGraceTimers.clear();
}

// ─── Sessões de votação fair play ─────────────────────────────────
type VotingSession = {
  timer: ReturnType<typeof setTimeout>;
  eligibleVoters: Set<number>;
  finalize: () => Promise<void>;
  finalized: boolean;
};

const votingSessions = new Map<number, VotingSession>();

/** Testes: limpa sessões de votação pendentes. */
export function __resetVotingSessions(): void {
  for (const session of votingSessions.values()) {
    clearTimeout(session.timer);
  }
  votingSessions.clear();
}

// ─── Controle de re-entrância de closeRoundNow ────────────────────
// Durante votação fair play, closeRoundNow pode levar até 60s.
// Evita que checkRoundClose ou grace timer disparem uma segunda execução.
const closingRounds = new Set<number>();

/** Testes: limpa locks de fechamento entre cenários. */
export function __resetClosingRounds(): void {
  closingRounds.clear();
}

export async function submitSpyGuess(roundId: number, playerId: number, guess: string): Promise<void> {
  const round = await db.query.rounds.findFirst({ where: eq(rounds.id, roundId) });
  if (round) await touchGameActivity(round.gameId);

  await db.update(rounds)
    .set({ spyGuess: guess })
    .where(eq(rounds.id, roundId));

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

  // Auto-marcar veredito dos isolados (que não têm par para confirmar)
  for (const isolated of unpairedStates) {
    if (isolated.verdictActive === 1) continue;
    await db.update(playerRoundState)
      .set({ verdictActive: 1 })
      .where(and(eq(playerRoundState.roundId, roundId), eq(playerRoundState.playerId, isolated.playerId)));
  }

  // Janela de graça para o espião chutar (ou alterar o chute) após os vereditos.
  const currentRound = await db.query.rounds.findFirst({ where: eq(rounds.id, roundId) });
  const spyHasGuessed = !!currentRound?.spyGuess;

  if (!spyHasGuessed && !spyGraceTimers.has(roundId)) {
    logger.info(`Rodada ${roundId}: iniciando grace de ${SPY_GRACE_SECONDS}s para chute do espião`);

    const spyPlayer = activePlayers.find(p => p.id === round.spyPlayerId);
    if (spyPlayer) {
      try {
        await api.sendMessage(spyPlayer.userId, messages.spyGraceNotify(SPY_GRACE_SECONDS), {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🕵️ Chutar Local', callback_data: `spy_guess_btn:${roundId}` }],
            ],
          },
        });
      } catch (err) {
        logger.error(`Erro notificando espião na graça: ${err}`);
      }
    }

    const timer = setTimeout(() => {
      spyGraceTimers.delete(roundId);
      closeRoundNow(roundId, api).catch((err) =>
        logger.error(`Erro ao fechar rodada ${roundId} após graça: ${err}`)
      );
    }, SPY_GRACE_MS);
    spyGraceTimers.set(roundId, timer);
    return;
  }

  // Se o espião já chutou (ou graça expirou), cancelar qualquer timer e fechar agora
  cancelSpyGrace(roundId);
  await closeRoundNow(roundId, api);
}

async function closeRoundNow(roundId: number, api: Api): Promise<void> {
  // Lock para evitar re-entrância. resolveSpyGuess pode aguardar até 60s durante votação fair play.
  if (closingRounds.has(roundId)) return;
  closingRounds.add(roundId);
  try {
    const round = await db.query.rounds.findFirst({ where: eq(rounds.id, roundId) });
    if (!round || round.status !== 'active') return;

    const game = await db.query.games.findFirst({ where: eq(games.id, round.gameId) });
    if (!game) return;

    const activePlayers = await getPlayersInGame(round.gameId);
    const allStates = await db.query.playerRoundState.findMany({
      where: eq(playerRoundState.roundId, roundId),
    });
    const activePlayerIds = new Set(activePlayers.map(p => p.id));
    const unpairedStates = allStates.filter(
      s => activePlayerIds.has(s.playerId) && s.pairingStatus === 'unpaired'
    );

    // Auto-marcar veredito do jogador isolado (não teve interação para votar)
    for (const isolated of unpairedStates) {
      await db.update(playerRoundState)
        .set({ verdictActive: 1 })
        .where(and(eq(playerRoundState.roundId, roundId), eq(playerRoundState.playerId, isolated.playerId)));
    }

    logger.info(`Rodada ${roundId} - processando fechamento final.`);

    // Verificar chute do espião
    const spyGuessApproved = await resolveSpyGuess(roundId, game, api);

    // Calcular pontuação
    await calculateAndDisplayResults(roundId, game, spyGuessApproved, api);
  } finally {
    closingRounds.delete(roundId);
  }
}

async function resolveSpyGuess(roundId: number, game: any, api: Api): Promise<boolean> {
  const round = await db.query.rounds.findFirst({ where: eq(rounds.id, roundId) });
  if (!round) return false;

  // Idempotência: se já foi resolvido anteriormente, retornar o valor persistido
  if (round.spyGuessApproved !== null) return round.spyGuessApproved === 1;

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

    return await waitForManualDecision(roundId, 180_000);
  }

  // Modo automático: votação fair play
  logger.info(`Chute do espião difere: "${spyGuess}" ≠ "${round.locationName}". Iniciando votação fair play.`);

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

  // Elegíveis = todos os agentes ativos (espião não vota)
  const activePlayers = await getPlayersInGame(round.gameId);
  const eligibleVoters = new Set(
    activePlayers.filter(p => p.id !== round.spyPlayerId).map(p => p.id)
  );

  return await startFairPlayVoting(roundId, eligibleVoters, fairPlayVotingTimeoutMs);
}

/**
 * Inicia uma sessão de votação fair play. Resolve quando:
 *  - O timeout expira, OU
 *  - Todos os elegíveis já votaram (fechamento antecipado via registerVote).
 */
function startFairPlayVoting(
  roundId: number,
  eligibleVoters: Set<number>,
  timeoutMs: number
): Promise<boolean> {
  // Já existe sessão ativa para essa rodada (não deveria, mas defensivo):
  // aguardar o resultado persistido via polling curto.
  if (votingSessions.has(roundId)) {
    return new Promise<boolean>((resolve) => {
      const poll = async () => {
        if (!votingSessions.has(roundId)) {
          const r = await db.query.rounds.findFirst({ where: eq(rounds.id, roundId) });
          resolve(r?.spyGuessApproved === 1);
          return;
        }
        setTimeout(poll, 100);
      };
      poll();
    });
  }

  return new Promise<boolean>((resolve) => {
    const finalize = async (): Promise<void> => {
      const session = votingSessions.get(roundId);
      if (!session || session.finalized) return;
      session.finalized = true;
      clearTimeout(session.timer);
      votingSessions.delete(roundId);

      const votes = await db.query.spyGuessVotes.findMany({
        where: eq(spyGuessVotes.roundId, roundId),
      });
      const eligibleVotes = votes.filter(v => session.eligibleVoters.has(v.voterPlayerId));

      let approved: boolean;
      if (eligibleVotes.length === 0) {
        approved = false;
        logger.info(`Votação rodada ${roundId}: nenhum voto válido. Chute invalidado.`);
      } else {
        const yesVotes = eligibleVotes.filter(v => v.vote === 1).length;
        const noVotes = eligibleVotes.filter(v => v.vote === 0).length;
        approved = yesVotes >= noVotes && yesVotes > 0;
        logger.info(
          `Votação rodada ${roundId}: ${yesVotes} sim / ${noVotes} não → ${approved ? 'aprovado' : 'rejeitado'}`
        );
      }

      await db.update(rounds).set({ spyGuessApproved: approved ? 1 : 0 }).where(eq(rounds.id, roundId));
      resolve(approved);
    };

    const timer = setTimeout(() => {
      finalize().catch(err => logger.error(`Erro finalizando votação ${roundId}: ${err}`));
    }, timeoutMs);

    votingSessions.set(roundId, {
      timer,
      eligibleVoters,
      finalize,
      finalized: false,
    });
  });
}

async function waitForManualDecision(roundId: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false;
    const done = (value: boolean) => {
      if (resolved) return;
      resolved = true;
      clearInterval(checkInterval);
      clearTimeout(timeoutHandle);
      resolve(value);
    };

    const checkInterval = setInterval(async () => {
      const round = await db.query.rounds.findFirst({ where: eq(rounds.id, roundId) });
      if (round && round.spyGuessApproved !== null) {
        done(round.spyGuessApproved === 1);
      }
    }, 2000);

    const timeoutHandle = setTimeout(async () => {
      const round = await db.query.rounds.findFirst({ where: eq(rounds.id, roundId) });
      if (round && round.spyGuessApproved !== null) {
        done(round.spyGuessApproved === 1);
        return;
      }
      await db.update(rounds).set({ spyGuessApproved: 0 }).where(eq(rounds.id, roundId));
      done(false);
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

  // Fechamento antecipado: se todos os elegíveis já votaram, encerra a sessão agora.
  const session = votingSessions.get(roundId);
  if (session && !session.finalized) {
    const allVotes = await db.query.spyGuessVotes.findMany({
      where: eq(spyGuessVotes.roundId, roundId),
    });
    const voterIds = new Set(allVotes.map(v => v.voterPlayerId));
    const allEligibleVoted = Array.from(session.eligibleVoters).every(pid => voterIds.has(pid));
    if (allEligibleVoted) {
      logger.info(`Votação rodada ${roundId}: todos os elegíveis votaram — fechando antecipadamente.`);
      await session.finalize();
    }
  }

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
