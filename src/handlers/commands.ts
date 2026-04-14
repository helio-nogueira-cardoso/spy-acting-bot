import type { Bot } from 'grammy';
import type { BotContext } from '../types';
import { messages } from '../utils/messages';
import { logger } from '../utils/logger';
import { createGame, joinGame, leaveGame, validateGameStart, updateGameStatus } from '../engine/lobby';
import { getAnyActiveGameForChat, getPlayersInGame, getPlayerActiveGame, getPlayerInGame } from '../utils/validators';
import { cleanupGameData } from '../engine/cleanup';
import { config } from '../config';

export function registerCommands(bot: Bot<BotContext>): void {
  // /start — Boas-vindas no DM
  bot.command('start', async (ctx) => {
    try {
      await ctx.reply(messages.welcome, { parse_mode: 'Markdown' });
      logger.info(`/start de user=${ctx.from?.id} (${ctx.from?.first_name})`);
    } catch (error) {
      logger.error(`Erro no /start: ${error}`);
      await ctx.reply(messages.errorGeneric);
    }
  });

  // /help — Regras e comandos
  bot.command('help', async (ctx) => {
    try {
      await ctx.reply(messages.help, { parse_mode: 'Markdown' });
      logger.info(`/help de user=${ctx.from?.id}`);
    } catch (error) {
      logger.error(`Erro no /help: ${error}`);
      await ctx.reply(messages.errorGeneric);
    }
  });

  // /newgame — Criar sala (somente em grupo)
  bot.command('newgame', async (ctx) => {
    try {
      if (ctx.chat?.type === 'private') {
        await ctx.reply(messages.errorGroupOnly);
        return;
      }

      const chatId = ctx.chat!.id;
      const creatorId = ctx.from!.id;
      const result = await createGame(chatId, creatorId);

      if (!result.success) {
        await ctx.reply(`❌ ${result.error}`);
        return;
      }

      const gameId = result.gameId!;

      // Postar mensagem no grupo com botão de entrar
      await ctx.reply(messages.gameCreated(gameId), {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🎭 Entrar no Jogo', callback_data: `join:${gameId}` }],
            [
              { text: '⚙️ Configurar', callback_data: `config:${gameId}` },
              { text: '🎬 Iniciar Jogo', callback_data: `start_game:${gameId}` },
            ],
          ],
        },
      });

      // Enviar DM ao criador
      try {
        await ctx.api.sendMessage(creatorId, '🕵️ *Sala criada!* Aguardando jogadores.\n\n_Configure o jogo usando os botões no grupo._', {
          parse_mode: 'Markdown',
        });
      } catch {
        await ctx.reply(`⚠️ @${ctx.from!.username || ctx.from!.first_name}, inicie uma conversa comigo primeiro: t.me/${bot.botInfo.username}`);
      }

      logger.info(`/newgame: sala ${gameId} criada por ${creatorId} no chat ${chatId}`);
    } catch (error) {
      logger.error(`Erro no /newgame: ${error}`);
      await ctx.reply(messages.errorGeneric);
    }
  });

  // /join — Entrar na sala (somente em grupo)
  bot.command('join', async (ctx) => {
    try {
      if (ctx.chat?.type === 'private') {
        await ctx.reply(messages.errorGroupOnly);
        return;
      }

      const chatId = ctx.chat!.id;
      const game = await getAnyActiveGameForChat(chatId);

      if (!game || game.status !== 'lobby') {
        await ctx.reply(messages.errorNoActiveGame);
        return;
      }

      const userId = ctx.from!.id;
      const displayName = ctx.from!.first_name + (ctx.from!.last_name ? ` ${ctx.from!.last_name}` : '');

      // Criador não pode ser jogador no modo manual
      if (userId === game.creatorId && game.mode === 'manual') {
        await ctx.reply('⚠️ No modo manual, o configurador não pode ser jogador — você saberia o local e os personagens! Troque para modo automático ou deixe outra pessoa configurar.');
        return;
      }

      const result = await joinGame(game.id, userId, ctx.from!.username, displayName);

      if (!result.success) {
        await ctx.reply(`❌ ${result.error}`);
        return;
      }

      await ctx.reply(messages.joinedGame(displayName), { parse_mode: 'Markdown' });

      // Enviar DM ao jogador
      try {
        await ctx.api.sendMessage(userId, messages.dmWelcomePlayer, { parse_mode: 'Markdown' });
      } catch {
        await ctx.reply(messages.needToStartDm(bot.botInfo.username, displayName), { parse_mode: 'Markdown' });
      }
    } catch (error) {
      logger.error(`Erro no /join: ${error}`);
      await ctx.reply(messages.errorGeneric);
    }
  });

  // /leave — Sair do jogo
  bot.command('leave', async (ctx) => {
    try {
      const userId = ctx.from!.id;
      const displayName = ctx.from!.first_name;
      const isGroup = ctx.chat?.type !== 'private';
      const game = await getPlayerActiveGame(userId);

      if (!game) {
        await ctx.reply(messages.errorNotInGame);
        return;
      }

      if (game.status === 'round_active') {
        if (isGroup) {
          await ctx.reply(`⚠️ *${displayName}*, não é possível sair durante uma rodada ativa.`, { parse_mode: 'Markdown' });
        } else {
          await ctx.reply(messages.cantLeaveMidRound);
        }
        return;
      }

      const result = await leaveGame(game.id, userId);

      if (!result.success) {
        await ctx.reply(`❌ ${result.error}`);
        return;
      }

      // Mensagem pessoal (DM) — segunda pessoa
      if (isGroup) {
        try { await ctx.api.sendMessage(userId, messages.youLeft); } catch { /* DM pode falhar */ }
      } else {
        await ctx.reply(messages.youLeft);
      }

      // Mensagens de grupo — sempre terceira pessoa com nome
      const groupChatId = game.chatId;
      try {
        await ctx.api.sendMessage(groupChatId, messages.playerLeft(displayName), { parse_mode: 'Markdown' });

        if (result.gameEnded) {
          await ctx.api.sendMessage(groupChatId, '🔚 *Jogo encerrado* — todos os jogadores saíram.', { parse_mode: 'Markdown' });
        } else if (result.newCreatorUserId) {
          await ctx.api.sendMessage(groupChatId,
            `👑 *${result.newCreatorName}* agora é o responsável pela sala (pode configurar, iniciar e encerrar o jogo).`,
            { parse_mode: 'Markdown' }
          );
          try {
            await ctx.api.sendMessage(result.newCreatorUserId,
              '👑 Você agora é o responsável pela sala! Pode configurar, iniciar e encerrar o jogo.',
              { parse_mode: 'Markdown' }
            );
          } catch { /* DM pode falhar */ }
        }
      } catch {
        // Grupo pode não ser acessível
      }
    } catch (error) {
      logger.error(`Erro no /leave: ${error}`);
      await ctx.reply(messages.errorGeneric);
    }
  });

  // /status — Ver estado do jogo
  bot.command('status', async (ctx) => {
    try {
      const chatId = ctx.chat!.id;
      const isPrivate = ctx.chat?.type === 'private';

      let game;
      if (isPrivate) {
        game = await getPlayerActiveGame(ctx.from!.id);
      } else {
        game = await getAnyActiveGameForChat(chatId);
      }

      if (!game) {
        await ctx.reply(isPrivate ? messages.errorNotInGame : messages.errorNoActiveGame);
        return;
      }

      const activePlayers = await getPlayersInGame(game.id);

      if (game.status === 'lobby') {
        const names = activePlayers.map(p => {
          const photoIcon = p.photoFileId ? '📸' : '⏳';
          return `${photoIcon} ${p.displayName}`;
        });
        await ctx.reply(messages.lobbyStatus(names, config.maxPlayers), { parse_mode: 'Markdown' });
      } else {
        await ctx.reply(messages.statusPlaying(game.currentRound, game.totalRounds), { parse_mode: 'Markdown' });
      }
    } catch (error) {
      logger.error(`Erro no /status: ${error}`);
      await ctx.reply(messages.errorGeneric);
    }
  });

  // /endgame — Encerrar jogo (somente criador)
  bot.command('endgame', async (ctx) => {
    try {
      if (ctx.chat?.type === 'private') {
        await ctx.reply(messages.errorGroupOnly);
        return;
      }

      const chatId = ctx.chat!.id;
      const game = await getAnyActiveGameForChat(chatId);

      if (!game) {
        await ctx.reply(messages.errorNoActiveGame);
        return;
      }

      if (ctx.from!.id !== game.creatorId) {
        await ctx.reply(messages.onlyCreatorCanEnd);
        return;
      }

      await ctx.reply(messages.gameEnded, { parse_mode: 'Markdown' });
      logger.info(`Jogo ${game.id} encerrado pelo criador ${ctx.from!.id}`);
      await cleanupGameData(game.id);
    } catch (error) {
      logger.error(`Erro no /endgame: ${error}`);
      await ctx.reply(messages.errorGeneric);
    }
  });

  // /cancel — Cancelar operação em andamento (DM)
  bot.command('cancel', async (ctx) => {
    try {
      if (ctx.session.currentStep) {
        ctx.session.currentStep = undefined;
        await ctx.reply('✅ Operação cancelada.');
        logger.info(`/cancel de user=${ctx.from?.id}`);
      } else {
        await ctx.reply('ℹ️ Nenhuma operação em andamento para cancelar.');
      }
    } catch (error) {
      logger.error(`Erro no /cancel: ${error}`);
      await ctx.reply(messages.errorGeneric);
    }
  });
}
