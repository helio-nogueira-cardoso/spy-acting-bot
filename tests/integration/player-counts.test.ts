/**
 * Testes paramétricos para cada tamanho de jogo (3 a 12 jogadores).
 *
 * Para cada N:
 * - Verifica formação de grupos (calculateGroups)
 * - Verifica que rodada fecha corretamente (spy isolado ou não)
 * - Variante A: criador participa como jogador
 * - Variante B: criador é configurador externo (nunca entrou)
 */
import { describe, it, expect } from 'vitest';
import { calculateGroups } from '../../src/engine/groups';
import { createGame, joinGame, leaveGame, validateGameStart } from '../../src/engine/lobby';
import { checkRoundClose } from '../../src/engine/verdict';
import { createTestGame, createTestPlayer, createFullRoundScenario } from '../helpers/factories';
import { createMockApi } from '../helpers/mock-api';
import { db } from '../../src/db/connection';
import { playerRoundState, rounds, games } from '../../src/db/schema';
import { eq, and } from 'drizzle-orm';

// ─── Helpers ────────────────────────────────────────────────────

function expectedGroupStructure(numAgents: number): { duos: number; trios: number; unpairedAgents: number } {
  if (numAgents % 2 === 0) {
    return { duos: numAgents / 2, trios: 0, unpairedAgents: 0 };
  } else {
    return { duos: (numAgents - 3) / 2, trios: 1, unpairedAgents: 0 };
  }
}

// ─── Formação de grupos para cada N ─────────────────────────────

describe.each([3, 4, 5, 6, 7, 8, 9, 10, 11, 12])(
  'calculateGroups com %i jogadores',
  (N) => {
    const numAgents = N - 1;
    const expected = expectedGroupStructure(numAgents);

    it(`${numAgents} agentes → ${expected.trios} trio(s) + ${expected.duos} dupla(s)`, () => {
      const ids = Array.from({ length: N }, (_, i) => i + 1);
      const spyId = 1;
      const result = calculateGroups(ids, spyId);

      // Spy excluído
      expect(result.spyPlayerId).toBe(spyId);
      const allGrouped = result.groups.flat();
      expect(allGrouped).not.toContain(spyId);

      // Todos os agentes agrupados
      expect(allGrouped).toHaveLength(numAgents);

      // Contagem correta de trios e duplas
      const trios = result.groupTypes.filter(t => t === 'trio').length;
      const duos = result.groupTypes.filter(t => t === 'duo').length;
      expect(trios).toBe(expected.trios);
      expect(duos).toBe(expected.duos);

      // Tamanhos dos grupos corretos
      for (let i = 0; i < result.groups.length; i++) {
        const size = result.groupTypes[i] === 'trio' ? 3 : 2;
        expect(result.groups[i]).toHaveLength(size);
      }
    });
  }
);

// ─── Rodada fecha corretamente para cada N ──────────────────────

describe.each([3, 4, 5, 6, 7, 8, 9, 10, 11, 12])(
  'rodada fecha com %i jogadores',
  (N) => {
    const numAgents = N - 1;
    // Spy é sempre isolado (não está em nenhum grupo de agentes)
    // Com N-1 agentes pares: todos pareados, spy isolado
    // Com N-1 agentes ímpares: não deveria acontecer com grupos corretos
    // calculateGroups sempre agrupa TODOS os agentes (ímpar → 1 trio + duplas)
    // Então sempre spy é o único isolado

    it(`todos os agentes pareados + spy isolado → rodada fecha`, async () => {
      const { round, players, spyPlayer } = await createFullRoundScenario({
        playerCount: N,
        spyIndex: 0,
      });

      const agents = players.filter(p => p.id !== spyPlayer.id);
      expect(agents).toHaveLength(numAgents);

      // Montar grupos conforme calculateGroups faria
      const groups: number[][] = [];
      if (numAgents % 2 === 0) {
        for (let i = 0; i < numAgents; i += 2) {
          groups.push([agents[i].id, agents[i + 1].id]);
        }
      } else {
        groups.push([agents[0].id, agents[1].id, agents[2].id]);
        for (let i = 3; i < numAgents; i += 2) {
          groups.push([agents[i].id, agents[i + 1].id]);
        }
      }

      // Marcar todos os agentes como pareados com veredito
      for (const group of groups) {
        const pairedWith = JSON.stringify(group);
        for (const pid of group) {
          await db.update(playerRoundState)
            .set({ pairingStatus: 'paired', pairedWith, verdictActive: 1 })
            .where(and(eq(playerRoundState.roundId, round.id), eq(playerRoundState.playerId, pid)));
        }
      }

      // Spy continua unpaired (isolado)
      const api = createMockApi();
      await checkRoundClose(round.id, api);

      const updated = await db.query.rounds.findFirst({ where: eq(rounds.id, round.id) });
      expect(updated!.status).toBe('closed');
    });
  }
);

// ─── Variante: criador como jogador vs configurador ─────────────

describe.each([3, 5, 8, 12])(
  'lobby com %i jogadores — criador jogador vs configurador',
  (N) => {
    it(`criador PARTICIPA como jogador: valida início com ${N} jogadores`, async () => {
      const creatorId = 10000;
      const game = await createTestGame({ creatorId, status: 'lobby' });

      // Criador entra como jogador
      await createTestPlayer(game.id, { userId: creatorId, photoFileId: 'creator_photo' });

      // Demais jogadores
      for (let i = 1; i < N; i++) {
        await createTestPlayer(game.id, { userId: creatorId + i, photoFileId: `photo_${i}` });
      }

      const result = await validateGameStart(game.id);
      expect(result.valid).toBe(true);

      // Se criador sai, transfere
      if (N > 1) {
        const leaveResult = await leaveGame(game.id, creatorId);
        expect(leaveResult.success).toBe(true);
        if (N > 1) {
          expect(leaveResult.newCreatorUserId).toBeDefined();
        }

        // Jogo continua com N-1 jogadores
        const { getPlayersInGame } = await import('../../src/utils/validators');
        const remaining = await getPlayersInGame(game.id);
        expect(remaining).toHaveLength(N - 1);
      }
    });

    it(`criador NÃO participa (configurador externo): valida início com ${N} jogadores`, async () => {
      const creatorId = 20000;
      const game = await createTestGame({ creatorId, status: 'lobby' });

      // Criador NÃO entra como jogador
      // Apenas outros entram
      for (let i = 0; i < N; i++) {
        await createTestPlayer(game.id, { userId: creatorId + 100 + i, photoFileId: `photo_${i}` });
      }

      const result = await validateGameStart(game.id);
      expect(result.valid).toBe(true);

      // Todos saem um por um
      for (let i = 0; i < N; i++) {
        const userId = creatorId + 100 + i;
        const r = await leaveGame(game.id, userId);
        expect(r.success).toBe(true);

        if (i === N - 1) {
          // Último a sair: jogo é limpo
          expect(r.gameEnded).toBe(true);
        }
      }

      // Jogo deve ter sido completamente removido
      const afterGame = await db.query.games.findFirst({ where: eq(games.id, game.id) });
      expect(afterGame).toBeUndefined();
    });
  }
);
