import { describe, it, expect } from 'vitest';

describe('smoke: módulos carregam sem erro', () => {
  it('config carrega com BOT_TOKEN do env', async () => {
    const { config } = await import('../../src/config');
    expect(config.botToken).toBeDefined();
    expect(config.botToken.length).toBeGreaterThan(0);
    expect(config.minPlayers).toBe(3);
    expect(config.maxPlayers).toBe(12);
  });

  it('schema exporta todas as tabelas', async () => {
    const schema = await import('../../src/db/schema');
    expect(schema.games).toBeDefined();
    expect(schema.players).toBeDefined();
    expect(schema.rounds).toBeDefined();
    expect(schema.roundRoles).toBeDefined();
    expect(schema.playerRoundState).toBeDefined();
    expect(schema.pairings).toBeDefined();
    expect(schema.spyGuessVotes).toBeDefined();
    expect(schema.manualConfigs).toBeDefined();
  });

  it('conexão com DB funciona (in-memory)', async () => {
    const { db, sqlite } = await import('../../src/db/connection');
    expect(db).toBeDefined();
    expect(sqlite).toBeDefined();
    // Verificar que as tabelas existem
    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    const tableNames = tables.map(t => t.name);
    expect(tableNames).toContain('games');
    expect(tableNames).toContain('players');
    expect(tableNames).toContain('rounds');
  });

  it('types exportam tipos esperados', async () => {
    const types = await import('../../src/types');
    expect(types.VALID_TRANSITIONS).toBeDefined();
    expect(types.VALID_TRANSITIONS.unpaired).toContain('pending_sent');
  });

  it('logger existe e tem métodos padrão', async () => {
    const { logger } = await import('../../src/utils/logger');
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.warn).toBe('function');
  });

  it('messages exporta objeto com chaves esperadas', async () => {
    const { messages } = await import('../../src/utils/messages');
    expect(messages.welcome).toBeDefined();
    expect(messages.help).toBeDefined();
    expect(typeof messages.gameCreated).toBe('function');
    expect(typeof messages.joinedGame).toBe('function');
    expect(typeof messages.playerLeft).toBe('function');
    expect(typeof messages.roundResult).toBe('function');
  });

  it('engine modules importam sem erro', async () => {
    const groups = await import('../../src/engine/groups');
    expect(typeof groups.shuffle).toBe('function');
    expect(typeof groups.calculateGroups).toBe('function');

    const scoring = await import('../../src/engine/scoring');
    expect(typeof scoring.isSpyGuessCorrect).toBe('function');
    expect(typeof scoring.calculateRoundScores).toBe('function');
  });

  it('locations.json carrega e tem estrutura válida', async () => {
    const data = await import('../../src/data/locations.json');
    const locations = data.locations || data.default?.locations;
    expect(Array.isArray(locations)).toBe(true);
    expect(locations.length).toBeGreaterThan(0);

    const first = locations[0];
    expect(first.key).toBeDefined();
    expect(first.name).toBeDefined();
    expect(first.spy_hint).toBeDefined();
    expect(Array.isArray(first.characters)).toBe(true);
    expect(first.characters.length).toBeGreaterThanOrEqual(2);
  });
});
