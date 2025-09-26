// server.ts
import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import 'dotenv/config';

type Answer = 'yes' | 'no';

type Player = {
  id: string;
  name: string;
  socketId: string;
  secretCharacter?: string;
};

type Phase = 'waiting' | 'character-select' | 'playing' | 'finished';

type GameAction = {
  id: string;
  playerId: string;
  playerName: string;
  type: 'question' | 'guess' | 'elimination' | 'system';
  content: string;
  timestamp: number;
  response?: Answer;
  correct?: boolean;
};

type Room = {
  id: string;
  players: Player[];
  phase: Phase;
  currentTurn: string; // player id
  gameHistory: GameAction[];
  timeRemaining: number;
  winner?: string;
};

type AccessClaims = {
  sub: string;
  nick: string;
  ver: number;
  guest: boolean;
  mmr: number;
};

type QItem = {
  socketId: string;
  userId: string;
  nickname: string;
  mmr: number;
  since: number;
};

const JWT_SECRET = process.env.JWT_SECRET!;
const TURN_SECONDS = 60;
const TICK_MS = 1000;
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

app.get('/', (_req, res) => res.status(200).send({ ok: true }));

// ---- In-memory state ----
const rooms = new Map<string, Room>();
const socketRoom = new Map<string, string>(); // socket.id -> roomId
const roomTimers = new Map<string, NodeJS.Timeout>();

const authQueue: QItem[] = [];
const guestQueue: QItem[] = [];

// ---- Id helpers ----
const newRoomId = () => `room_${Math.random().toString(36).slice(2, 9)}`;
const newId = () => Math.random().toString(36).slice(2, 9);

// ---- room helpers ----
function getRoomBySocket(sid: string): { id: string; room: Room } | null {
  const rid = socketRoom.get(sid);
  if (rid) {
    const r = rooms.get(rid);
    if (r) return { id: rid, room: r };
  }
  // fallback (stale mapping recovery)
  for (const [id, room] of rooms) {
    if (room.players.some((p) => p.socketId === sid)) return { id, room };
  }
  return null;
}

function otherPlayer(room: Room, playerId: string) {
  return room.players.find((p) => p.id !== playerId);
}

function swapTurn(room: Room) {
  const idx = room.players.findIndex((p) => p.id === room.currentTurn);
  if (idx === -1) return;
  const next = (idx + 1) % room.players.length;
  room.currentTurn = room.players[next].id;
}

function emitStateFor(roomId: string, toSocketId?: string) {
  const room = rooms.get(roomId);
  if (!room) return;

  if (toSocketId) {
    const sock = io.sockets.sockets.get(toSocketId);
    if (!sock) return;
    const me = room.players.find((p) => p.socketId === toSocketId);

    sock.emit('state:update', {
      id: room.id,
      phase: room.phase,
      currentTurn: room.currentTurn,
      gameHistory: room.gameHistory,
      timeRemaining: room.timeRemaining,
      winner: room.winner ?? null,
      players: room.players.map((p) => ({
        id: p.id,
        name: p.name,
        // Do NOT expose other players' socketIds to clients.
        // Only include your own socketId if needed client-side.
        socketId: p.id === me?.id ? p.socketId : undefined,
        // Only reveal my secret to me; for others, expose hasPicked.
        secretCharacter: p.id === me?.id ? (p.secretCharacter ?? null) : null,
        hasPicked: !!p.secretCharacter,
      })),
    });
    return;
  }

  // Per-socket fanout to avoid secret leaks
  for (const p of room.players) emitStateFor(roomId, p.socketId);
}

function emitState(roomId: string) {
  emitStateFor(roomId);
}

function startRoomTimer(roomId: string) {
  stopRoomTimer(roomId);
  const timer = setInterval(() => {
    const room = rooms.get(roomId);
    if (!room) return stopRoomTimer(roomId);

    if (room.phase !== 'playing') return; // pause timer outside playing

    room.timeRemaining = Math.max(0, room.timeRemaining - 1);
    emitState(roomId);

    if (room.timeRemaining === 0) {
      // auto-advance on timeout
      swapTurn(room);
      room.timeRemaining = TURN_SECONDS;
      emitState(roomId);
    }
  }, TICK_MS);
  roomTimers.set(roomId, timer);
}

function stopRoomTimer(roomId: string) {
  const t = roomTimers.get(roomId);
  if (t) {
    clearInterval(t);
    roomTimers.delete(roomId);
  }
}

// ---- matchmaking helpers ----
function placeInQueue(socket: Socket) {
  const q = socket.data.guest ? guestQueue : authQueue;
  const me: QItem = {
    socketId: socket.id,
    userId: socket.data.userId,
    nickname: socket.data.nickname,
    mmr: socket.data.mmr,
    since: Date.now(),
  };
  // Avoid duplicates
  if (!q.some((x) => x.socketId === socket.id)) {
    q.push(me);
    socket.emit('match:searching');
  }
}

function removeFromQueues(socketId: string) {
  const remove = (q: QItem[]) => {
    const idx = q.findIndex((i) => i.socketId === socketId);
    if (idx !== -1) q.splice(idx, 1);
  };
  remove(authQueue);
  remove(guestQueue);
}

function tryMatchQueue(q: QItem[]) {
  if (q.length < 2) return;

  // sort by time waiting to promote fairness
  q.sort((a, b) => a.since - b.since);

  let i = 0;
  while (i < q.length - 1) {
    const a = q[i];
    // dynamic range grows with wait time
    const waitedSec = (Date.now() - a.since) / 1000;
    const base = 50; // ±50 MMR initially
    const grow = Math.min(400, Math.floor(waitedSec / 15) * 50); // widen up to ±450
    const window = base + grow;

    // find best match for a
    let bestJ = -1;
    let bestGap = Infinity;
    for (let j = i + 1; j < q.length; j++) {
      const b = q[j];
      const gap = Math.abs(a.mmr - b.mmr);
      if (gap <= window && gap < bestGap) {
        bestGap = gap;
        bestJ = j;
      }
    }

    // if none within window but a waited > 180s, take the closest anyway (same queue type)
    if (bestJ === -1 && waitedSec > 180) {
      for (let j = i + 1; j < q.length; j++) {
        const b = q[j];
        const gap = Math.abs(a.mmr - b.mmr);
        if (gap < bestGap) {
          bestGap = gap;
          bestJ = j;
        }
      }
    }

    if (bestJ !== -1) {
      const [b] = q.splice(bestJ, 1);
      q.splice(i, 1); // remove a
      createRoom(a, b);
      // do NOT increment i because current index was removed
    } else {
      i++; // move on
    }
  }
}

function createRoom(a: QItem, b: QItem) {
  const roomId = newRoomId();
  const room: Room = {
    id: roomId,
    players: [
      { id: a.userId, name: a.nickname, socketId: a.socketId },
      { id: b.userId, name: b.nickname, socketId: b.socketId },
    ],
    phase: 'character-select',
    currentTurn: Math.random() < 0.5 ? a.userId : b.userId,
    gameHistory: [],
    timeRemaining: TURN_SECONDS,
  };

  rooms.set(roomId, room);
  io.sockets.sockets.get(a.socketId)?.join(roomId);
  io.sockets.sockets.get(b.socketId)?.join(roomId);
  socketRoom.set(a.socketId, roomId);
  socketRoom.set(b.socketId, roomId);

  emitState(roomId);
}

// ---- auth middleware (must be before connection handler) ----
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.accessToken;
    if (!token) return next(new Error('no token'));
    const claims = jwt.verify(token, JWT_SECRET) as AccessClaims;

    socket.data.userId = claims.sub;
    socket.data.nickname = claims.nick;
    socket.data.guest = claims.guest;
    socket.data.mmr = claims.mmr;

    next();
  } catch {
    next(new Error('bad token'));
  }
});

// ---- socket handlers ----
io.on('connection', (socket: Socket) => {
  // ---- matchmaking ----
  socket.on('match:find', () => placeInQueue(socket));
  socket.on('match:cancel', () => removeFromQueues(socket.id));

  // ---- character selection ----
  socket.on('character:select', (characterName: string) => {
    const found = getRoomBySocket(socket.id);
    if (!found) return;
    const { id: roomId, room } = found;

    const me = room.players.find((p) => p.socketId === socket.id);
    if (!me) return;

    me.secretCharacter = String(characterName).slice(0, 100);

    // Start when both locked
    if (
      room.players.length >= 2 &&
      room.players.every((p) => !!p.secretCharacter)
    ) {
      room.phase = 'playing';
      room.timeRemaining = TURN_SECONDS;
      startRoomTimer(roomId);
    }

    emitState(roomId);
  });

  // ---- ask a question (only currentTurn can ask) ----
  socket.on('question:ask', (content: string, ack?: (ok: boolean) => void) => {
    const found = getRoomBySocket(socket.id);
    if (!found) return ack?.(false);
    const { id: roomId, room } = found;

    if (room.phase !== 'playing' || room.currentTurn !== socket.data.userId) {
      return ack?.(false);
    }

    const sanitized = String(content ?? '')
      .slice(0, 500)
      .trim();
    if (!sanitized) return ack?.(false);

    room.gameHistory.push({
      id: newId(),
      playerId: socket.data.userId,
      playerName: socket.data.nickname ?? 'Anon',
      type: 'question',
      content: sanitized,
      timestamp: Date.now(),
    });

    emitState(roomId);
    ack?.(true);
  });

  // ---- answer a specific question (only opponent can answer) ----
  socket.on(
    'question:answer',
    (
      payload: { questionId: string; answer: Answer },
      ack?: (ok: boolean) => void
    ) => {
      const found = getRoomBySocket(socket.id);
      if (!found) return ack?.(false);
      const { id: roomId, room } = found;

      const q = room.gameHistory.find((a) => a.id === payload.questionId);
      if (!q || q.type !== 'question' || typeof q.response !== 'undefined') {
        return ack?.(false);
      }

      // Only the opponent of the asker can answer
      if (q.playerId === socket.data.userId) return ack?.(false);

      q.response = payload.answer;

      // swap turn after answer
      swapTurn(room);
      room.timeRemaining = TURN_SECONDS;

      emitState(roomId);
      ack?.(true);
    }
  );

  // ---- final guess (authoritative) ----
  socket.on(
    'guess:make',
    (characterName: string, ack?: (ok: boolean) => void) => {
      const found = getRoomBySocket(socket.id);
      if (!found) return ack?.(false);
      const { id: roomId, room } = found;

      if (room.phase !== 'playing' || room.currentTurn !== socket.data.userId) {
        return ack?.(false);
      }

      const guessName = String(characterName ?? '')
        .slice(0, 120)
        .trim();
      if (!guessName) return ack?.(false);

      const opp = otherPlayer(room, socket.data.userId);
      const isCorrect = opp?.secretCharacter === guessName;

      room.gameHistory.push({
        id: newId(),
        playerId: socket.data.userId,
        playerName: socket.data.nickname ?? 'Anon',
        type: 'guess',
        content: guessName,
        correct: !!isCorrect,
        timestamp: Date.now(),
      });

      if (isCorrect) {
        room.phase = 'finished';
        room.winner = socket.data.userId;
        stopRoomTimer(roomId);
      } else {
        swapTurn(room);
        room.timeRemaining = TURN_SECONDS;
      }

      emitState(roomId);
      ack?.(true);
    }
  );

  // ---- legacy alias (optional): forward to guess:make ----
  socket.on('guess:final', (name: string, ack?: (ok: boolean) => void) => {
    // For legacy clients, just reuse the same logic.
    io.to(socket.id).emit('warn', {
      msg: 'guess:final is deprecated; use guess:make',
    });
    // Call handler by emitting back to server-side; simplest is to just re-run logic inline:
    const found = getRoomBySocket(socket.id);
    if (!found) return ack?.(false);
    const { id: roomId, room } = found;

    if (room.phase !== 'playing' || room.currentTurn !== socket.data.userId) {
      return ack?.(false);
    }

    const guessName = String(name ?? '')
      .slice(0, 120)
      .trim();
    if (!guessName) return ack?.(false);

    const opp = otherPlayer(room, socket.data.userId);
    const isCorrect = opp?.secretCharacter === guessName;

    room.gameHistory.push({
      id: newId(),
      playerId: socket.data.userId,
      playerName: socket.data.nickname ?? 'Anon',
      type: 'guess',
      content: guessName,
      correct: !!isCorrect,
      timestamp: Date.now(),
    });

    if (isCorrect) {
      room.phase = 'finished';
      room.winner = socket.data.userId;
      stopRoomTimer(roomId);
    } else {
      swapTurn(room);
      room.timeRemaining = TURN_SECONDS;
    }

    emitState(roomId);
    ack?.(true);
  });

  // ---- optional logging ----
  socket.on('log:system', (text: string) => {
    const found = getRoomBySocket(socket.id);
    if (!found) return;
    const { id: roomId, room } = found;
    room.gameHistory.push({
      id: newId(),
      playerId: socket.data.userId,
      playerName: socket.data.nickname ?? 'Anon',
      type: 'system',
      content: String(text ?? '').slice(0, 500),
      timestamp: Date.now(),
    });
    emitState(roomId);
  });

  // ---- client-initiated timeout is NOT allowed (server-driven) ----
  socket.on('turn:timeout', (ack?: (ok: boolean) => void) => {
    // Refuse — timer is authoritative on server.
    ack?.(false);
  });

  // ---- disconnect cleanup ----
  socket.on('disconnect', () => {
    // remove from queues
    removeFromQueues(socket.id);

    // drop from room
    const found = getRoomBySocket(socket.id);
    if (!found) return;
    const { id: roomId, room } = found;

    room.players = room.players.filter((p) => p.socketId !== socket.id);
    socketRoom.delete(socket.id);

    if (room.players.length === 1) {
      room.phase = 'finished';
      room.winner = room.players[0].id;
      stopRoomTimer(roomId);
    }

    if (room.players.length === 0) {
      stopRoomTimer(roomId);
      rooms.delete(roomId);
      return;
    }

    emitState(roomId);
  });
});

// ---- global matchmaking pumps ----
setInterval(() => tryMatchQueue(authQueue), 1000);
setInterval(() => tryMatchQueue(guestQueue), 1000);

// ---- boot ----
httpServer.listen(8765, () => {
  console.log('server up on :8765');
});
