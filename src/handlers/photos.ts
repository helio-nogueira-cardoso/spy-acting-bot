import type { Bot } from 'grammy';
import type { BotContext } from '../types';
import { messages } from '../utils/messages';
import { logger } from '../utils/logger';
import { updatePlayerPhoto } from '../engine/lobby';
import { getPlayerActiveGame } from '../utils/validators';
import { getPhotoPath } from '../utils/photo-store';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/connection';
import { players } from '../db/schema';

export function registerPhotoHandler(bot: Bot<BotContext>): void {
  bot.on('message:photo', async (ctx) => {
    try {
      // Somente no DM
      if (ctx.chat.type !== 'private') {
        return;
      }

      const userId = ctx.from.id;
      const game = await getPlayerActiveGame(userId);

      if (!game) {
        await ctx.reply(messages.noGameForSelfie);
        return;
      }

      if (game.status !== 'lobby') {
        await ctx.reply('⚠️ O jogo já começou. Selfies só são aceitas durante o lobby.');
        return;
      }

      // Verificar se já tem foto
      const player = await db.query.players.findFirst({
        where: and(eq(players.gameId, game.id), eq(players.userId, userId)),
      });

      if (!player) {
        await ctx.reply(messages.noGameForSelfie);
        return;
      }

      // Pegar a maior resolução disponível
      const photos = ctx.message.photo;
      const biggestPhoto = photos[photos.length - 1];
      const fileId = biggestPhoto.file_id;
      const photoPath = getPhotoPath(game.id, userId);

      await updatePlayerPhoto(game.id, userId, fileId, photoPath);
      await ctx.reply(messages.selfieReceived, { parse_mode: 'Markdown' });

      logger.info(`Selfie recebida de user=${userId} para jogo=${game.id}`);
    } catch (error) {
      logger.error(`Erro ao processar foto: ${error}`);
      await ctx.reply(messages.errorGeneric);
    }
  });
}
