import { beforeEach } from 'vitest';
import { sqlite } from '../src/db/connection';

// Limpar todas as tabelas entre testes (ordem respeitando FK)
beforeEach(() => {
  sqlite.exec(`
    DELETE FROM spy_guess_votes;
    DELETE FROM manual_configs;
    DELETE FROM player_round_state;
    DELETE FROM pairings;
    DELETE FROM round_roles;
    DELETE FROM rounds;
    DELETE FROM players;
    DELETE FROM games;
  `);
});
