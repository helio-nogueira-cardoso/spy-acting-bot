import { logger } from '../utils/logger';

export function normalizeString(s: string): string {
  return s.toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

export function isSpyGuessCorrect(guess: string, correctLocation: string): boolean {
  return normalizeString(guess) === normalizeString(correctLocation);
}

interface RoundScoring {
  correctGroups: number[][];
  formedGroups: number[][];
  spyPlayerId: number;
  spyGuessApproved: boolean;
}

function isGroupCorrect(
  formedGroup: number[],
  correctGroups: number[][],
  spyId: number
): boolean {
  const agentsInFormed = formedGroup.filter(id => id !== spyId);

  for (const correctGroup of correctGroups) {
    if (agentsInFormed.every(id => correctGroup.includes(id))) {
      const correctAgentsInFormed = correctGroup.filter(id => agentsInFormed.includes(id));
      if (correctAgentsInFormed.length === correctGroup.length) {
        return true;
      }
    }
  }

  return false;
}

export function calculateRoundScores(scoring: RoundScoring): Map<number, number> {
  const scores = new Map<number, number>();
  const allAgents = scoring.correctGroups.flat();
  const allPlayerIds = [...allAgents, scoring.spyPlayerId];

  // Inicializar todos com 0
  allPlayerIds.forEach(id => scores.set(id, 0));

  // 1. Espião acertou o local?
  if (scoring.spyGuessApproved) {
    scores.set(scoring.spyPlayerId, (scores.get(scoring.spyPlayerId) || 0) + 1);
  }

  // 2. Verificar infiltração do espião
  const spyGroup = scoring.formedGroups.find(g => g.includes(scoring.spyPlayerId));
  const spyWithAgents = spyGroup && spyGroup.some(id => id !== scoring.spyPlayerId);

  if (spyWithAgents) {
    scores.set(scoring.spyPlayerId, (scores.get(scoring.spyPlayerId) || 0) + 2);
  }

  // 3. Calcular pontos dos agentes
  const spyIsIsolated = !spyWithAgents;

  for (const agentId of allAgents) {
    const formedGroup = scoring.formedGroups.find(g => g.includes(agentId));

    if (!formedGroup) {
      scores.set(agentId, 0);
      continue;
    }

    const isCorrect = isGroupCorrect(formedGroup, scoring.correctGroups, scoring.spyPlayerId);

    if (isCorrect) {
      scores.set(agentId, (scores.get(agentId) || 0) + 1);

      // Bônus: espião isolado E NÃO acertou o local
      if (spyIsIsolated && !scoring.spyGuessApproved) {
        scores.set(agentId, (scores.get(agentId) || 0) + 1);
      }
    } else {
      scores.set(agentId, 0);
    }
  }

  return scores;
}
