import { Bot, session } from 'grammy';
import { config } from './config';
import type { BotContext, SessionData } from './types';
import { logger } from './utils/logger';

// Instância do bot Grammy
export const bot = new Bot<BotContext>(config.botToken);

// Middleware de session
bot.use(
  session({
    initial: (): SessionData => ({
      gameId: undefined,
      currentStep: undefined,
    }),
  })
);

// Middleware de logging
bot.use(async (ctx, next) => {
  const start = Date.now();
  const userId = ctx.from?.id;
  const chatType = ctx.chat?.type;
  const text = ctx.message?.text?.slice(0, 50);

  logger.info(`[${chatType}] user=${userId} msg="${text || 'callback/other'}"`);

  await next();

  const ms = Date.now() - start;
  logger.info(`Resposta em ${ms}ms`);
});

// Error handler global
bot.catch((err) => {
  logger.error(`Erro no bot: ${err.message}`, { error: err.error });
});
