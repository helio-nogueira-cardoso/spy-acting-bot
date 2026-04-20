import type { Bot } from 'grammy';
import type { BotContext } from '../types';
import { logger } from '../utils/logger';
import { messages } from '../utils/messages';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/connection';
import { rounds, playerRoundState, players, games, manualConfigs, roundRoles } from '../db/schema';
import { getPlayersInGame } from '../utils/validators';

/**
 * Detecta se o usuário é o configurador de um jogo manual aguardando o prompt
 * de "digite o local" (primeiro texto após o pedido de config). Como o pedido
 * em engine/round.ts usa api.sendMessage (sem passar pelo middleware de
 * sessão), o session.currentStep do configurador fica undefined — esta função
 * reconstrói o step a partir do estado do jogo no DB.
 */
export async function findPendingManualConfigGame(userId: number) {
  const candidates = await db.query.games.findMany({
    where: and(eq(games.creatorId, userId), eq(games.mode, 'manual')),
  });

  for (const game of candidates) {
    // Só consideramos jogos em andamento, mas fora de uma rodada ativa
    if (game.status !== 'playing' && game.status !== 'round_ended') continue;

    // A próxima rodada ainda não foi criada no DB?
    const nextRoundNumber = game.currentRound + 1;
    if (nextRoundNumber > game.totalRounds) continue;

    const existingRound = await db.query.rounds.findFirst({
      where: and(eq(rounds.gameId, game.id), eq(rounds.roundNumber, nextRoundNumber)),
    });
    if (existingRound) continue;

    return { game, nextRoundNumber };
  }

  return null;
}

export function registerTextHandlers(bot: Bot<BotContext>): void {
  // Capturar texto no DM para chute do espião e modo manual
  bot.on('message:text', async (ctx, next) => {
    // Somente no DM
    if (ctx.chat.type !== 'private') {
      return next();
    }

    let step = ctx.session.currentStep;

    // Sem step explícito: checar se é o configurador de modo manual aguardando
    // o local da próxima rodada (session não é acessível a partir do engine)
    if (!step) {
      const pending = await findPendingManualConfigGame(ctx.from.id);
      if (pending) {
        step = `manual_location:${pending.game.id}:${pending.nextRoundNumber}`;
        ctx.session.currentStep = step;
      } else {
        return next();
      }
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

        // Buscar o round e o player
        const round = await db.query.rounds.findFirst({ where: eq(rounds.id, roundId) });
        if (!round) {
          ctx.session.currentStep = undefined;
          await ctx.reply('❌ Rodada não encontrada.');
          return;
        }

        // Só faz sentido chutar enquanto a rodada está ativa
        if (round.status !== 'active') {
          ctx.session.currentStep = undefined;
          await ctx.reply(messages.spyRoundNotActive);
          return;
        }

        const player = await db.query.players.findFirst({
          where: and(eq(players.gameId, round.gameId), eq(players.userId, ctx.from.id), eq(players.isActive, 1)),
        });

        if (!player) {
          ctx.session.currentStep = undefined;
          return;
        }

        // Confirma que o remetente é o espião da rodada
        const role = await db.query.roundRoles.findFirst({
          where: and(eq(roundRoles.roundId, roundId), eq(roundRoles.playerId, player.id)),
        });
        if (role?.role !== 'spy') {
          ctx.session.currentStep = undefined;
          await ctx.reply(messages.spyNoGuessError);
          return;
        }

        const { submitSpyGuess, checkRoundClose, isSpyGraceActive } = await import('../engine/verdict');
        // Se estamos na janela de graça, este é o chute final — rodada fecha em seguida.
        const duringGrace = isSpyGraceActive(roundId);
        await submitSpyGuess(roundId, player.id, guess);

        ctx.session.currentStep = undefined;
        if (duringGrace) {
          await ctx.reply(messages.spyGuessRecordedFinal(guess), { parse_mode: 'Markdown' });
        } else {
          await ctx.reply(messages.spyGuessRecorded(guess), {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🕵️ Alterar Chute', callback_data: `spy_guess_btn:${roundId}` }],
              ],
            },
          });
        }

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

