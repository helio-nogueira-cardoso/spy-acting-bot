/**
 * Testes do handler de foto/selfie (Bug #2 — fluxo completo).
 *
 * Cenários do bug original:
 * - Jogador entra num jogo, envia selfie → deve funcionar
 * - Jogador com jogos antigos finalizados + jogo novo ativo → selfie vai para o jogo certo
 * - Jogador que saiu tenta enviar selfie → rejeitado
 * - Jogo fora de lobby → selfie rejeitada
 */
import { describe, it, expect, vi } from 'vitest';
import { registerPhotoHandler } from '../../src/handlers/photos';
import { createTestGame, createTestPlayer } from '../helpers/factories';
import { db } from '../../src/db/connection';
import { players } from '../../src/db/schema';
import { eq, and } from 'drizzle-orm';

// Captura o handler registrado
function capturePhotoHandler() {
  let handler: Function;
  const mockBot = {
    on: vi.fn((event: string, fn: Function) => {
      if (event === 'message:photo') handler = fn;
    }),
  };
  registerPhotoHandler(mockBot as any);
  return handler!;
}

function createMockPhotoCtx(overrides: {
  userId: number;
  chatType?: string;
  photoFileId?: string;
}) {
  return {
    chat: { type: overrides.chatType ?? 'private' },
    from: { id: overrides.userId },
    message: {
      photo: [
        { file_id: 'small_id', width: 90, height: 90 },
        { file_id: overrides.photoFileId ?? 'big_photo_file_id', width: 800, height: 800 },
      ],
    },
    reply: vi.fn().mockResolvedValue(undefined),
    api: { sendMessage: vi.fn().mockResolvedValue(undefined) },
  };
}

describe('handler de foto/selfie (Bug #2 fluxo completo)', () => {
  const photoHandler = capturePhotoHandler();

  it('jogador ativo em lobby envia selfie → salva com sucesso', async () => {
    const game = await createTestGame({ status: 'lobby' });
    const player = await createTestPlayer(game.id, { userId: 6001 });

    const ctx = createMockPhotoCtx({ userId: 6001 });
    await photoHandler(ctx);

    // Selfie deve ter sido salva no DB
    const updated = await db.query.players.findFirst({
      where: and(eq(players.gameId, game.id), eq(players.userId, 6001)),
    });
    expect(updated!.photoFileId).toBe('big_photo_file_id');

    // Deve ter respondido com confirmação, não com erro
    const replyTexts = ctx.reply.mock.calls.map((c: any[]) => c[0] as string);
    expect(replyTexts.some(t => t.includes('Selfie recebida'))).toBe(true);
    expect(replyTexts.some(t => t.includes('não está'))).toBe(false);
  });

  it('jogador com jogo ANTIGO finalizado + jogo NOVO ativo → selfie vai para o novo (Bug #2 core)', async () => {
    // Cenário que causava não-determinismo: findFirst podia retornar o jogo errado
    const oldGame = await createTestGame({ status: 'finished' });
    await createTestPlayer(oldGame.id, { userId: 6002 });

    const newGame = await createTestGame({ status: 'lobby' });
    await createTestPlayer(newGame.id, { userId: 6002 });

    const ctx = createMockPhotoCtx({ userId: 6002, photoFileId: 'selfie_nova' });
    await photoHandler(ctx);

    // Selfie deve ter ido para o jogo NOVO
    const playerInNewGame = await db.query.players.findFirst({
      where: and(eq(players.gameId, newGame.id), eq(players.userId, 6002)),
    });
    expect(playerInNewGame!.photoFileId).toBe('selfie_nova');

    // Jogo antigo não deve ter sido afetado
    const playerInOldGame = await db.query.players.findFirst({
      where: and(eq(players.gameId, oldGame.id), eq(players.userId, 6002)),
    });
    expect(playerInOldGame!.photoFileId).toBeNull();
  });

  it('jogador com MÚLTIPLOS jogos finalizados, sem jogo ativo → rejeita selfie', async () => {
    const g1 = await createTestGame({ status: 'finished' });
    await createTestPlayer(g1.id, { userId: 6003 });
    const g2 = await createTestGame({ status: 'finished' });
    await createTestPlayer(g2.id, { userId: 6003 });

    const ctx = createMockPhotoCtx({ userId: 6003 });
    await photoHandler(ctx);

    const replyTexts = ctx.reply.mock.calls.map((c: any[]) => c[0] as string);
    expect(replyTexts.some(t => t.includes('não está'))).toBe(true);
  });

  it('jogador que SAIU do jogo (isActive=0) → rejeita selfie', async () => {
    const game = await createTestGame({ status: 'lobby' });
    await createTestPlayer(game.id, { userId: 6004, isActive: 0 }); // saiu

    const ctx = createMockPhotoCtx({ userId: 6004 });
    await photoHandler(ctx);

    const replyTexts = ctx.reply.mock.calls.map((c: any[]) => c[0] as string);
    expect(replyTexts.some(t => t.includes('não está'))).toBe(true);
  });

  it('jogo em round_active (não lobby) → rejeita selfie com mensagem adequada', async () => {
    const game = await createTestGame({ status: 'round_active' });
    await createTestPlayer(game.id, { userId: 6005 });

    const ctx = createMockPhotoCtx({ userId: 6005 });
    await photoHandler(ctx);

    const replyTexts = ctx.reply.mock.calls.map((c: any[]) => c[0] as string);
    expect(replyTexts.some(t => t.includes('já começou'))).toBe(true);
  });

  it('foto enviada em GRUPO (não DM) é ignorada silenciosamente', async () => {
    const game = await createTestGame({ status: 'lobby' });
    await createTestPlayer(game.id, { userId: 6006 });

    const ctx = createMockPhotoCtx({ userId: 6006, chatType: 'group' });
    await photoHandler(ctx);

    // Nenhuma resposta — handler retorna silenciosamente
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it('usuário que nunca entrou em nenhum jogo → rejeita selfie', async () => {
    const ctx = createMockPhotoCtx({ userId: 99999 });
    await photoHandler(ctx);

    const replyTexts = ctx.reply.mock.calls.map((c: any[]) => c[0] as string);
    expect(replyTexts.some(t => t.includes('não está'))).toBe(true);
  });

  it('selfie sobrescreve foto anterior', async () => {
    const game = await createTestGame({ status: 'lobby' });
    await createTestPlayer(game.id, { userId: 6007, photoFileId: 'foto_antiga' });

    const ctx = createMockPhotoCtx({ userId: 6007, photoFileId: 'foto_nova' });
    await photoHandler(ctx);

    const updated = await db.query.players.findFirst({
      where: and(eq(players.gameId, game.id), eq(players.userId, 6007)),
    });
    expect(updated!.photoFileId).toBe('foto_nova');
  });
});
