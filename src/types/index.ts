import type { Context, SessionFlavor } from 'grammy';

// Estados do jogo
export type GameStatus = 'lobby' | 'playing' | 'round_active' | 'round_ended' | 'finished';
export type GameMode = 'auto' | 'manual';

// Estados do jogador na rodada
export type PairingStatus = 'unpaired' | 'pending_sent' | 'pending_received' | 'paired';
export type PlayerRole = 'agent' | 'spy';
export type GroupType = 'duo' | 'trio';

// Status de pareamento
export type PairingRequestStatus = 'pending' | 'accepted' | 'rejected' | 'dissolved';

// Status da rodada
export type RoundStatus = 'active' | 'closed';

// Transições válidas do estado do jogador
export const VALID_TRANSITIONS: Record<PairingStatus | 'verdict', string[]> = {
  unpaired: ['pending_sent', 'pending_received'],
  pending_sent: ['unpaired', 'paired'],
  pending_received: ['unpaired', 'paired'],
  paired: ['unpaired', 'verdict'],
  verdict: [],
};

// Session data para Grammy
export interface SessionData {
  gameId?: string;
  currentStep?: string;
}

// Contexto customizado do bot
export type BotContext = Context & SessionFlavor<SessionData>;
