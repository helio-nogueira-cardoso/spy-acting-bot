/**
 * Testes de roteamento do /leave (Obs B regression).
 *
 * Verifica que:
 * - No grupo: "Você saiu" vai como DM, grupo recebe "Fulano abandonou" em 3ª pessoa
 * - No DM:   "Você saiu" vai como reply, grupo recebe "Fulano abandonou"
 * - cantLeaveMidRound no grupo usa nome do jogador, não "Você"
 */
import { describe, it, expect, vi } from 'vitest';
import { registerCommands } from '../../src/handlers/commands';
import { createTestGame, createTestPlayer } from '../helpers/factories';
import { db } from '../../src/db/connection';
import { games } from '../../src/db/schema';
import { eq } from 'drizzle-orm';

// Captura os handlers registrados pelo registerCommands
function captureHandlers() {
  const handlers: Record<string, Function> = {};
  const mockBot = {
    command: vi.fn((name: string, handler: Function) => {
      handlers[name] = handler;
    }),
    botInfo: { username: 'SpyActingBot' },
  };
  registerCommands(mockBot as any);
  return handlers;
}

function createMockCtx(overrides: {
  userId: number;
  firstName: string;
  chatType: 'private' | 'group' | 'supergroup';
  chatId: number;
}) {
  const reply = vi.fn().mockResolvedValue(undefined);
  const sendMessage = vi.fn().mockResolvedValue(undefined);

  return {
    from: {
      id: overrides.userId,
      first_name: overrides.firstName,
      last_name: undefined,
      username: `user_${overrides.userId}`,
    },
    chat: {
      id: overrides.chatId,
      type: overrides.chatType,
    },
    reply,
    api: { sendMessage },
    session: {},
  };
}

describe('/leave roteamento de mensagens (Obs B regression)', () => {
  const handlers = captureHandlers();
  const leaveHandler = handlers['leave'];

  it('no GRUPO: "Você saiu" vai como DM, não como reply no grupo', async () => {
    const game = await createTestGame({ chatId: -8000, status: 'lobby' });
    await createTestPlayer(game.id, { userId: 5001, displayName: 'Alice' });
    await createTestPlayer(game.id, { userId: 5002 }); // manter alguém

    const ctx = createMockCtx({
      userId: 5001,
      firstName: 'Alice',
      chatType: 'group',
      chatId: -8000,
    });

    await leaveHandler(ctx);

    // "Você saiu" NÃO deve ir como ctx.reply (que seria no grupo)
    const replyTexts = ctx.reply.mock.calls.map((c: any[]) => c[0]);
    expect(replyTexts).not.toContain('👋 Você saiu do jogo.');

    // "Você saiu" deve ir como DM para o userId
    const dmCalls = ctx.api.sendMessage.mock.calls.filter(
      (c: any[]) => c[0] === 5001 && c[1] === '👋 Você saiu do jogo.'
    );
    expect(dmCalls.length).toBe(1);
  });

  it('no GRUPO: grupo recebe mensagem em 3ª pessoa com nome', async () => {
    const game = await createTestGame({ chatId: -8100, status: 'lobby' });
    await createTestPlayer(game.id, { userId: 5101, displayName: 'Bruno' });
    await createTestPlayer(game.id, { userId: 5102 });

    const ctx = createMockCtx({
      userId: 5101,
      firstName: 'Bruno',
      chatType: 'group',
      chatId: -8100,
    });

    await leaveHandler(ctx);

    // Grupo recebe "Bruno abandonou a missão"
    const groupCalls = ctx.api.sendMessage.mock.calls.filter(
      (c: any[]) => c[0] === -8100
    );
    const groupTexts = groupCalls.map((c: any[]) => c[1]);
    expect(groupTexts.some((t: string) => t.includes('Bruno') && t.includes('abandonou'))).toBe(true);
  });

  it('no DM: "Você saiu" vai como reply, grupo recebe 3ª pessoa', async () => {
    const game = await createTestGame({ chatId: -8200, status: 'lobby' });
    await createTestPlayer(game.id, { userId: 5201, displayName: 'Carol' });
    await createTestPlayer(game.id, { userId: 5202 });

    const ctx = createMockCtx({
      userId: 5201,
      firstName: 'Carol',
      chatType: 'private',
      chatId: 5201, // DM chatId = userId
    });

    await leaveHandler(ctx);

    // "Você saiu" vai como ctx.reply (no DM)
    const replyTexts = ctx.reply.mock.calls.map((c: any[]) => c[0]);
    expect(replyTexts).toContain('👋 Você saiu do jogo.');

    // Grupo recebe "Carol abandonou"
    const groupCalls = ctx.api.sendMessage.mock.calls.filter(
      (c: any[]) => c[0] === -8200
    );
    const groupTexts = groupCalls.map((c: any[]) => c[1]);
    expect(groupTexts.some((t: string) => t.includes('Carol') && t.includes('abandonou'))).toBe(true);
  });

  it('cantLeaveMidRound no GRUPO usa nome, não "Você"', async () => {
    const game = await createTestGame({ chatId: -8300, status: 'round_active' });
    await createTestPlayer(game.id, { userId: 5301, displayName: 'Diana' });

    const ctx = createMockCtx({
      userId: 5301,
      firstName: 'Diana',
      chatType: 'supergroup',
      chatId: -8300,
    });

    await leaveHandler(ctx);

    // Reply no grupo deve conter o nome "Diana", não "Você está no meio"
    const replyTexts = ctx.reply.mock.calls.map((c: any[]) => c[0]);
    expect(replyTexts.some((t: string) => t.includes('Diana'))).toBe(true);
    expect(replyTexts.some((t: string) => t === '⚠️ Você está no meio de uma rodada! Confirme seu veredito primeiro ou use /endgame no grupo.')).toBe(false);
  });

  it('cantLeaveMidRound no DM usa "Você" normalmente', async () => {
    const game = await createTestGame({ chatId: -8400, status: 'round_active' });
    await createTestPlayer(game.id, { userId: 5401, displayName: 'Eduardo' });

    const ctx = createMockCtx({
      userId: 5401,
      firstName: 'Eduardo',
      chatType: 'private',
      chatId: 5401,
    });

    await leaveHandler(ctx);

    const replyTexts = ctx.reply.mock.calls.map((c: any[]) => c[0]);
    expect(replyTexts.some((t: string) => t.includes('Você') && t.includes('rodada'))).toBe(true);
  });

  it('transferência de criador notifica grupo com nome em 3ª pessoa', async () => {
    const game = await createTestGame({ chatId: -8500, creatorId: 5501, status: 'lobby' });
    await createTestPlayer(game.id, { userId: 5501, displayName: 'Fábio' });
    await createTestPlayer(game.id, { userId: 5502, displayName: 'Gabi' });

    const ctx = createMockCtx({
      userId: 5501,
      firstName: 'Fábio',
      chatType: 'group',
      chatId: -8500,
    });

    await leaveHandler(ctx);

    // Grupo recebe mensagem sobre novo criador com nome
    const groupCalls = ctx.api.sendMessage.mock.calls.filter(
      (c: any[]) => c[0] === -8500
    );
    const groupTexts = groupCalls.map((c: any[]) => c[1] as string);
    expect(groupTexts.some(t => t.includes('Gabi') && t.includes('responsável'))).toBe(true);

    // Novo criador recebe DM com "Você"
    const gabiDMs = ctx.api.sendMessage.mock.calls.filter(
      (c: any[]) => c[0] === 5502
    );
    expect(gabiDMs.length).toBeGreaterThan(0);
    expect(gabiDMs.some((c: any[]) => (c[1] as string).includes('Você agora é o responsável'))).toBe(true);
  });
});
