import { bot } from './bot';
import { registerCommands } from './handlers/commands';
import { registerCallbacks } from './handlers/callbacks';
import { registerPhotoHandler } from './handlers/photos';
import { registerTextHandlers } from './handlers/conversations';
import { logger } from './utils/logger';
import { startCleanupTimer } from './engine/cleanup';

// Importa conexão com DB para garantir que está inicializado
import './db/connection';

// Registra handlers (ordem importa: commands → callbacks → photos → text)
registerCommands(bot);
registerCallbacks(bot);
registerPhotoHandler(bot);
registerTextHandlers(bot);

// Inicia o bot
async function main(): Promise<void> {
  logger.info('🕵️ Spy Acting Bot iniciando...');

  // Verifica conexão com a API do Telegram
  const me = await bot.api.getMe();
  logger.info(`Bot autenticado: @${me.username} (${me.first_name})`);

  // Define comandos no menu do Telegram
  await bot.api.setMyCommands([
    { command: 'start', description: 'Iniciar conversa com o bot' },
    { command: 'newgame', description: 'Criar nova sala de jogo (grupo)' },
    { command: 'join', description: 'Entrar na sala ativa (grupo)' },
    { command: 'leave', description: 'Sair da sala atual' },
    { command: 'status', description: 'Ver estado do jogo' },
    { command: 'help', description: 'Regras e comandos' },
    { command: 'endgame', description: 'Encerrar jogo (criador)' },
    { command: 'cancel', description: 'Cancelar operação em andamento' },
  ]);

  // Inicia timer de limpeza de jogos inativos
  startCleanupTimer(bot.api);

  // Inicia long polling
  bot.start({
    onStart: () => {
      logger.info('🎭 Spy Acting Bot está online! Aguardando comandos...');
    },
  });
}

main().catch((error) => {
  logger.error(`Falha ao iniciar bot: ${error}`);
  process.exit(1);
});
