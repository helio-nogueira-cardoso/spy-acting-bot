import { describe, it, expect } from 'vitest';
import { messages } from '../../src/utils/messages';

describe('mensagens estáticas', () => {
  const staticKeys = [
    'welcome', 'help', 'dmWelcomePlayer', 'selfieReceived', 'selfieAlreadySent',
    'noGameForSelfie', 'alreadyInGame', 'gameFull', 'configRoundsPrompt',
    'configModePrompt', 'gameStarting', 'youLeft', 'cantLeaveMidRound',
    'gameEnded', 'onlyCreatorCanEnd', 'onlyCreatorCanConfig', 'onlyCreatorCanStart',
    'choosePairTarget', 'pairRejected', 'groupComplete', 'alreadyPaired',
    'targetNotAvailable', 'cantPairSelf', 'noPendingRequest', 'addToGroupPrompt',
    'verdictButton', 'spyGuessPrompt', 'verdictConfirmed', 'fairPlayNoVotes',
    'errorGeneric', 'errorDmOnly', 'errorGroupOnly', 'errorNoActiveGame', 'errorNotInGame',
  ] as const;

  it.each(staticKeys)('"%s" é uma string não-vazia', (key) => {
    const value = (messages as any)[key];
    expect(typeof value).toBe('string');
    expect(value.length).toBeGreaterThan(0);
  });
});

describe('mensagens dinâmicas', () => {
  it('gameCreated inclui ID do jogo implicitamente', () => {
    const msg = messages.gameCreated('game_abc123');
    expect(typeof msg).toBe('string');
    expect(msg.length).toBeGreaterThan(0);
  });

  it('joinedGame inclui nome do jogador', () => {
    const msg = messages.joinedGame('Carlos');
    expect(msg).toContain('Carlos');
  });

  it('playerLeft inclui nome do jogador', () => {
    const msg = messages.playerLeft('Maria');
    expect(msg).toContain('Maria');
  });

  it('needToStartDm sem nome', () => {
    const msg = messages.needToStartDm('SpyActingBot');
    expect(msg).toContain('SpyActingBot');
    expect(msg).not.toContain('undefined');
  });

  it('needToStartDm com nome inclui o nome', () => {
    const msg = messages.needToStartDm('SpyActingBot', 'João');
    expect(msg).toContain('João');
    expect(msg).toContain('SpyActingBot');
  });

  it('lobbyStatus lista jogadores', () => {
    const msg = messages.lobbyStatus(['📸 Ana', '⏳ Bob'], 12);
    expect(msg).toContain('Ana');
    expect(msg).toContain('Bob');
    expect(msg).toContain('2/12');
  });

  it('agentDm contém local, personagem e parceiro', () => {
    const msg = messages.agentDm(1, 5, 'Hospital', 'Cirurgião', 'Dupla: Enfermeira');
    expect(msg).toContain('Hospital');
    expect(msg).toContain('Cirurgião');
    expect(msg).toContain('Enfermeira');
  });

  it('agentDm NÃO vaza a dica do espião (Bug #1)', () => {
    const msg = messages.agentDm(1, 5, 'Hospital', 'Cirurgião', 'Dupla: Enfermeira');
    expect(msg).not.toContain('Dica do Espião');
    expect(msg).not.toContain('💡');
  });

  it('agentDm não tem parâmetro dedicado a dica do espião (Bug #1)', () => {
    // A assinatura tem 5 parâmetros — sem spyHint entre eles
    expect(messages.agentDm.length).toBe(5);
  });

  it('spyDm contém dica e disfarce', () => {
    const msg = messages.spyDm(2, 5, 'Pulso', 'Intruso');
    expect(msg).toContain('ESPIÃO');
    expect(msg).toContain('Pulso');
    expect(msg).toContain('Intruso');
  });

  it('roundResult formata todas as seções', () => {
    const msg = messages.roundResult({
      roundNumber: 1,
      totalRounds: 5,
      location: 'Hospital',
      spyName: 'Ana',
      spyHint: 'Pulso',
      spyGuess: 'Hospital',
      spyGuessResult: '✅',
      correctGroups: '  Dupla 1: A + B',
      formedGroups: '  A + B',
      scores: '  Ana: +3',
      leaderboard: '🥇 Ana: 3 pts',
    });
    expect(msg).toContain('Hospital');
    expect(msg).toContain('Ana');
    expect(msg).toContain('Pulso');
    expect(msg).toContain('RESULTADO');
  });

  it('missingVerdicts lista nomes pendentes', () => {
    const msg = messages.missingVerdicts(['Carlos', 'Diana']);
    expect(msg).toContain('Carlos');
    expect(msg).toContain('Diana');
  });

  it('configMenu mostra rodadas e modo', () => {
    const msg = messages.configMenu(5, 'auto');
    expect(msg).toContain('5');
    expect(msg).toContain('Automático');
  });

  it('fairPlayVote mostra chute e local correto', () => {
    const msg = messages.fairPlayVote('Escola', 'Hospital');
    expect(msg).toContain('Escola');
    expect(msg).toContain('Hospital');
  });
});
