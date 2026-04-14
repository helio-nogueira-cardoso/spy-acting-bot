export function shuffle<T>(array: T[]): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export interface GroupAssignment {
  groups: number[][];
  groupTypes: ('duo' | 'trio')[];
  spyPlayerId: number;
}

export function calculateGroups(playerIds: number[], spyId: number): GroupAssignment {
  const agents = playerIds.filter(id => id !== spyId);
  const numAgents = agents.length;
  const shuffled = shuffle(agents);

  const groups: number[][] = [];
  const groupTypes: ('duo' | 'trio')[] = [];

  if (numAgents % 2 === 0) {
    for (let i = 0; i < numAgents; i += 2) {
      groups.push([shuffled[i], shuffled[i + 1]]);
      groupTypes.push('duo');
    }
  } else {
    groups.push([shuffled[0], shuffled[1], shuffled[2]]);
    groupTypes.push('trio');
    for (let i = 3; i < numAgents; i += 2) {
      groups.push([shuffled[i], shuffled[i + 1]]);
      groupTypes.push('duo');
    }
  }

  return { groups, groupTypes, spyPlayerId: spyId };
}
