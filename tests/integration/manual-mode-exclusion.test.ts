/**
 * Testes de exclusão mútua: criador-jogador vs modo manual.
 *
 * Regra: no modo manual, o configurador conhece local e personagens.
 * Se o criador for também jogador, ele teria vantagem desleal.
 * O sistema deve impedir a combinação.
 */
import { describe, it, expect, vi } from 'vitest';
import { registerCommands } from '../../src/handlers/commands';
import { registerCallbacks } from '../../src/handlers/callbacks';
import { createTestGame, createTestPlayer } from '../helpers/factories';
import { getPlayerInGame } from '../../src/utils/validators';

// ─── Captura de handlers ────────────────────────────────────────

function captureCommandHandlers() {
  const handlers: Record<string, Function> = {};
  const mockBot = {
    command: vi.fn((name: string, handler: Function) => {
      handlers[name] = handler;
    }),
    botInfo: { username: 'TestBot' },
  };
  registerCommands(mockBot as any);
  return handlers;
}

function captureCallbackHandlers() {
  const handlers: { pattern: RegExp; handler: Function }[] = [];
  const mockBot = {
    callbackQuery: vi.fn((pattern: RegExp, handler: Function) => {
      handlers.push({ pattern, handler });
    }),
    botInfo: { username: 'TestBot' },
  };
  registerCallbacks(mockBot as any);
  return handlers;
}

function findCallback(handlers: { pattern: RegExp; handler: Function }[], data: string) {
  for (const h of handlers) {
    const match = data.match(h.pattern);
    if (match) return { handler: h.handler, match };
  }
  return null;
}

function createCallbackCtx(overrides: {
  userId: number;
  firstName?: string;
  chatType?: string;
  chatId?: number;
  match: RegExpMatchArray;
}) {
  return {
    from: { id: overrides.userId, first_name: overrides.firstName ?? 'Test', username: 'test' },
    chat: { id: overrides.chatId ?? -1000, type: overrides.chatType ?? 'group' },
    match: overrides.match,
    reply: vi.fn().mockResolvedValue(undefined),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    editMessageText: vi.fn().mockResolvedValue(undefined),
    api: { sendMessage: vi.fn().mockResolvedValue(undefined) },
    session: {},
  };
}

describe('exclusão mútua: modo manual + criador como jogador', () => {
  const commandHandlers = captureCommandHandlers();
  const callbackHandlers = captureCallbackHandlers();

  it('criador-jogador tenta ativar modo manual → BLOQUEADO', async () => {
    const game = await createTestGame({ creatorId: 11000, mode: 'auto' });
    await createTestPlayer(game.id, { userId: 11000 }); // criador entrou como jogador

    const { handler, match } = findCallback(callbackHandlers, `mode:${game.id}:manual`)!;
    const ctx = createCallbackCtx({
      userId: 11000,
      match: match! as RegExpMatchArray,
    });

    await handler(ctx);

    // Deve ter bloqueado com alert
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        show_alert: true,
        text: expect.stringContaining('imparcialidade'),
      })
    );
  });

  it('criador que NÃO é jogador pode ativar modo manual → permitido', async () => {
    const game = await createTestGame({ creatorId: 11100, mode: 'auto' });
    // criador NÃO entrou como jogador

    const { handler, match } = findCallback(callbackHandlers, `mode:${game.id}:manual`)!;
    const ctx = createCallbackCtx({
      userId: 11100,
      match: match! as RegExpMatchArray,
    });

    await handler(ctx);

    // Deve ter aceito (answerCallbackQuery com texto de sucesso)
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Manual'),
      })
    );
  });

  it('criador tenta entrar como jogador quando modo é manual → BLOQUEADO via callback', async () => {
    const game = await createTestGame({ creatorId: 11200, mode: 'manual' });

    const { handler, match } = findCallback(callbackHandlers, `join:${game.id}`)!;
    const ctx = createCallbackCtx({
      userId: 11200,
      match: match! as RegExpMatchArray,
    });

    await handler(ctx);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        show_alert: true,
        text: expect.stringContaining('configurador não pode ser jogador'),
      })
    );

    // Não deve ter sido inserido no DB
    const player = await getPlayerInGame(game.id, 11200);
    expect(player).toBeFalsy();
  });

  it('criador tenta entrar como jogador quando modo é manual → BLOQUEADO via /join', async () => {
    const joinHandler = commandHandlers['join'];
    const game = await createTestGame({ chatId: -12000, creatorId: 11300, mode: 'manual' });

    const ctx = {
      from: { id: 11300, first_name: 'Creator', last_name: undefined, username: 'creator' },
      chat: { id: -12000, type: 'group' as const },
      reply: vi.fn().mockResolvedValue(undefined),
      api: { sendMessage: vi.fn().mockResolvedValue(undefined) },
      session: {},
    };

    await joinHandler(ctx);

    const replyTexts = ctx.reply.mock.calls.map((c: any[]) => c[0] as string);
    expect(replyTexts.some((t: string) => t.includes('configurador não pode ser jogador'))).toBe(true);
  });

  it('jogador normal (não criador) pode entrar mesmo no modo manual', async () => {
    const game = await createTestGame({ creatorId: 11400, mode: 'manual' });

    const { handler, match } = findCallback(callbackHandlers, `join:${game.id}`)!;
    const ctx = createCallbackCtx({
      userId: 99999, // não é o criador
      firstName: 'NormalPlayer',
      match: match! as RegExpMatchArray,
    });

    await handler(ctx);

    // Deve ter aceito
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('entrou') })
    );
  });

  it('criador pode entrar como jogador no modo automático sem problemas', async () => {
    const game = await createTestGame({ creatorId: 11500, mode: 'auto' });

    const { handler, match } = findCallback(callbackHandlers, `join:${game.id}`)!;
    const ctx = createCallbackCtx({
      userId: 11500,
      firstName: 'CreatorPlayer',
      match: match! as RegExpMatchArray,
    });

    await handler(ctx);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('entrou') })
    );
  });

  it('modo auto sempre é aceito mesmo com criador jogando', async () => {
    const game = await createTestGame({ creatorId: 11600, mode: 'manual' });
    await createTestPlayer(game.id, { userId: 11600 });

    // Trocar de manual para auto: deve funcionar (resolver o conflito)
    const { handler, match } = findCallback(callbackHandlers, `mode:${game.id}:auto`)!;
    const ctx = createCallbackCtx({
      userId: 11600,
      match: match! as RegExpMatchArray,
    });

    await handler(ctx);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Automático') })
    );
  });
});
