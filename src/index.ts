import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';

import { matches, matchParticipants, users } from './db/schema';
import { asc, desc, eq, inArray, sql } from 'drizzle-orm';
import 'dotenv/config';
import { db } from './db/client';

type Answer = 'yes' | 'no';

type Player = {
  id: string;
  name: string;
  socketId: string;
  secretCharacter?: string;
  mmr: number;
  guest: boolean;
  isConnected?: boolean;
};

type QItem = {
  socketId: string;
  userId: string;
  nickname: string;
  mmr: number;
  guest: boolean;
  since: number;
};

const reconnectTimers = new Map<string, NodeJS.Timeout>();
const GRACE_MS = 30_000;

type Phase =
  | 'waiting'
  | 'character-select'
  | 'playing'
  | 'finalize'
  | 'finished';

type Visibility = 'public' | 'private';
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
  currentTurn: string;
  gameHistory: GameAction[];
  timeRemaining: number;
  winner?: string | null;
  mode?: 'ranked' | 'casual' | 'custom';
  finalizeActive?: boolean;
  finalizeGuesses?: Record<
    string,
    { playerId: string; name: string; correct: boolean; secret: string }
  >;

  mmrCommitted?: boolean;
  isCustom?: boolean;
  roomName?: string;
  hostId?: string;
  visibility?: 'public' | 'private';
  password?: string | null; // for demo; consider hashing in prod
  inviteCode?: string; // e.g., 6-char code
};

type AccessClaims = {
  sub: string;
  email?: string;
  nickname: string;
  tokenVersion: number; // <-- match your JWT payload
  guest?: boolean;
  mmr?: number | string; // <-- we will ignore this for signed-in users
};

const JWT_SECRET = process.env.JWT_SECRET!;
const TURN_SECONDS = 60;
const TICK_MS = 1000;
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

app.get('/', (_req, res) => res.status(200).send({ ok: true }));

const rooms = new Map<string, Room>();
const socketRoom = new Map<string, string>();
const roomTimers = new Map<string, NodeJS.Timeout>();

const authQueue: QItem[] = [];
const guestQueue: QItem[] = [];

const newRoomId = () => `room_${Math.random().toString(36).slice(2, 9)}`;
const newId = () => Math.random().toString(36).slice(2, 9);

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    s
  );
}

function newInviteCode(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++)
    out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function canStartCustom(room: Room) {
  return room.isCustom && room.players.length === 2;
}

function getRoomBySocket(sid: string): { id: string; room: Room } | null {
  const rid = socketRoom.get(sid);
  if (rid) {
    const r = rooms.get(rid);
    if (r) return { id: rid, room: r };
  }
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
      finalizeActive: !!room.finalizeActive,

      // NEW: surface useful meta for UI
      isCustom: !!(room as any).isCustom,
      roomName: (room as any).roomName ?? null,
      visibility: (room as any).visibility ?? 'public',
      inviteCode: (room as any).inviteCode ?? null,
      hostId: (room as any).hostId ?? null,

      players: room.players.map((p) => ({
        id: p.id,
        name: p.name,
        socketId: p.id === me?.id ? p.socketId : undefined,
        isConnected: p.isConnected,
        secretCharacter: p.id === me?.id ? (p.secretCharacter ?? null) : null,
        hasPicked: !!p.secretCharacter,
        guest: !!p.guest,
      })),
    });
    return;
  }
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

    if (room.phase !== 'playing') return;

    room.timeRemaining = Math.max(0, room.timeRemaining - 1);
    emitState(roomId);

    if (room.timeRemaining === 0) {
      const pending = [...room.gameHistory]
        .reverse()
        .find(
          (a) =>
            a.type === 'question' && typeof (a as any).response === 'undefined'
        );

      if (pending) {
        (pending as any).response = 'no';
        (pending as any).timeout = true;

        const asker = room.players.find((p) => p.id === pending.playerId);
        const answerer = otherPlayer(room, pending.playerId);

        if (asker) io.to(asker.socketId).emit('advantage:timeout', { roomId });

        if (answerer) room.currentTurn = answerer.id;

        room.timeRemaining = TURN_SECONDS;
        emitState(roomId);
        return;
      }

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

function placeInQueue(socket: Socket) {
  const q = socket.data.guest ? guestQueue : authQueue;
  const me: QItem = {
    socketId: socket.id,
    userId: socket.data.userId,
    nickname: socket.data.nickname,
    mmr: Number(socket.data.mmr) || 1200,
    guest: !!socket.data.guest,
    since: Date.now(),
  };
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

  q.sort((a, b) => a.since - b.since);
  let i = 0;
  while (i < q.length - 1) {
    const a = q[i];
    const waitedSec = (Date.now() - a.since) / 1000;
    const base = 50;
    const grow = Math.min(400, Math.floor(waitedSec / 15) * 50);
    const window = base + grow;

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
      q.splice(i, 1);
      createRoom(a, b);
    } else {
      i++;
    }
  }
}

function createRoom(a: QItem, b: QItem) {
  const roomId = newRoomId();
  const room: Room = {
    id: roomId,
    players: [
      {
        id: a.userId,
        name: a.nickname,
        socketId: a.socketId,
        mmr: a.mmr,
        guest: a.guest,
      },
      {
        id: b.userId,
        name: b.nickname,
        socketId: b.socketId,
        mmr: b.mmr,
        guest: b.guest,
      },
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
  io.to(a.socketId).emit('match:found', { roomId, opponent: b.nickname });
  io.to(b.socketId).emit('match:found', { roomId, opponent: a.nickname });
  emitState(roomId);
}

function findRoomByUserId(userId: string): { id: string; room: Room } | null {
  for (const [id, room] of rooms) {
    if (room.players.some((p) => p.id === userId)) return { id, room };
  }
  return null;
}

function resumeIfAny(socket: Socket): { id: string; room: Room } | null {
  const found = findRoomByUserId(socket.data.userId);
  if (!found) return null;

  const { id, room } = found;
  const player = room.players.find((p) => p.id === socket.data.userId)!;

  const oldSid = player.socketId;
  player.socketId = socket.id;
  player.isConnected = true;
  socket.join(id);
  socketRoom.delete(oldSid);
  socketRoom.set(socket.id, id);

  emitStateFor(id, socket.id);
  return { id, room };
}

type Outcome = 'win' | 'loss' | 'draw';

function expectedScore(my: number, opp: number) {
  return 1 / (1 + Math.pow(10, (opp - my) / 400));
}
function kFactor(mmr: number) {
  if (mmr < 1200) return 40;
  if (mmr < 1800) return 32;
  return 24;
}
function gapMultiplier(my: number, opp: number, outcome: Outcome) {
  const gap = Math.abs(my - opp);
  const m = 1 + Math.min(0.5, gap / 800);
  if (outcome === 'win' && my < opp) return m;
  if (outcome === 'loss' && my > opp) return m;
  return 1;
}
function eloDelta(my: number, opp: number, outcome: Outcome) {
  const S = outcome === 'win' ? 1 : outcome === 'draw' ? 0.5 : 0;
  const E = expectedScore(my, opp);
  const K = kFactor(my);
  const mult = gapMultiplier(my, opp, outcome);
  return Math.round(K * mult * (S - E));
}

function computeDeltas(
  aMMR: number,
  bMMR: number,
  winner?: 'A' | 'B' | null
): { a: number; b: number } {
  if (winner == null) {
    const da = eloDelta(aMMR, bMMR, 'draw');
    const db = eloDelta(bMMR, aMMR, 'draw');
    return { a: da, b: db };
  }
  const aOutcome: Outcome = winner === 'A' ? 'win' : 'loss';
  const bOutcome: Outcome = winner === 'B' ? 'win' : 'loss';
  const da = eloDelta(aMMR, bMMR, aOutcome);
  const db = eloDelta(bMMR, aMMR, bOutcome);
  return { a: da, b: db };
}

async function awardMMRAndPersist(
  room: Room,
  fr: { winner: string | null; tie: boolean },
  final: {
    gA: { playerId: string; name: string; correct: boolean; secret: string };
    gB: { playerId: string; name: string; correct: boolean; secret: string };
  }
) {
  if (room.mmrCommitted) return null;

  const [A, B] = room.players;
  if (!A || !B) {
    // Avoid persisting if we somehow lost a participant; mark committed.
    room.mmrCommitted = true;
    return {
      aDelta: 0,
      bDelta: 0,
      aAfter: A?.mmr ?? 1200,
      bAfter: B?.mmr ?? 1200,
    };
  }

  if (A.guest || B.guest || !isUuid(A.id) || !isUuid(B.id)) {
    room.mmrCommitted = true;
    return { aDelta: 0, bDelta: 0, aAfter: A.mmr, bAfter: B.mmr };
  }

  const ranked = !room.isCustom && !(A.guest || B.guest);

  const winnerTag: 'A' | 'B' | null = fr.tie
    ? null
    : fr.winner === A.id
      ? 'A'
      : fr.winner === B.id
        ? 'B'
        : null;

  const { a: aDelta, b: bDelta } = computeDeltas(A.mmr, B.mmr, winnerTag);
  const aAfter = A.mmr + aDelta;
  const bAfter = B.mmr + bDelta;

  const aExpGain = fr.tie ? 10 : fr.winner === A.id ? 30 : 5;
  const bExpGain = fr.tie ? 10 : fr.winner === B.id ? 30 : 5;

  let aExpBefore = 0,
    bExpBefore = 0,
    aExpAfter = 0,
    bExpAfter = 0;

  await db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: users.id, exp: users.exp })
      .from(users)
      .where(inArray(users.id, [A.id, B.id]));

    for (const r of rows) {
      if (r.id === A.id) aExpBefore = r.exp ?? 0;
      if (r.id === B.id) bExpBefore = r.exp ?? 0;
    }

    if (ranked) {
      const [aUpd] = await tx
        .update(users)
        .set({
          mmr: aAfter,
          exp: sql`${users.exp} + ${aExpGain}`,
          wins: sql`${users.wins} + ${fr.winner === A.id ? 1 : 0}`,
          losses: sql`${users.losses} + ${fr.winner === B.id ? 1 : 0}`,
          updatedAt: sql`now()`,
        })
        .where(eq(users.id, A.id))
        .returning({ exp: users.exp });

      const [bUpd] = await tx
        .update(users)
        .set({
          mmr: bAfter,
          exp: sql`${users.exp} + ${bExpGain}`,
          wins: sql`${users.wins} + ${fr.winner === B.id ? 1 : 0}`,
          losses: sql`${users.losses} + ${fr.winner === A.id ? 1 : 0}`,
          updatedAt: sql`now()`,
        })
        .where(eq(users.id, B.id))
        .returning({ exp: users.exp });

      aExpAfter = aUpd?.exp ?? aExpBefore + aExpGain;
      bExpAfter = bUpd?.exp ?? bExpBefore + bExpGain;
    } else {
      aExpAfter = aExpBefore;
      bExpAfter = bExpBefore;
    }

    const [matchRow] = await tx
      .insert(matches)
      .values({
        roomId: room.id,
        ranked,
        mode: ranked ? 'ranked' : 'casual',
        tie: fr.tie,
        winnerId: fr.winner ?? null,
      })
      .onConflictDoNothing({ target: matches.roomId })
      .returning({ id: matches.id });

    const matchId =
      matchRow?.id ??
      (
        await tx
          .select({ id: matches.id })
          .from(matches)
          .where(eq(matches.roomId, room.id))
      )[0]?.id;

    if (!matchId) throw new Error('Failed to get matchId for history write');

    await tx.insert(matchParticipants).values([
      {
        matchId,
        userId: A.guest ? null : (A.id as any),
        guest: !!A.guest,
        nickname: A.name ?? 'Anon',
        mmrBefore: A.mmr,
        mmrAfter: ranked ? aAfter : A.mmr,
        expBefore: aExpBefore,
        expAfter: aExpAfter,
        correct: final.gA.correct,
        secretCharacter: final.gA.secret,
        guessedName: final.gA.name,
      },
      {
        matchId,
        userId: B.guest ? null : (B.id as any),
        guest: !!B.guest,
        nickname: B.name ?? 'Anon',
        mmrBefore: B.mmr,
        mmrAfter: ranked ? bAfter : B.mmr,
        expBefore: bExpBefore,
        expAfter: bExpAfter,
        correct: final.gB.correct,
        secretCharacter: final.gB.secret,
        guessedName: final.gB.name,
      },
    ]);

    await tx
      .update(matches)
      .set({ finishedAt: sql`now()` })
      .where(eq(matches.roomId, room.id));
  });

  if (ranked) {
    A.mmr = aAfter;
    B.mmr = bAfter;
    const sockA = io.sockets.sockets.get(A.socketId);
    const sockB = io.sockets.sockets.get(B.socketId);
    if (sockA) sockA.data.mmr = aAfter; // <-- keep socket fresh
    if (sockB) sockB.data.mmr = bAfter;
  }
  io.to(A.socketId).emit('profile:mmr', { mmr: aAfter });
  io.to(B.socketId).emit('profile:mmr', { mmr: bAfter });

  room.mmrCommitted = true;

  return { aDelta, bDelta, aAfter, bAfter };
}

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.accessToken;
    if (!token) return next(new Error('no token'));
    const claims = jwt.verify(token, JWT_SECRET) as AccessClaims;

    socket.data.userId = claims.sub;
    socket.data.nickname = claims.nickname;
    socket.data.guest = !!claims.guest;

    // Guests or non-UUID subs: do NOT hit DB. Use claim/default.
    if (socket.data.guest || !isUuid(claims.sub)) {
      socket.data.mmr = Number(claims.mmr) || 1200;
      return next();
    }

    // Signed-in users: fetch fresh mmr & validate tokenVersion
    const [row] = await db
      .select({
        mmr: users.mmr,
        tokenVersion: users.tokenVersion,
        verified: users.emailVerified,
      })
      .from(users)
      .where(eq(users.id, claims.sub))
      .limit(1);

    if (!row) return next(new Error('user not found'));
    if (row.tokenVersion !== claims.tokenVersion) {
      return next(new Error('token version mismatch'));
    }

    socket.data.mmr = Number(row.mmr) || 1200; // <-- canonical MMR from DB
    next();
  } catch {
    next(new Error('bad token'));
  }
});

io.on('connection', (socket: Socket) => {
  // Resume if already in a room
  resumeIfAny(socket);

  socket.on('match:find', () => placeInQueue(socket));
  socket.on('match:cancel', () => removeFromQueues(socket.id));

  socket.on(
    'room:status',
    (
      ack?: (res: { inRoom: boolean; roomId?: string; phase?: Phase }) => void
    ) => {
      const found = getRoomBySocket(socket.id) ?? resumeIfAny(socket);
      if (!ack) return;
      if (found) {
        ack({ inRoom: true, roomId: found.id, phase: found.room.phase });
      } else {
        ack({ inRoom: false });
      }
    }
  );

  socket.on('character:select', (characterName: string) => {
    const found = getRoomBySocket(socket.id);
    if (!found) return;
    const { id: roomId, room } = found;

    const me = room.players.find((p) => p.socketId === socket.id);
    if (!me) return;

    me.secretCharacter = String(characterName).slice(0, 100);

    if (
      room.players.length >= 2 &&
      room.players.every((p) => !!p.secretCharacter)
    ) {
      room.phase = 'playing';
      room.timeRemaining = TURN_SECONDS;
      room.finalizeActive = false;
      room.finalizeGuesses = {};
      startRoomTimer(roomId);
    }

    emitState(roomId);
  });

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
      if (!q || q.type !== 'question' || typeof q.response !== 'undefined')
        return ack?.(false);
      if (q.playerId === socket.data.userId) return ack?.(false);

      q.response = payload.answer;

      swapTurn(room);
      room.timeRemaining = TURN_SECONDS;

      emitState(roomId);
      ack?.(true);
    }
  );

  socket.on('guess:make', (name: string, ack?: (ok: boolean) => void) => {
    handleGuess(name, ack);
  });
  socket.on('guess:final', (name: string, ack?: (ok: boolean) => void) => {
    io.to(socket.id).emit('warn', {
      msg: 'guess:final is deprecated; use guess:make',
    });
    handleGuess(name, ack);
  });

  async function handleGuess(
    rawName: string | undefined,
    ack?: (ok: boolean) => void
  ) {
    const found = getRoomBySocket(socket.id);
    if (!found) return ack?.(false);

    const { id: roomId, room } = found;

    if (!['playing', 'finalize'].includes(room.phase)) return ack?.(false);

    const guessName = String(rawName ?? '')
      .slice(0, 120)
      .trim();
    if (!guessName) return ack?.(false);

    const meId = String(socket.data.userId);
    const opp = otherPlayer(room, meId);
    if (!opp?.secretCharacter) return ack?.(false);

    const norm = (s: string) => s.trim().toLowerCase();
    const correct = norm(opp.secretCharacter) === norm(guessName);

    room.gameHistory.push({
      id: newId(),
      playerId: meId,
      playerName: socket.data.nickname ?? 'Anon',
      type: 'guess',
      content: guessName,
      correct,
      timestamp: Date.now(),
    });

    if (!room.finalizeActive) {
      room.finalizeActive = true;
      room.phase = 'finalize';
      room.finalizeGuesses = {
        [meId]: {
          playerId: meId,
          name: guessName,
          correct,
          secret: opp.secretCharacter,
        },
      };
      stopRoomTimer(roomId);

      const oppSocket = io.sockets.sockets.get(opp.socketId);
      oppSocket?.emit('final:prompt', { roomId });

      emitState(roomId);
      return ack?.(true);
    }

    if (room.finalizeGuesses && !room.finalizeGuesses[meId]) {
      room.finalizeGuesses[meId] = {
        playerId: meId,
        name: guessName,
        correct,
        secret: opp.secretCharacter,
      };
    }

    const pA = room.players[0].id;
    const pB = room.players[1].id;
    const gA = room.finalizeGuesses?.[pA];
    const gB = room.finalizeGuesses?.[pB];

    if (gA && gB) {
      const bothCorrect = gA.correct && gB.correct;
      let winner: string | null = null;
      if (!bothCorrect) winner = gA.correct ? pA : gB.correct ? pB : null;

      room.phase = 'finished';
      room.winner = winner ?? null;
      stopRoomTimer(roomId);

      let mmr = {
        aDelta: 0,
        bDelta: 0,
        aAfter: room.players[0].mmr,
        bAfter: room.players[1].mmr,
      };
      try {
        const persisted = await awardMMRAndPersist(
          room,
          { winner, tie: bothCorrect },
          { gA, gB }
        );
        if (persisted) mmr = persisted;
      } catch (e) {
        console.error('[mmr/match persist error]', e);
      }

      io.to(roomId).emit('final:result', {
        roomId,
        a: gA,
        b: gB,
        tie: bothCorrect,
        winner,
        mmr: {
          a: { delta: mmr.aDelta, after: mmr.aAfter },
          b: { delta: mmr.bDelta, after: mmr.bAfter },
        },
      });

      emitState(roomId);
      return ack?.(true);
    }

    emitState(roomId);
    ack?.(true);
  }

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

  socket.on('turn:timeout', (ack?: (ok: boolean) => void) => {
    ack?.(false);
  });

  async function finalizeAndPersist(
    roomId: string,
    winner: string | null,
    tie: boolean
  ) {
    const r = rooms.get(roomId);
    if (!r || r.mmrCommitted) return;
    const [A, B] = r.players;
    if (!A || !B) return;

    r.phase = 'finished';
    r.winner = winner;
    stopRoomTimer(roomId);

    const gA = {
      playerId: A.id,
      name: '',
      correct: winner === A.id,
      secret: B.secretCharacter ?? '',
    };
    const gB = {
      playerId: B.id,
      name: '',
      correct: winner === B.id,
      secret: A.secretCharacter ?? '',
    };

    try {
      await awardMMRAndPersist(r, { winner, tie }, { gA, gB });
    } catch (e) {
      console.error('[mmr/match persist error @finalize]', e);
    }

    io.to(roomId).emit('final:result', {
      roomId,
      a: gA,
      b: gB,
      tie,
      winner,
      mmr: {
        a: { delta: 0, after: A.mmr },
        b: { delta: 0, after: B.mmr },
      },
    });
    emitState(roomId);
  }

  socket.on('disconnect', () => {
    removeFromQueues(socket.id);

    const found = getRoomBySocket(socket.id);
    if (!found) return;
    const { id: roomId, room } = found;
    const p = room.players.find((pl) => pl.socketId === socket.id);
    if (!p) return;

    p.isConnected = false;
    emitState(roomId);

    reconnectTimers.set(
      p.id,
      setTimeout(async () => {
        const r = rooms.get(roomId);
        if (!r) return;

        const still = r.players.find((pl) => pl.id === p.id);
        if (still && !still.isConnected && r.players.length === 2) {
          // Winner is the remaining connected player
          const winner = r.players.find((pl) => pl.id !== p.id)!.id;
          await finalizeAndPersist(roomId, winner, false);

          // After persisting, cleanup the room
          stopRoomTimer(roomId);
          rooms.delete(roomId);
        } else if (r.players.length === 0) {
          stopRoomTimer(roomId);
          rooms.delete(roomId);
        }

        reconnectTimers.delete(p.id);
      }, GRACE_MS)
    );
  });

  socket.on('room:leave', async () => {
    const found = getRoomBySocket(socket.id);
    if (!found) return;
    const { id: roomId, room } = found;

    if (room.players.length === 2) {
      const leaving = room.players.find((pl) => pl.socketId === socket.id);
      if (leaving) {
        const winner = room.players.find((pl) => pl.id !== leaving.id)!.id;
        await finalizeAndPersist(roomId, winner, false);
      }
      stopRoomTimer(roomId);
      rooms.delete(roomId);
    } else {
      stopRoomTimer(roomId);
      rooms.delete(roomId);
    }

    emitState(roomId);
  });

  // CREATE a custom room (host becomes first player). Ack with { ok, roomId, code }
  socket.on(
    'custom:create',
    (
      payload: {
        name?: string;
        visibility?: 'public' | 'private';
        password?: string;
      },
      ack?: (res: {
        ok: boolean;
        roomId?: string;
        code?: string;
        reason?: string;
      }) => void
    ) => {
      try {
        const name = String(payload?.name ?? '').slice(0, 60) || 'Custom Room';
        const visibility = (
          payload?.visibility === 'private' ? 'private' : 'public'
        ) as 'public' | 'private';
        const pwd =
          visibility === 'private'
            ? String(payload?.password ?? '').slice(0, 64)
            : null;

        const roomId = newRoomId();
        const code = newInviteCode();
        const room: Room = {
          id: roomId,
          isCustom: true,
          mode: 'custom',
          roomName: name,
          hostId: socket.data.userId,
          visibility,
          password: pwd,
          inviteCode: code,
          players: [
            {
              id: socket.data.userId,
              name: socket.data.nickname ?? 'Anon',
              socketId: socket.id,
              mmr: Number(socket.data.mmr) || 1200,
              guest: !!socket.data.guest,
              isConnected: true,
            },
          ],
          phase: 'waiting',
          currentTurn: socket.data.userId,
          gameHistory: [],
          timeRemaining: 60,
          finalizeActive: false,
          finalizeGuesses: {},
          mmrCommitted: false,
        };

        rooms.set(roomId, room);
        socket.join(roomId);
        socketRoom.set(socket.id, roomId);
        emitState(roomId);
        ack?.({ ok: true, roomId, code });
      } catch (e) {
        console.error('[custom:create]', e);
        ack?.({ ok: false, reason: 'create_failed' });
      }
    }
  );

  // JOIN a custom room, by roomId or invite code. Ack with { ok, roomId }
  socket.on(
    'custom:join',
    (
      payload: { roomId?: string; code?: string; password?: string },
      ack?: (res: { ok: boolean; roomId?: string; reason?: string }) => void
    ) => {
      try {
        let found: { id: string; room: Room } | null = null;

        if (payload?.roomId) {
          const r = rooms.get(payload.roomId);
          if (r) found = { id: payload.roomId, room: r };
        } else if (payload?.code) {
          for (const [id, r] of rooms) {
            if (r.isCustom && r.inviteCode === payload.code) {
              found = { id, room: r };
              break;
            }
          }
        }

        if (!found) return ack?.({ ok: false, reason: 'not_found' });
        const { id: roomId, room } = found;

        if (!room.isCustom) return ack?.({ ok: false, reason: 'not_custom' });
        if (room.players.some((p) => p.id === socket.data.userId)) {
          // resume
          const me = room.players.find((p) => p.id === socket.data.userId)!;
          me.socketId = socket.id;
          me.isConnected = true;
          socket.join(roomId);
          socketRoom.set(socket.id, roomId);
          emitState(roomId);
          return ack?.({ ok: true, roomId });
        }

        if (room.visibility === 'private') {
          const ok =
            String(room.password ?? '') === String(payload?.password ?? '');
          if (!ok) return ack?.({ ok: false, reason: 'bad_password' });
        }

        if (room.players.length >= 2)
          return ack?.({ ok: false, reason: 'full' });

        room.players.push({
          id: socket.data.userId,
          name: socket.data.nickname ?? 'Anon',
          socketId: socket.id,
          mmr: Number(socket.data.mmr) || 1200,
          guest: !!socket.data.guest,
          isConnected: true,
        });

        socket.join(roomId);
        socketRoom.set(socket.id, roomId);
        emitState(roomId);
        ack?.({ ok: true, roomId });
      } catch (e) {
        console.error('[custom:join]', e);
        ack?.({ ok: false, reason: 'join_failed' });
      }
    }
  );

  // HOST starts the custom match → move to character-select
  socket.on('custom:start', (ack?: (ok: boolean) => void) => {
    const found = getRoomBySocket(socket.id);
    if (!found) return ack?.(false);
    const { id: roomId, room } = found;

    if (!room.isCustom) return ack?.(false);
    if (room.hostId !== socket.data.userId) return ack?.(false);
    if (!canStartCustom(room)) return ack?.(false);

    room.phase = 'character-select';
    room.currentTurn =
      Math.random() < 0.5 ? room.players[0].id : room.players[1].id;
    room.finalizeActive = false;
    room.finalizeGuesses = {};
    room.timeRemaining = 60;

    emitState(roomId);
    ack?.(true);
  });

  // LIST public custom rooms (for a simple lobby)
  socket.on(
    'custom:list',
    (
      ack?: (
        rooms: Array<{
          roomId: string;
          name: string;
          slots: string;
          code?: string;
        }>
      ) => void
    ) => {
      const out: Array<{
        roomId: string;
        name: string;
        slots: string;
        code?: string;
      }> = [];
      for (const [id, r] of rooms) {
        if (r.isCustom && r.visibility === 'public') {
          out.push({
            roomId: id,
            name: r.roomName ?? 'Room',
            slots: `${r.players.length}/2`,
            code: r.inviteCode,
          });
        }
      }
      ack?.(out);
    }
  );

  socket.on(
    'leaderboard:list',
    async (
      payload: { limit?: number; offset?: number } | undefined,
      ack?: (res: {
        ok: boolean;
        items?: Array<{
          id: string;
          nickname: string;
          mmr: number;
          wins: number;
          losses: number;
          rank: number;
        }>;
        total?: number;
        nextOffset?: number;
        you?: { id: string; rank: number } | null;
        reason?: string;
      }) => void
    ) => {
      try {
        const limit = Math.min(100, Math.max(1, Number(payload?.limit) || 25));
        const offset = Math.max(0, Number(payload?.offset) || 0);

        // 1) Fetch the page (no window function here)
        const baseRows = await db
          .select({
            id: users.id,
            nickname: users.nickname,
            mmr: users.mmr,
            wins: users.wins,
            losses: users.losses,
          })
          .from(users)
          .orderBy(
            desc(users.mmr),
            desc(users.wins),
            asc(users.losses),
            asc(users.id)
          )
          .limit(limit)
          .offset(offset);

        // 2) Add rank in JS to avoid Drizzle typing issues
        const rows = baseRows.map((r, i) => ({
          ...r,
          rank: offset + i + 1, // ← number
        }));

        // 3) Total count
        const totalRes = await db.execute(
          sql /* sql */ `SELECT COUNT(*)::int AS count FROM "users"`
        );
        const total = (totalRes[0] as any)?.count as number | undefined;

        // 4) Caller’s rank (optional)
        let you: { id: string; rank: number } | null = null;
        if (isUuid(socket.data.userId)) {
          const r = await db.execute(sql /* sql */ `
          WITH ranked AS (
            SELECT id, ROW_NUMBER() OVER (ORDER BY mmr DESC, wins DESC, losses ASC, id ASC) AS rank
            FROM "users"
          )
          SELECT rank FROM ranked WHERE id = ${socket.data.userId}
        `);
          const myRank = (r[0] as any)?.rank as number | undefined;
          if (myRank) you = { id: socket.data.userId, rank: myRank };
        }

        ack?.({
          ok: true,
          items: rows,
          total: total ?? rows.length,
          nextOffset: offset + rows.length,
          you,
        });
      } catch (e) {
        console.error('[leaderboard:list]', e);
        ack?.({ ok: false, reason: 'db_error' });
      }
    }
  );
});

setInterval(() => tryMatchQueue(authQueue), 1000);
setInterval(() => tryMatchQueue(guestQueue), 1000);

const PORT = Number(process.env.PORT || 8765);

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`server up on :${PORT}`);
});
