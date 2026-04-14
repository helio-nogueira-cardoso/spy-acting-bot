import { describe, it, expect } from 'vitest';
import { normalizeString, isSpyGuessCorrect, calculateRoundScores } from '../../src/engine/scoring';

describe('normalizeString', () => {
  it('converte para minúsculas', () => {
    expect(normalizeString('Hospital')).toBe('hospital');
  });

  it('remove acentos', () => {
    expect(normalizeString('Café')).toBe('cafe');
    expect(normalizeString('São Paulo')).toBe('saopaulo');
    expect(normalizeString('Ação')).toBe('acao');
  });

  it('remove caracteres especiais', () => {
    expect(normalizeString('Star-Wars')).toBe('starwars');
    expect(normalizeString('Rock & Roll')).toBe('rockroll');
  });

  it('remove espaços', () => {
    expect(normalizeString('  hello  world  ')).toBe('helloworld');
  });

  it('string vazia retorna vazia', () => {
    expect(normalizeString('')).toBe('');
  });
});

describe('isSpyGuessCorrect', () => {
  it('match exato retorna true', () => {
    expect(isSpyGuessCorrect('Hospital', 'Hospital')).toBe(true);
  });

  it('case diferente retorna true', () => {
    expect(isSpyGuessCorrect('hospital', 'HOSPITAL')).toBe(true);
  });

  it('acentos diferentes retorna true', () => {
    expect(isSpyGuessCorrect('cafe', 'Café')).toBe(true);
  });

  it('espaçamento diferente retorna true', () => {
    expect(isSpyGuessCorrect('São Paulo', 'sao paulo')).toBe(true);
  });

  it('chute errado retorna false', () => {
    expect(isSpyGuessCorrect('Escola', 'Hospital')).toBe(false);
  });

  it('string parcial retorna false', () => {
    expect(isSpyGuessCorrect('Hosp', 'Hospital')).toBe(false);
  });
});

describe('calculateRoundScores', () => {
  const makeScoring = (overrides: Record<string, any> = {}) => ({
    correctGroups: overrides.correctGroups ?? [[2, 3]],
    formedGroups: overrides.formedGroups ?? [[2, 3]],
    spyPlayerId: overrides.spyPlayerId ?? 1,
    spyGuessApproved: overrides.spyGuessApproved ?? false,
  });

  it('agentes formando grupo correto + espião isolado + sem chute = 2 pts por agente', () => {
    const scores = calculateRoundScores(makeScoring({
      correctGroups: [[2, 3]],
      formedGroups: [[2, 3]],
      spyPlayerId: 1,
      spyGuessApproved: false,
    }));
    expect(scores.get(2)).toBe(2); // 1 grupo correto + 1 bônus spy isolado
    expect(scores.get(3)).toBe(2);
    expect(scores.get(1)).toBe(0); // spy isolado, sem chute
  });

  it('espião acertou o local = +1 pt para spy', () => {
    const scores = calculateRoundScores(makeScoring({
      spyGuessApproved: true,
    }));
    expect(scores.get(1)).toBe(1);
  });

  it('espião infiltrado em grupo = +2 pts para spy', () => {
    const scores = calculateRoundScores(makeScoring({
      correctGroups: [[2, 3]],
      formedGroups: [[1, 2]], // spy + agente
      spyPlayerId: 1,
      spyGuessApproved: false,
    }));
    expect(scores.get(1)).toBe(2); // infiltração
  });

  it('espião infiltrado + acertou local = +3 pts para spy', () => {
    const scores = calculateRoundScores(makeScoring({
      correctGroups: [[2, 3]],
      formedGroups: [[1, 2]],
      spyPlayerId: 1,
      spyGuessApproved: true,
    }));
    expect(scores.get(1)).toBe(3); // 1 chute + 2 infiltração
  });

  it('agentes formando grupo errado = 0 pts', () => {
    const scores = calculateRoundScores(makeScoring({
      correctGroups: [[2, 3], [4, 5]],
      formedGroups: [[2, 4], [3, 5]], // grupos trocados
      spyPlayerId: 1,
      spyGuessApproved: false,
    }));
    expect(scores.get(2)).toBe(0);
    expect(scores.get(3)).toBe(0);
    expect(scores.get(4)).toBe(0);
    expect(scores.get(5)).toBe(0);
  });

  it('agente isolado (sem grupo formado) = 0 pts', () => {
    const scores = calculateRoundScores(makeScoring({
      correctGroups: [[2, 3]],
      formedGroups: [], // ninguém formou grupo
      spyPlayerId: 1,
      spyGuessApproved: false,
    }));
    expect(scores.get(2)).toBe(0);
    expect(scores.get(3)).toBe(0);
  });

  it('cenário misto: alguns corretos, alguns errados', () => {
    const scores = calculateRoundScores(makeScoring({
      correctGroups: [[2, 3], [4, 5]],
      formedGroups: [[2, 3], [4, 1]], // grupo 1 correto, grupo 2 com spy
      spyPlayerId: 1,
      spyGuessApproved: false,
    }));
    expect(scores.get(2)).toBe(1);  // grupo correto mas spy não isolado
    expect(scores.get(3)).toBe(1);
    expect(scores.get(4)).toBe(0);  // grupo errado (com spy)
    expect(scores.get(1)).toBe(2);  // spy infiltrado
  });

  it('trio correto = 1 pt por agente', () => {
    const scores = calculateRoundScores(makeScoring({
      correctGroups: [[2, 3, 4]],
      formedGroups: [[2, 3, 4]],
      spyPlayerId: 1,
      spyGuessApproved: false,
    }));
    expect(scores.get(2)).toBe(2); // correto + bônus spy isolado
    expect(scores.get(3)).toBe(2);
    expect(scores.get(4)).toBe(2);
  });
});
