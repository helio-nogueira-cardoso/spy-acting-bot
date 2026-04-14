import type { Bot } from 'grammy';
import type { BotContext } from '../types';
import { logger } from '../utils/logger';
import { messages } from '../utils/messages';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/connection';
import { rounds, playerRoundState, players, games, manualConfigs, roundRoles } from '../db/schema';
import { getPlayersInGame } from '../utils/validators';

export function registerTextHandlers(bot: Bot<BotContext>): void {
  // Capturar texto no DM para chute do espião e modo manual
  bot.on('message:text', async (ctx, next) => {
    // Somente no DM
    if (ctx.chat.type !== 'private') {
      return next();
    }

    const step = ctx.session.currentStep;
    if (!step) {
      return next();
    }

    try {
      // ─── Spy guess ─────────────────────────────────────
      if (step.startsWith('spy_guess:')) {
        const roundId = parseInt(step.split(':')[1], 10);
        const guess = ctx.message.text.trim();

        if (!guess) {
          await ctx.reply('⚠️ Digite o nome do local:');
          return;
        }

        // Buscar o player
        const round = await db.query.rounds.findFirst({ where: eq(rounds.id, roundId) });
        if (!round) {
          ctx.session.currentStep = undefined;
          await ctx.reply('❌ Rodada não encontrada.');
          return;
        }

        const player = await db.query.players.findFirst({
          where: and(eq(players.gameId, round.gameId), eq(players.userId, ctx.from.id), eq(players.isActive, 1)),
        });

        if (!player) {
          ctx.session.currentStep = undefined;
          return;
        }

        const { submitSpyGuess, checkRoundClose } = await import('../engine/verdict');
        await submitSpyGuess(roundId, player.id, guess);

        ctx.session.currentStep = undefined;
        await ctx.reply(messages.verdictConfirmed, { parse_mode: 'Markdown' });

        await checkRoundClose(roundId, ctx.api);
        return;
      }

      // ─── Manual mode: location ─────────────────────────
      if (step.startsWith('manual_location:')) {
        const [, gameId, roundNumberStr] = step.split(':');
        const locationName = ctx.message.text.trim();

        if (!locationName) {
          await ctx.reply('⚠️ Digite o nome do local:');
          return;
        }

        ctx.session.currentStep = `manual_hint:${gameId}:${roundNumberStr}:${locationName}`;
        await ctx.reply(messages.manualHintPrompt, { parse_mode: 'Markdown' });
        return;
      }

      // ─── Manual mode: hint ─────────────────────────────
      if (step.startsWith('manual_hint:')) {
        const parts = step.split(':');
        const gameId = parts[1];
        const roundNumberStr = parts[2];
        const locationName = parts.slice(3).join(':');
        const hint = ctx.message.text.trim();

        if (!hint) {
          await ctx.reply('⚠️ Digite a dica para o espião:');
          return;
        }

        // Calcular estrutura de grupos para informar ao configurador
        const activePlayers = await getPlayersInGame(gameId);
        const numPlayers = activePlayers.length;
        const numAgents = numPlayers - 1;

        let structureInfo = `Esta rodada tem ${numPlayers} jogadores → `;
        const groupPrompts: { groupNum: number; type: string; size: number }[] = [];

        if (numAgents % 2 === 0) {
          const numDuos = numAgents / 2;
          structureInfo += `${numDuos} dupla(s) + 1 espião`;
          for (let i = 1; i <= numDuos; i++) {
            groupPrompts.push({ groupNum: i, type: 'dupla', size: 2 });
          }
        } else {
          const numDuos = Math.floor((numAgents - 3) / 2);
          structureInfo += `1 trio + ${numDuos} dupla(s) + 1 espião`;
          groupPrompts.push({ groupNum: 1, type: 'trio', size: 3 });
          for (let i = 2; i <= numDuos + 1; i++) {
            groupPrompts.push({ groupNum: i, type: 'dupla', size: 2 });
          }
        }

        await ctx.reply(messages.manualGroupStructure(structureInfo), { parse_mode: 'Markdown' });

        // Pedir personagens do primeiro grupo
        const firstGroup = groupPrompts[0];
        ctx.session.currentStep = `manual_chars:${gameId}:${roundNumberStr}:${locationName}:${hint}:${JSON.stringify(groupPrompts)}:0:${JSON.stringify([])}`;
        await ctx.reply(messages.manualCharactersPrompt(firstGroup.groupNum, firstGroup.type, firstGroup.size), { parse_mode: 'Markdown' });
        return;
      }

      // ─── Manual mode: characters per group ─────────────
      if (step.startsWith('manual_chars:')) {
        const parts = step.split(':');
        const gameId = parts[1];
        const roundNumberStr = parts[2];
        const locationName = parts[3];
        const hint = parts[4];
        const groupPrompts: { groupNum: number; type: string; size: number }[] = JSON.parse(parts[5]);
        const currentGroupIdx = parseInt(parts[6], 10);
        const collectedGroups: string[][] = JSON.parse(parts[7]);

        const input = ctx.message.text.trim();
        const characters = input.split(',').map(c => c.trim()).filter(c => c.length > 0);

        const expectedSize = groupPrompts[currentGroupIdx].size;
        if (characters.length !== expectedSize) {
          await ctx.reply(`⚠️ Esperado ${expectedSize} personagens separados por vírgula. Você digitou ${characters.length}. Tente novamente:`);
          return;
        }

        collectedGroups.push(characters);
        const nextIdx = currentGroupIdx + 1;

        if (nextIdx < groupPrompts.length) {
          // Pedir próximo grupo
          const nextGroup = groupPrompts[nextIdx];
          ctx.session.currentStep = `manual_chars:${gameId}:${roundNumberStr}:${locationName}:${hint}:${JSON.stringify(groupPrompts)}:${nextIdx}:${JSON.stringify(collectedGroups)}`;
          await ctx.reply(messages.manualCharactersPrompt(nextGroup.groupNum, nextGroup.type, nextGroup.size), { parse_mode: 'Markdown' });
          return;
        }

        // Todos os grupos coletados — mostrar resumo
        let summary = `📍 Local: *${locationName}*\n💡 Dica: *"${hint}"*\n🕵️ Espião: _(aleatório, definido pelo bot)_\n\n`;
        collectedGroups.forEach((chars, i) => {
          const gp = groupPrompts[i];
          summary += `🎭 Grupo ${gp.groupNum} (${gp.type}): ${chars.join(' + ')}\n`;
        });

        ctx.session.currentStep = `manual_confirm:${gameId}:${roundNumberStr}:${locationName}:${hint}:${JSON.stringify(collectedGroups)}`;
        await ctx.reply(messages.manualConfirmation(summary), {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Confirmar', callback_data: `manual_confirm_yes:${gameId}:${roundNumberStr}` },
                { text: '🔄 Refazer', callback_data: `manual_confirm_redo:${gameId}:${roundNumberStr}` },
              ],
            ],
          },
        });
        return;
      }
    } catch (error) {
      logger.error(`Erro no text handler: ${error}`);
      await ctx.reply(messages.errorGeneric);
    }

    return next();
  });
}

