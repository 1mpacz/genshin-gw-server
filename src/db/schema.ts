import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  uuid,
  index,
  uniqueIndex,
  pgEnum,
} from 'drizzle-orm/pg-core';

export const matchMode = pgEnum('match_mode', ['ranked', 'casual']);

export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    email: text('email').notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    nickname: text('nickname').notNull(),
    tokenVersion: integer('token_version').notNull().default(0),
    emailVerified: boolean('email_verified').notNull().default(false),

    adventureRank: integer('adventure_rank').notNull().default(1),
    exp: integer('exp').notNull().default(0),
    mmr: integer('mmr').notNull().default(1200),
    wins: integer('wins').notNull().default(0),
    losses: integer('losses').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    usersMmrIdx: index('users_mmr_idx').on(t.mmr),
  })
);

export const matches = pgTable(
  'matches',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    roomId: text('room_id').notNull(),
    ranked: boolean('ranked').notNull().default(true),
    mode: matchMode('mode').notNull().default('ranked'),
    tie: boolean('tie').notNull().default(false),
    winnerId: uuid('winner_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }), // set when the match actually finishes
  },
  (t) => ({
    roomUnique: uniqueIndex('matches_room_unique').on(t.roomId),
    createdIdx: index('matches_created_idx').on(t.createdAt),
  })
);

export const matchParticipants = pgTable(
  'match_participants',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    matchId: uuid('match_id')
      .notNull()
      .references(() => matches.id, { onDelete: 'cascade' }),

    userId: uuid('user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    guest: boolean('guest').notNull().default(false),
    nickname: text('nickname').notNull(),

    mmrBefore: integer('mmr_before'),
    mmrAfter: integer('mmr_after'),
    expBefore: integer('exp_before'),
    expAfter: integer('exp_after'),

    correct: boolean('correct').notNull().default(false),
    secretCharacter: text('secret_character'),
    guessedName: text('guessed_name'),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    matchIdx: index('match_participants_match_idx').on(t.matchId),
    userIdx: index('match_participants_user_idx').on(t.userId),
  })
);
