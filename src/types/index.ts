type Phase = 'waiting' | 'character-select' | 'playing' | 'finished';
type QAAnswer = 'yes' | 'no';

type Player = {
  id: string;
  name: string;
  socketId: string;
  secretCharacter?: string;
};

type GameAction = {
  id: string;
  playerId: string;
  playerName: string;
  type: 'question' | 'guess' | 'elimination' | 'system';
  content: string;
  timestamp: number;
  response?: QAAnswer;
};

type GameState = {
  id: string;
  players: Player[];
  currentTurn: string; // player id
  phase: Phase;
  eliminatedCharacters: string[]; // global for now
  gameHistory: GameAction[];
  winner?: string;
  timeRemaining: number;
};

export { Player, GameAction, GameState, Phase, QAAnswer };
