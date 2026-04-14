import { describe, it, expect } from 'vitest';
import { shuffle, calculateGroups } from '../../src/engine/groups';

describe('shuffle', () => {
  it('retorna array com os mesmos elementos', () => {
    const input = [1, 2, 3, 4, 5];
    const result = shuffle(input);
    expect(result).toHaveLength(input.length);
    expect(result.sort()).toEqual(input.sort());
  });

  it('não modifica o array original', () => {
    const input = [1, 2, 3, 4, 5];
    const copy = [...input];
    shuffle(input);
    expect(input).toEqual(copy);
  });

  it('funciona com array vazio', () => {
    expect(shuffle([])).toEqual([]);
  });

  it('funciona com array de 1 elemento', () => {
    expect(shuffle([42])).toEqual([42]);
  });
});

describe('calculateGroups', () => {
  it('3 jogadores (min): 1 spy + 1 dupla de agentes', () => {
    const result = calculateGroups([1, 2, 3], 1);
    expect(result.spyPlayerId).toBe(1);
    expect(result.groups).toHaveLength(1);
    expect(result.groupTypes).toEqual(['duo']);
    expect(result.groups[0]).toHaveLength(2);
    expect(result.groups[0]).not.toContain(1); // spy excluído
  });

  it('4 jogadores: 1 spy + 1 trio de agentes', () => {
    const result = calculateGroups([1, 2, 3, 4], 1);
    expect(result.groups).toHaveLength(1);
    expect(result.groupTypes).toEqual(['trio']);
    expect(result.groups[0]).toHaveLength(3);
  });

  it('5 jogadores: 1 spy + 2 duplas', () => {
    const result = calculateGroups([1, 2, 3, 4, 5], 1);
    expect(result.groups).toHaveLength(2);
    expect(result.groupTypes).toEqual(['duo', 'duo']);
  });

  it('6 jogadores: 1 spy + 1 trio + 1 dupla', () => {
    const result = calculateGroups([1, 2, 3, 4, 5, 6], 1);
    expect(result.groups).toHaveLength(2);
    expect(result.groupTypes).toContain('trio');
    expect(result.groupTypes).toContain('duo');
  });

  it('7 jogadores: 1 spy + 3 duplas', () => {
    const result = calculateGroups([1, 2, 3, 4, 5, 6, 7], 1);
    expect(result.groups).toHaveLength(3);
    expect(result.groupTypes).toEqual(['duo', 'duo', 'duo']);
  });

  it('spy nunca aparece em nenhum grupo', () => {
    for (let n = 3; n <= 12; n++) {
      const ids = Array.from({ length: n }, (_, i) => i + 1);
      const spyId = ids[0];
      const result = calculateGroups(ids, spyId);
      for (const group of result.groups) {
        expect(group).not.toContain(spyId);
      }
    }
  });

  it('todos os agentes estão em exatamente um grupo', () => {
    const ids = [10, 20, 30, 40, 50, 60];
    const spyId = 10;
    const result = calculateGroups(ids, spyId);
    const allGrouped = result.groups.flat();
    const agents = ids.filter(id => id !== spyId);
    expect(allGrouped.sort()).toEqual(agents.sort());
  });

  it('funciona com o spy no meio da lista', () => {
    const result = calculateGroups([1, 2, 3, 4, 5], 3);
    expect(result.spyPlayerId).toBe(3);
    const allGrouped = result.groups.flat();
    expect(allGrouped).not.toContain(3);
    expect(allGrouped).toHaveLength(4);
  });
});
