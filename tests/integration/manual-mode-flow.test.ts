import { describe, it, expect } from 'vitest';
import { findPendingManualConfigGame } from '../../src/handlers/conversations';
import { createTestGame, createTestPlayer, createTestRound } from '../helpers/factories';

describe('findPendingManualConfigGame (Bug #3)', () => {
  it('retorna o jogo quando o criador é configurador manual e a rodada N+1 ainda não existe', async () => {
    const creatorId = 42001;
    const game = await createTestGame({
      creatorId,
      mode: 'manual',
      status: 'playing',
      currentRound: 0,
      totalRounds: 5,
    });

    const result = await findPendingManualConfigGame(creatorId);
    expect(result).not.toBeNull();
    expect(result!.game.id).toBe(game.id);
    expect(result!.nextRoundNumber).toBe(1);
  });

  it('retorna jogo em round_ended (entre rodadas do modo manual)', async () => {
    const creatorId = 42002;
    const game = await createTestGame({
      creatorId,
      mode: 'manual',
      status: 'round_ended',
      currentRound: 1,
      totalRounds: 3,
    });
    // Rodada 1 existe; o prompt agora é para a rodada 2
    const p = await createTestPlayer(game.id);
    await createTestRound(game.id, { roundNumber: 1, spyPlayerId: p.id, status: 'closed' });

    const result = await findPendingManualConfigGame(creatorId);
    expect(result).not.toBeNull();
    expect(result!.nextRoundNumber).toBe(2);
  });

  it('ignora jogos em modo automático', async () => {
    const creatorId = 42003;
    await createTestGame({ creatorId, mode: 'auto', status: 'playing', currentRound: 0 });

    const result = await findPendingManualConfigGame(creatorId);
    expect(result).toBeNull();
  });

  it('ignora se a próxima rodada já foi criada (aguardando fechar, não configurar)', async () => {
    const creatorId = 42004;
    const game = await createTestGame({
      creatorId,
      mode: 'manual',
      status: 'round_active',
      currentRound: 1,
    });
    const p = await createTestPlayer(game.id);
    await createTestRound(game.id, { roundNumber: 1, spyPlayerId: p.id, status: 'active' });

    // Agora simula currentRound=0 (no DB o update para currentRound=1 só acontece em startManualRound)
    // Mas com rodada 1 já criada no DB, não devemos pedir configuração
    const result = await findPendingManualConfigGame(creatorId);
    // Com status round_active, já filtramos fora — além da rodada estar criada
    expect(result).toBeNull();
  });

  it('ignora se todas as rodadas já foram jogadas', async () => {
    const creatorId = 42005;
    await createTestGame({
      creatorId,
      mode: 'manual',
      status: 'round_ended',
      currentRound: 5,
      totalRounds: 5,
    });

    const result = await findPendingManualConfigGame(creatorId);
    expect(result).toBeNull();
  });

  it('ignora se usuário não é criador do jogo', async () => {
    await createTestGame({
      creatorId: 99999,
      mode: 'manual',
      status: 'playing',
      currentRound: 0,
    });

    const result = await findPendingManualConfigGame(12345);
    expect(result).toBeNull();
  });
});
