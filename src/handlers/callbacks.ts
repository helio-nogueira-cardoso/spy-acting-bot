import type { Bot } from 'grammy';
import type { BotContext } from '../types';
import { messages } from '../utils/messages';
import { logger } from '../utils/logger';
import { joinGame, updateGameConfig, validateGameStart, updateGameStatus } from '../engine/lobby';
import { getGameById, getPlayersInGame, getPlayerInGame } from '../utils/validators';
import { config } from '../config';
import {
  canRequestPairing,
  createPairingRequest,
  acceptPairing,
  rejectPairing,
  undoPairing,
  getAvailablePlayers,
  addToGroup,
  isGroupComplete,
  getExpectedGroupSize,
} from '../engine/pairing';
import { getRoundInfo, getRoundRolesForRound, getPlayerRoundState as getPlayerRState } from '../engine/round';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/connection';
import { players, playerRoundState, roundRoles, rounds, pairings } from '../db/schema';

// Helper: get player by DB id
async function getPlayerById(playerId: number) {
  return db.query.players.findFirst({ where: eq(players.id, playerId) }) ?? null;
}

// Helper: get player by user_id and roundId
async function getPlayerByUserAndRound(userId: number, roundId: number) {
  const round = await db.query.rounds.findFirst({ where: eq(rounds.id, roundId) });
  if (!round) return null;
  return db.query.players.findFirst({
    where: and(eq(players.gameId, round.gameId), eq(players.userId, userId), eq(players.isActive, 1)),
  }) ?? null;
}

export function registerCallbacks(bot: Bot<BotContext>): void {
  // ─── Join game via button ─────────────────────────────────────
  bot.callbackQuery(/^join:(.+)$/, async (ctx) => {
    try {
      const gameId = ctx.match![1];
      const game = await getGameById(gameId);

      if (!game || game.status !== 'lobby') {
        await ctx.answerCallbackQuery({ text: 'Esta sala não está mais disponível.', show_alert: true });
        return;
      }

      const userId = ctx.from.id;
      const displayName = ctx.from.first_name + (ctx.from.last_name ? ` ${ctx.from.last_name}` : '');

      // Criador não pode ser jogador no modo manual (conflito de imparcialidade)
      if (userId === game.creatorId && game.mode === 'manual') {
        await ctx.answerCallbackQuery({
          text: '⚠️ No modo manual, o configurador não pode ser jogador — você saberia o local e os personagens! Troque para modo automático ou deixe outra pessoa configurar.',
          show_alert: true,
        });
        return;
      }

      const result = await joinGame(game.id, userId, ctx.from.username, displayName);

      if (!result.success) {
        await ctx.answerCallbackQuery({ text: result.error!, show_alert: true });
        return;
      }

      await ctx.answerCallbackQuery({ text: '✅ Você entrou no jogo!' });

      // Notificar no grupo
      if (ctx.chat?.type !== 'private') {
        await ctx.reply(messages.joinedGame(displayName), { parse_mode: 'Markdown' });
      }

      // Enviar DM ao jogador
      try {
        await ctx.api.sendMessage(userId, messages.dmWelcomePlayer, { parse_mode: 'Markdown' });
      } catch {
        if (ctx.chat?.type !== 'private') {
          await ctx.reply(messages.needToStartDm(bot.botInfo.username, displayName), { parse_mode: 'Markdown' });
        }
      }

      // Atualizar lista de jogadores
      const activePlayers = await getPlayersInGame(game.id);
      const names = activePlayers.map(p => {
        const photoIcon = p.photoFileId ? '📸' : '⏳';
        return `${photoIcon} ${p.displayName}`;
      });
      try {
        await ctx.editMessageText(
          messages.gameCreated(gameId) + '\n\n' + messages.lobbyStatus(names, config.maxPlayers),
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: `🎭 Entrar no Jogo (${activePlayers.length}/${config.maxPlayers})`, callback_data: `join:${gameId}` }],
                [
                  { text: '⚙️ Configurar', callback_data: `config:${gameId}` },
                  { text: '🎬 Iniciar Jogo', callback_data: `start_game:${gameId}` },
                ],
              ],
            },
          }
        );
      } catch {
        // Pode falhar se a mensagem não mudou
      }

      logger.info(`Jogador ${userId} entrou no jogo ${gameId} via botão`);
    } catch (error) {
      logger.error(`Erro no callback join: ${error}`);
      await ctx.answerCallbackQuery({ text: 'Erro ao entrar no jogo.', show_alert: true });
    }
  });

  // ─── Config game ──────────────────────────────────────────────
  bot.callbackQuery(/^config:(.+)$/, async (ctx) => {
    try {
      const gameId = ctx.match![1];
      const game = await getGameById(gameId);

      if (!game || game.status !== 'lobby') {
        await ctx.answerCallbackQuery({ text: 'Sala não disponível.', show_alert: true });
        return;
      }

      if (ctx.from.id !== game.creatorId) {
        await ctx.answerCallbackQuery({ text: messages.onlyCreatorCanConfig, show_alert: true });
        return;
      }

      await ctx.answerCallbackQuery();

      try {
        await ctx.api.sendMessage(ctx.from.id, messages.configMenu(game.totalRounds, game.mode), {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '3', callback_data: `rounds:${gameId}:3` },
                { text: '5', callback_data: `rounds:${gameId}:5` },
                { text: '7', callback_data: `rounds:${gameId}:7` },
                { text: '10', callback_data: `rounds:${gameId}:10` },
              ],
              [
                { text: '🤖 Automático', callback_data: `mode:${gameId}:auto` },
                { text: '✍️ Manual', callback_data: `mode:${gameId}:manual` },
              ],
            ],
          },
        });
      } catch {
        if (ctx.chat?.type !== 'private') {
          const configName = ctx.from.first_name;
          await ctx.reply(messages.needToStartDm(bot.botInfo.username, configName), { parse_mode: 'Markdown' });
        }
      }
    } catch (error) {
      logger.error(`Erro no callback config: ${error}`);
      await ctx.answerCallbackQuery({ text: 'Erro ao abrir configuração.', show_alert: true });
    }
  });

  // ─── Set rounds ───────────────────────────────────────────────
  bot.callbackQuery(/^rounds:(.+):(\d+)$/, async (ctx) => {
    try {
      const gameId = ctx.match![1];
      const numRounds = parseInt(ctx.match![2], 10);
      const game = await getGameById(gameId);

      if (!game || ctx.from.id !== game.creatorId) {
        await ctx.answerCallbackQuery({ text: 'Sem permissão.', show_alert: true });
        return;
      }

      await updateGameConfig(gameId, { totalRounds: numRounds });
      await ctx.answerCallbackQuery({ text: `✅ Rodadas: ${numRounds}` });
      await ctx.editMessageText(messages.configRoundsSet(numRounds) + '\n\n' + messages.configMenu(numRounds, game.mode), {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '3', callback_data: `rounds:${gameId}:3` },
              { text: '5', callback_data: `rounds:${gameId}:5` },
              { text: '7', callback_data: `rounds:${gameId}:7` },
              { text: '10', callback_data: `rounds:${gameId}:10` },
            ],
            [
              { text: '🤖 Automático', callback_data: `mode:${gameId}:auto` },
              { text: '✍️ Manual', callback_data: `mode:${gameId}:manual` },
            ],
          ],
        },
      });
    } catch (error) {
      logger.error(`Erro no callback rounds: ${error}`);
      await ctx.answerCallbackQuery({ text: 'Erro ao configurar.', show_alert: true });
    }
  });

  // ─── Set mode ─────────────────────────────────────────────────
  bot.callbackQuery(/^mode:(.+):(auto|manual)$/, async (ctx) => {
    try {
      const gameId = ctx.match![1];
      const mode = ctx.match![2];
      const game = await getGameById(gameId);

      if (!game || ctx.from.id !== game.creatorId) {
        await ctx.answerCallbackQuery({ text: 'Sem permissão.', show_alert: true });
        return;
      }

      // Modo manual + criador jogador = conflito de imparcialidade
      if (mode === 'manual') {
        const creatorAsPlayer = await getPlayerInGame(gameId, ctx.from.id);
        if (creatorAsPlayer) {
          await ctx.answerCallbackQuery({
            text: '⚠️ Você está no jogo como jogador! No modo manual, o configurador conhece o local e os personagens — isso comprometeria a imparcialidade. Saia do jogo (/leave) ou mantenha o modo automático.',
            show_alert: true,
          });
          return;
        }
      }

      await updateGameConfig(gameId, { mode });
      await ctx.answerCallbackQuery({ text: `✅ Modo: ${mode === 'auto' ? 'Automático' : 'Manual'}` });
      await ctx.editMessageText(messages.configModeSet(mode) + '\n\n' + messages.configMenu(game.totalRounds, mode), {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '3', callback_data: `rounds:${gameId}:3` },
              { text: '5', callback_data: `rounds:${gameId}:5` },
              { text: '7', callback_data: `rounds:${gameId}:7` },
              { text: '10', callback_data: `rounds:${gameId}:10` },
            ],
            [
              { text: '🤖 Automático', callback_data: `mode:${gameId}:auto` },
              { text: '✍️ Manual', callback_data: `mode:${gameId}:manual` },
            ],
          ],
        },
      });
    } catch (error) {
      logger.error(`Erro no callback mode: ${error}`);
      await ctx.answerCallbackQuery({ text: 'Erro ao configurar.', show_alert: true });
    }
  });

  // ─── Start game ───────────────────────────────────────────────
  bot.callbackQuery(/^start_game:(.+)$/, async (ctx) => {
    try {
      const gameId = ctx.match![1];
      const game = await getGameById(gameId);

      if (!game) {
        await ctx.answerCallbackQuery({ text: 'Jogo não encontrado.', show_alert: true });
        return;
      }

      if (ctx.from.id !== game.creatorId) {
        await ctx.answerCallbackQuery({ text: messages.onlyCreatorCanStart, show_alert: true });
        return;
      }

      if (game.status !== 'lobby') {
        await ctx.answerCallbackQuery({ text: 'O jogo já foi iniciado.', show_alert: true });
        return;
      }

      const validation = await validateGameStart(gameId);
      if (!validation.valid) {
        await ctx.answerCallbackQuery({ text: '❌ Não foi possível iniciar.', show_alert: true });
        await ctx.reply(messages.gameStartErrors(validation.errors), { parse_mode: 'Markdown' });
        return;
      }

      const activePlayers = await getPlayersInGame(gameId);
      const dmFailures: string[] = [];

      for (const player of activePlayers) {
        try {
          await ctx.api.sendMessage(player.userId, messages.gameStarting, { parse_mode: 'Markdown' });
        } catch {
          dmFailures.push(player.displayName);
        }
      }

      if (dmFailures.length > 0) {
        await ctx.reply(
          `❌ Não consegui enviar DM para: *${dmFailures.join(', ')}*\n\nEles precisam iniciar conversa comigo primeiro: t.me/${bot.botInfo.username}`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      await updateGameStatus(gameId, 'playing');
      await ctx.answerCallbackQuery({ text: '🎬 Jogo iniciando!' });
      await ctx.reply(messages.gameStarted(game.totalRounds), { parse_mode: 'Markdown' });

      try {
        const { startNextRound } = await import('../engine/round');
        await startNextRound(gameId, ctx.api);
      } catch (error) {
        logger.error(`Erro ao iniciar primeira rodada: ${error}`);
        await ctx.reply('⚠️ Jogo iniciado, mas houve um erro ao preparar a primeira rodada.');
      }

      logger.info(`Jogo ${gameId} iniciado`);
    } catch (error) {
      logger.error(`Erro no callback start_game: ${error}`);
      await ctx.answerCallbackQuery({ text: 'Erro ao iniciar jogo.', show_alert: true });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // PAIRING CALLBACKS (Phase 4)
  // ═══════════════════════════════════════════════════════════════

  // ─── Show player list for pairing ─────────────────────────────
  bot.callbackQuery(/^pair_list:(\d+)$/, async (ctx) => {
    try {
      const roundId = parseInt(ctx.match![1], 10);
      const player = await getPlayerByUserAndRound(ctx.from.id, roundId);
      if (!player) {
        await ctx.answerCallbackQuery({ text: 'Você não está nesta rodada.', show_alert: true });
        return;
      }

      // Verificar estado do jogador
      const myState = await getPlayerRState(roundId, player.id);
      if (!myState) {
        await ctx.answerCallbackQuery({ text: 'Estado não encontrado.', show_alert: true });
        return;
      }

      if (myState.pairingStatus === 'paired') {
        await ctx.answerCallbackQuery({ text: messages.alreadyPaired, show_alert: true });
        return;
      }

      if (myState.pairingStatus !== 'unpaired') {
        await ctx.answerCallbackQuery({ text: 'Você tem um convite pendente.', show_alert: true });
        return;
      }

      await ctx.answerCallbackQuery();

      // Listar jogadores disponíveis
      const available = await getAvailablePlayers(roundId, player.id);

      if (available.length === 0) {
        await ctx.api.sendMessage(ctx.from.id, '😅 Nenhum agente disponível no momento. Tente novamente mais tarde.');
        return;
      }

      // Buscar infos dos jogadores
      const round = await getRoundInfo(roundId);
      if (!round) return;
      const gamePlayers = await getPlayersInGame(round.gameId);
      const availablePlayerIds = available.map(a => a.playerId);
      const availablePlayerInfos = gamePlayers.filter(p => availablePlayerIds.includes(p.id));

      // Enviar cada jogador com foto + botão
      await ctx.api.sendMessage(ctx.from.id, messages.choosePairTarget, { parse_mode: 'Markdown' });

      for (const p of availablePlayerInfos) {
        const button = {
          inline_keyboard: [
            [{ text: `🤝 Solicitar par com ${p.displayName}`, callback_data: `pair_req:${roundId}:${p.id}` }],
          ],
        };

        if (p.photoFileId) {
          await ctx.api.sendPhoto(ctx.from.id, p.photoFileId, {
            caption: `📸 *${p.displayName}*`,
            parse_mode: 'Markdown',
            reply_markup: button,
          });
        } else {
          await ctx.api.sendMessage(ctx.from.id, `👤 *${p.displayName}*`, {
            parse_mode: 'Markdown',
            reply_markup: button,
          });
        }
      }
    } catch (error) {
      logger.error(`Erro no pair_list: ${error}`);
      await ctx.answerCallbackQuery({ text: 'Erro ao listar jogadores.', show_alert: true });
    }
  });

  // ─── Request pairing ──────────────────────────────────────────
  bot.callbackQuery(/^pair_req:(\d+):(\d+)$/, async (ctx) => {
    try {
      const roundId = parseInt(ctx.match![1], 10);
      const targetPlayerId = parseInt(ctx.match![2], 10);
      const player = await getPlayerByUserAndRound(ctx.from.id, roundId);

      if (!player) {
        await ctx.answerCallbackQuery({ text: 'Você não está nesta rodada.', show_alert: true });
        return;
      }

      const validation = await canRequestPairing(roundId, player.id, targetPlayerId);
      if (!validation.allowed) {
        await ctx.answerCallbackQuery({ text: validation.reason!, show_alert: true });
        return;
      }

      const pairingId = await createPairingRequest(roundId, player.id, targetPlayerId);

      const targetPlayer = await getPlayerById(targetPlayerId);
      if (!targetPlayer) {
        await ctx.answerCallbackQuery({ text: 'Jogador não encontrado.', show_alert: true });
        return;
      }

      await ctx.answerCallbackQuery({ text: '📨 Convite enviado!' });
      await ctx.api.sendMessage(ctx.from.id, messages.pairRequestSent(targetPlayer.displayName), { parse_mode: 'Markdown' });

      // Enviar convite ao target
      const requesterName = player.displayName;
      try {
        if (player.photoFileId) {
          await ctx.api.sendPhoto(targetPlayer.userId, player.photoFileId, {
            caption: messages.pairRequestReceived(requesterName),
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '✅ Aceitar', callback_data: `pair_accept:${pairingId}` },
                  { text: '❌ Recusar', callback_data: `pair_reject:${pairingId}` },
                ],
              ],
            },
          });
        } else {
          await ctx.api.sendMessage(targetPlayer.userId, messages.pairRequestReceived(requesterName), {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '✅ Aceitar', callback_data: `pair_accept:${pairingId}` },
                  { text: '❌ Recusar', callback_data: `pair_reject:${pairingId}` },
                ],
              ],
            },
          });
        }
      } catch (error) {
        logger.error(`Erro ao enviar convite para ${targetPlayer.userId}: ${error}`);
      }

      logger.info(`Pair request: ${player.id} → ${targetPlayerId} (pairing=${pairingId})`);
    } catch (error) {
      logger.error(`Erro no pair_req: ${error}`);
      await ctx.answerCallbackQuery({ text: 'Erro ao solicitar par.', show_alert: true });
    }
  });

  // ─── Accept pairing ───────────────────────────────────────────
  bot.callbackQuery(/^pair_accept:(\d+)$/, async (ctx) => {
    try {
      const pairingId = parseInt(ctx.match![1], 10);
      const result = await acceptPairing(pairingId);

      if (!result.success) {
        await ctx.answerCallbackQuery({ text: result.error!, show_alert: true });
        return;
      }

      await ctx.answerCallbackQuery({ text: '✅ Par formado!' });

      const requester = await getPlayerById(result.requesterId!);
      const target = await getPlayerById(result.targetId!);

      if (!requester || !target) return;

      // Notificar ambos
      const pairing = await db.query.pairings.findFirst({ where: eq(pairings.id, pairingId) });
      const roundId = pairing!.roundId;

      // Verificar se é grupo completo ou precisa de mais
      if (result.groupComplete) {
        // Grupo completo - mostrar botões de veredito e desfazer
        const groupButtons = {
          inline_keyboard: [
            [{ text: '✅ Confirmar Veredito', callback_data: `verdict:${roundId}` }],
            [{ text: '❌ Desfazer Par', callback_data: `pair_undo:${roundId}` }],
            [{ text: '📋 Ver Meu Papel', callback_data: `view_role:${roundId}` }],
          ],
        };

        await ctx.api.sendMessage(requester.userId, messages.pairAccepted(target.displayName) + '\n\n' + messages.groupComplete, {
          parse_mode: 'Markdown',
          reply_markup: groupButtons,
        });
        await ctx.api.sendMessage(target.userId, messages.pairAccepted(requester.displayName) + '\n\n' + messages.groupComplete, {
          parse_mode: 'Markdown',
          reply_markup: groupButtons,
        });
      } else {
        // Grupo incompleto (precisa de trio)
        const expectedSize = await getExpectedGroupSize([result.requesterId!, result.targetId!], roundId);
        const missing = expectedSize - 2;

        const incompleteButtons = {
          inline_keyboard: [
            [{ text: '🤝 Adicionar ao Grupo', callback_data: `pair_add:${roundId}` }],
            [{ text: '❌ Desfazer Par', callback_data: `pair_undo:${roundId}` }],
            [{ text: '📋 Ver Meu Papel', callback_data: `view_role:${roundId}` }],
          ],
        };

        await ctx.api.sendMessage(requester.userId, messages.pairAccepted(target.displayName) + '\n\n' + messages.groupIncomplete(missing), {
          parse_mode: 'Markdown',
          reply_markup: incompleteButtons,
        });
        await ctx.api.sendMessage(target.userId, messages.pairAccepted(requester.displayName) + '\n\n' + messages.groupIncomplete(missing), {
          parse_mode: 'Markdown',
          reply_markup: incompleteButtons,
        });
      }
    } catch (error) {
      logger.error(`Erro no pair_accept: ${error}`);
      await ctx.answerCallbackQuery({ text: 'Erro ao aceitar par.', show_alert: true });
    }
  });

  // ─── Reject pairing ───────────────────────────────────────────
  bot.callbackQuery(/^pair_reject:(\d+)$/, async (ctx) => {
    try {
      const pairingId = parseInt(ctx.match![1], 10);
      const result = await rejectPairing(pairingId);

      if (!result.success) {
        await ctx.answerCallbackQuery({ text: result.error!, show_alert: true });
        return;
      }

      await ctx.answerCallbackQuery({ text: '❌ Convite recusado.' });
      await ctx.api.sendMessage(ctx.from.id, messages.pairRejected);

      // Notificar requester
      const requester = await getPlayerById(result.requesterId!);
      const target = await getPlayerById(result.targetId!);
      if (requester && target) {
        await ctx.api.sendMessage(requester.userId, messages.pairRejectedNotification(target.displayName), { parse_mode: 'Markdown' });
      }
    } catch (error) {
      logger.error(`Erro no pair_reject: ${error}`);
      await ctx.answerCallbackQuery({ text: 'Erro ao recusar.', show_alert: true });
    }
  });

  // ─── Add to group (trio) ──────────────────────────────────────
  bot.callbackQuery(/^pair_add:(\d+)$/, async (ctx) => {
    try {
      const roundId = parseInt(ctx.match![1], 10);
      const player = await getPlayerByUserAndRound(ctx.from.id, roundId);
      if (!player) {
        await ctx.answerCallbackQuery({ text: 'Você não está nesta rodada.', show_alert: true });
        return;
      }

      const myState = await getPlayerRState(roundId, player.id);
      if (!myState || myState.pairingStatus !== 'paired' || !myState.pairedWith) {
        await ctx.answerCallbackQuery({ text: 'Você precisa estar em um grupo para adicionar alguém.', show_alert: true });
        return;
      }

      const currentGroup: number[] = JSON.parse(myState.pairedWith);
      const complete = await isGroupComplete(currentGroup, roundId);
      if (complete) {
        await ctx.answerCallbackQuery({ text: 'Seu grupo já está completo!', show_alert: true });
        return;
      }

      await ctx.answerCallbackQuery();

      // Listar jogadores disponíveis
      const available = await getAvailablePlayers(roundId, player.id);
      // Excluir quem já está no grupo
      const filteredAvailable = available.filter(a => !currentGroup.includes(a.playerId));

      if (filteredAvailable.length === 0) {
        await ctx.api.sendMessage(ctx.from.id, '😅 Nenhum agente disponível para adicionar ao grupo.');
        return;
      }

      const round = await getRoundInfo(roundId);
      if (!round) return;
      const gamePlayers = await getPlayersInGame(round.gameId);
      const availIds = filteredAvailable.map(a => a.playerId);
      const availInfos = gamePlayers.filter(p => availIds.includes(p.id));

      await ctx.api.sendMessage(ctx.from.id, messages.addToGroupPrompt, { parse_mode: 'Markdown' });

      for (const p of availInfos) {
        const button = {
          inline_keyboard: [
            [{ text: `🤝 Adicionar ${p.displayName}`, callback_data: `pair_add_confirm:${roundId}:${p.id}` }],
          ],
        };

        if (p.photoFileId) {
          await ctx.api.sendPhoto(ctx.from.id, p.photoFileId, {
            caption: `📸 *${p.displayName}*`,
            parse_mode: 'Markdown',
            reply_markup: button,
          });
        } else {
          await ctx.api.sendMessage(ctx.from.id, `👤 *${p.displayName}*`, {
            parse_mode: 'Markdown',
            reply_markup: button,
          });
        }
      }
    } catch (error) {
      logger.error(`Erro no pair_add: ${error}`);
      await ctx.answerCallbackQuery({ text: 'Erro ao listar jogadores.', show_alert: true });
    }
  });

  // ─── Confirm add to group ─────────────────────────────────────
  bot.callbackQuery(/^pair_add_confirm:(\d+):(\d+)$/, async (ctx) => {
    try {
      const roundId = parseInt(ctx.match![1], 10);
      const newPlayerId = parseInt(ctx.match![2], 10);
      const player = await getPlayerByUserAndRound(ctx.from.id, roundId);
      if (!player) {
        await ctx.answerCallbackQuery({ text: 'Erro.', show_alert: true });
        return;
      }

      const myState = await getPlayerRState(roundId, player.id);
      if (!myState || !myState.pairedWith) {
        await ctx.answerCallbackQuery({ text: 'Você não está em um grupo.', show_alert: true });
        return;
      }

      const currentGroup: number[] = JSON.parse(myState.pairedWith);
      const result = await addToGroup(roundId, currentGroup, newPlayerId);

      if (!result.success) {
        await ctx.answerCallbackQuery({ text: result.error!, show_alert: true });
        return;
      }

      await ctx.answerCallbackQuery({ text: '✅ Membro adicionado!' });

      // Notificar todos os membros do grupo
      const allMembers = [...currentGroup, newPlayerId];
      const round = await getRoundInfo(roundId);
      if (!round) return;
      const gamePlayers = await getPlayersInGame(round.gameId);
      const memberNames = allMembers.map(pid => {
        const p = gamePlayers.find(gp => gp.id === pid);
        return p?.displayName || 'Desconhecido';
      });

      const groupButtons = {
        inline_keyboard: [
          [{ text: '✅ Confirmar Veredito', callback_data: `verdict:${roundId}` }],
          [{ text: '❌ Desfazer Par', callback_data: `pair_undo:${roundId}` }],
          [{ text: '📋 Ver Meu Papel', callback_data: `view_role:${roundId}` }],
        ],
      };

      for (const memberId of allMembers) {
        const memberPlayer = gamePlayers.find(p => p.id === memberId);
        if (memberPlayer) {
          await ctx.api.sendMessage(
            memberPlayer.userId,
            messages.trioFormed(memberNames) + '\n\n' + messages.groupComplete,
            { parse_mode: 'Markdown', reply_markup: groupButtons }
          );
        }
      }
    } catch (error) {
      logger.error(`Erro no pair_add_confirm: ${error}`);
      await ctx.answerCallbackQuery({ text: 'Erro ao adicionar.', show_alert: true });
    }
  });

  // ─── Undo pairing ─────────────────────────────────────────────
  bot.callbackQuery(/^pair_undo:(\d+)$/, async (ctx) => {
    try {
      const roundId = parseInt(ctx.match![1], 10);
      const player = await getPlayerByUserAndRound(ctx.from.id, roundId);
      if (!player) {
        await ctx.answerCallbackQuery({ text: 'Erro.', show_alert: true });
        return;
      }

      await ctx.answerCallbackQuery();
      await ctx.api.sendMessage(ctx.from.id, messages.pairUndoConfirm, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Sim, desfazer', callback_data: `pair_undo_confirm:${roundId}` },
              { text: '❌ Cancelar', callback_data: `pair_undo_cancel:${roundId}` },
            ],
          ],
        },
      });
    } catch (error) {
      logger.error(`Erro no pair_undo: ${error}`);
      await ctx.answerCallbackQuery({ text: 'Erro.', show_alert: true });
    }
  });

  // ─── Confirm undo ─────────────────────────────────────────────
  bot.callbackQuery(/^pair_undo_confirm:(\d+)$/, async (ctx) => {
    try {
      const roundId = parseInt(ctx.match![1], 10);
      const player = await getPlayerByUserAndRound(ctx.from.id, roundId);
      if (!player) {
        await ctx.answerCallbackQuery({ text: 'Erro.', show_alert: true });
        return;
      }

      const result = await undoPairing(roundId, player.id);
      if (!result.success) {
        await ctx.answerCallbackQuery({ text: result.error!, show_alert: true });
        return;
      }

      await ctx.answerCallbackQuery({ text: '💔 Par desfeito.' });

      // Notificar todos os afetados
      const round = await getRoundInfo(roundId);
      if (!round) return;
      const gamePlayers = await getPlayersInGame(round.gameId);

      const actionButtons = {
        inline_keyboard: [
          [{ text: '🤝 Solicitar Par', callback_data: `pair_list:${roundId}` }],
          [{ text: '📋 Ver Meu Papel', callback_data: `view_role:${roundId}` }],
          [{ text: '📊 Ver Situação', callback_data: `view_status:${roundId}` }],
        ],
      };

      for (const affectedId of result.affectedPlayerIds!) {
        const affectedPlayer = gamePlayers.find(p => p.id === affectedId);
        if (affectedPlayer) {
          await ctx.api.sendMessage(
            affectedPlayer.userId,
            messages.pairUndone(player.displayName),
            { parse_mode: 'Markdown', reply_markup: actionButtons }
          );
        }
      }
    } catch (error) {
      logger.error(`Erro no pair_undo_confirm: ${error}`);
      await ctx.answerCallbackQuery({ text: 'Erro ao desfazer.', show_alert: true });
    }
  });

  // ─── Cancel undo ──────────────────────────────────────────────
  bot.callbackQuery(/^pair_undo_cancel:(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCallbackQuery({ text: '✅ Cancelado.' });
      await ctx.editMessageText('✅ Par mantido.');
    } catch (error) {
      logger.error(`Erro no pair_undo_cancel: ${error}`);
    }
  });

  // ─── View role ────────────────────────────────────────────────
  bot.callbackQuery(/^view_role:(\d+)$/, async (ctx) => {
    try {
      const roundId = parseInt(ctx.match![1], 10);
      const player = await getPlayerByUserAndRound(ctx.from.id, roundId);
      if (!player) {
        await ctx.answerCallbackQuery({ text: 'Erro.', show_alert: true });
        return;
      }

      const role = await db.query.roundRoles.findFirst({
        where: and(eq(roundRoles.roundId, roundId), eq(roundRoles.playerId, player.id)),
      });

      if (!role) {
        await ctx.answerCallbackQuery({ text: 'Papel não encontrado.', show_alert: true });
        return;
      }

      const round = await getRoundInfo(roundId);
      const game = round ? await getGameById(round.gameId) : null;
      if (!round || !game) return;

      await ctx.answerCallbackQuery();

      if (role.role === 'spy') {
        await ctx.api.sendMessage(ctx.from.id, messages.spyDm(round.roundNumber, game.totalRounds, round.spyHint, role.characterName), {
          parse_mode: 'Markdown',
        });
      } else {
        // Encontrar parceiros
        const allRoles = await getRoundRolesForRound(roundId);
        const myGroup = role.assignedGroup;
        const partners = allRoles.filter(r => r.assignedGroup === myGroup && r.playerId !== player.id);
        const partnerChars = partners.map(r => `"${r.characterName}"`);
        let partnerInfo = '';
        if (role.groupType === 'duo') {
          partnerInfo = `Seu grupo (dupla): Procure o ${partnerChars[0] || '?'}`;
        } else if (role.groupType === 'trio') {
          partnerInfo = `Seu grupo (trio): Procure o ${partnerChars.join(' e o ')}`;
        }

        await ctx.api.sendMessage(ctx.from.id, messages.agentDm(round.roundNumber, game.totalRounds, round.locationName, role.characterName, round.spyHint, partnerInfo), {
          parse_mode: 'Markdown',
        });
      }
    } catch (error) {
      logger.error(`Erro no view_role: ${error}`);
      await ctx.answerCallbackQuery({ text: 'Erro ao ver papel.', show_alert: true });
    }
  });

  // ─── View status ──────────────────────────────────────────────
  bot.callbackQuery(/^view_status:(\d+)$/, async (ctx) => {
    try {
      const roundId = parseInt(ctx.match![1], 10);
      const player = await getPlayerByUserAndRound(ctx.from.id, roundId);
      if (!player) {
        await ctx.answerCallbackQuery({ text: 'Erro.', show_alert: true });
        return;
      }

      const round = await getRoundInfo(roundId);
      if (!round) return;

      const allStates = await db.query.playerRoundState.findMany({
        where: eq(playerRoundState.roundId, roundId),
      });

      const gamePlayers = await getPlayersInGame(round.gameId);

      const statusLines = allStates.map(s => {
        const p = gamePlayers.find(gp => gp.id === s.playerId);
        const name = p?.displayName || '???';
        let icon = '🔴';
        if (s.verdictActive) icon = '✅';
        else if (s.pairingStatus === 'paired') icon = '🟢';
        else if (s.pairingStatus.startsWith('pending')) icon = '🟡';
        return `${icon} ${name}`;
      });

      await ctx.answerCallbackQuery();
      await ctx.api.sendMessage(ctx.from.id,
        `📊 *Situação da Rodada ${round.roundNumber}*\n\n` +
        statusLines.join('\n') +
        '\n\n🔴 Sem par | 🟡 Pendente | 🟢 Em grupo | ✅ Veredito',
        { parse_mode: 'Markdown' }
      );
    } catch (error) {
      logger.error(`Erro no view_status: ${error}`);
      await ctx.answerCallbackQuery({ text: 'Erro.', show_alert: true });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // VERDICT CALLBACKS (Phase 5) — implemented next
  // ═══════════════════════════════════════════════════════════════

  // ─── Verdict ──────────────────────────────────────────────────
  bot.callbackQuery(/^verdict:(\d+)$/, async (ctx) => {
    try {
      const roundId = parseInt(ctx.match![1], 10);
      const player = await getPlayerByUserAndRound(ctx.from.id, roundId);
      if (!player) {
        await ctx.answerCallbackQuery({ text: 'Erro.', show_alert: true });
        return;
      }

      const myState = await getPlayerRState(roundId, player.id);
      if (!myState || myState.pairingStatus !== 'paired') {
        await ctx.answerCallbackQuery({ text: 'Você precisa estar em um grupo completo para dar veredito.', show_alert: true });
        return;
      }

      if (myState.verdictActive) {
        await ctx.answerCallbackQuery({ text: 'Você já confirmou seu veredito!', show_alert: true });
        return;
      }

      // Verificar se grupo está completo
      const groupMembers: number[] = myState.pairedWith ? JSON.parse(myState.pairedWith) : [];
      const complete = await isGroupComplete(groupMembers, roundId);
      if (!complete) {
        await ctx.answerCallbackQuery({ text: 'Seu grupo ainda não está completo.', show_alert: true });
        return;
      }

      // Verificar se é espião — precisa chutar o local
      const role = await db.query.roundRoles.findFirst({
        where: and(eq(roundRoles.roundId, roundId), eq(roundRoles.playerId, player.id)),
      });

      if (role?.role === 'spy') {
        await ctx.answerCallbackQuery();
        // Salvar estado para capturar texto depois
        ctx.session.currentStep = `spy_guess:${roundId}`;
        await ctx.api.sendMessage(ctx.from.id, messages.spyGuessPrompt, { parse_mode: 'Markdown' });
        return;
      }

      // Agente: confirmar veredito direto
      await ctx.answerCallbackQuery({ text: '✅ Veredito confirmado!' });

      await db.update(playerRoundState)
        .set({ verdictActive: 1 })
        .where(and(eq(playerRoundState.roundId, roundId), eq(playerRoundState.playerId, player.id)));

      await ctx.api.sendMessage(ctx.from.id, messages.verdictConfirmed, { parse_mode: 'Markdown' });

      // Verificar se todos confirmaram
      const { checkRoundClose } = await import('../engine/verdict');
      await checkRoundClose(roundId, ctx.api);
    } catch (error) {
      logger.error(`Erro no verdict: ${error}`);
      await ctx.answerCallbackQuery({ text: 'Erro ao confirmar veredito.', show_alert: true });
    }
  });

  // ─── Fair play voting ─────────────────────────────────────────
  bot.callbackQuery(/^vote_spy_yes:(\d+)$/, async (ctx) => {
    try {
      const roundId = parseInt(ctx.match![1], 10);
      const { registerVote } = await import('../engine/verdict');
      const player = await getPlayerByUserAndRound(ctx.from.id, roundId);
      if (!player) {
        await ctx.answerCallbackQuery({ text: 'Erro.', show_alert: true });
        return;
      }

      const result = await registerVote(roundId, player.id, 1);
      if (!result.success) {
        await ctx.answerCallbackQuery({ text: result.error!, show_alert: true });
        return;
      }

      await ctx.answerCallbackQuery({ text: '✅ Voto registrado: válido' });
    } catch (error) {
      logger.error(`Erro no vote_spy_yes: ${error}`);
      await ctx.answerCallbackQuery({ text: 'Erro ao votar.', show_alert: true });
    }
  });

  bot.callbackQuery(/^vote_spy_no:(\d+)$/, async (ctx) => {
    try {
      const roundId = parseInt(ctx.match![1], 10);
      const { registerVote } = await import('../engine/verdict');
      const player = await getPlayerByUserAndRound(ctx.from.id, roundId);
      if (!player) {
        await ctx.answerCallbackQuery({ text: 'Erro.', show_alert: true });
        return;
      }

      const result = await registerVote(roundId, player.id, 0);
      if (!result.success) {
        await ctx.answerCallbackQuery({ text: result.error!, show_alert: true });
        return;
      }

      await ctx.answerCallbackQuery({ text: '✅ Voto registrado: inválido' });
    } catch (error) {
      logger.error(`Erro no vote_spy_no: ${error}`);
      await ctx.answerCallbackQuery({ text: 'Erro ao votar.', show_alert: true });
    }
  });

  // ─── Manual mode: configurator spy guess decision ─────────────
  bot.callbackQuery(/^manual_spy_yes:(\d+)$/, async (ctx) => {
    try {
      const roundId = parseInt(ctx.match![1], 10);
      const { resolveSpyGuessManual } = await import('../engine/verdict');
      await resolveSpyGuessManual(roundId, true, ctx.api);
      await ctx.answerCallbackQuery({ text: '✅ Chute aceito!' });
      await ctx.editMessageText('✅ Chute do espião aceito.');
    } catch (error) {
      logger.error(`Erro no manual_spy_yes: ${error}`);
      await ctx.answerCallbackQuery({ text: 'Erro.', show_alert: true });
    }
  });

  bot.callbackQuery(/^manual_spy_no:(\d+)$/, async (ctx) => {
    try {
      const roundId = parseInt(ctx.match![1], 10);
      const { resolveSpyGuessManual } = await import('../engine/verdict');
      await resolveSpyGuessManual(roundId, false, ctx.api);
      await ctx.answerCallbackQuery({ text: '❌ Chute recusado!' });
      await ctx.editMessageText('❌ Chute do espião recusado.');
    } catch (error) {
      logger.error(`Erro no manual_spy_no: ${error}`);
      await ctx.answerCallbackQuery({ text: 'Erro.', show_alert: true });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // MANUAL MODE CALLBACKS
  // ═══════════════════════════════════════════════════════════════

  // ─── Manual confirm ───────────────────────────────────────────
  bot.callbackQuery(/^manual_confirm_yes:(.+):(\d+)$/, async (ctx) => {
    try {
      const gameId = ctx.match![1];
      const roundNumber = parseInt(ctx.match![2], 10);

      await ctx.answerCallbackQuery({ text: '✅ Configuração confirmada!' });
      await ctx.editMessageText('✅ Configuração confirmada! Iniciando rodada...');

      // Pegar dados da sessão
      const step = ctx.session.currentStep;
      if (!step || !step.startsWith('manual_confirm:')) {
        return;
      }

      const parts = step.split(':');
      const locationName = parts[3];
      const hint = parts[4];
      const groupsChars: string[][] = JSON.parse(parts[5]);

      ctx.session.currentStep = undefined;

      // Iniciar rodada manual
      const { startManualRound } = await import('../engine/round');
      await startManualRound(gameId, locationName, hint, groupsChars, ctx.api);
    } catch (error) {
      logger.error(`Erro no manual_confirm_yes: ${error}`);
      await ctx.answerCallbackQuery({ text: 'Erro.', show_alert: true });
    }
  });

  // ─── Manual redo ──────────────────────────────────────────────
  bot.callbackQuery(/^manual_confirm_redo:(.+):(\d+)$/, async (ctx) => {
    try {
      const gameId = ctx.match![1];
      const roundNumber = parseInt(ctx.match![2], 10);

      await ctx.answerCallbackQuery({ text: '🔄 Recomeçando configuração...' });
      ctx.session.currentStep = `manual_location:${gameId}:${roundNumber}`;
      await ctx.api.sendMessage(ctx.from.id, messages.manualConfigStart(roundNumber) + '\n\n' + messages.manualLocationPrompt, {
        parse_mode: 'Markdown',
      });
    } catch (error) {
      logger.error(`Erro no manual_confirm_redo: ${error}`);
      await ctx.answerCallbackQuery({ text: 'Erro.', show_alert: true });
    }
  });
}
