import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema',
  out: './drizzle',
  dialect: 'postgresql',
  schemaFilter: ['public'],
  dbCredentials: {
    url: process.env.MIGRATIONS_URL ?? process.env.DATABASE_URL!,
  },
});
