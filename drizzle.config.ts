import type { Config } from 'drizzle-kit';
import { DATABASE_CONFIG } from './config';

// Determine if we're using Turso or local SQLite
const isTurso = DATABASE_CONFIG.url.startsWith('libsql://');

export default {
  schema: './lib/db/schema.ts',
  out: './drizzle',
  dialect: isTurso ? 'turso' : 'sqlite',
  dbCredentials: isTurso ? {
    url: DATABASE_CONFIG.turso.url || DATABASE_CONFIG.url,
    authToken: DATABASE_CONFIG.turso.authToken!,
  } : {
    url: DATABASE_CONFIG.url.replace('file:', ''), // SQLite needs path without file: prefix
  },
  verbose: true,
  strict: true,
} satisfies Config;