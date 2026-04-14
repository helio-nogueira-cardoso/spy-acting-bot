import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db } from './connection';
import path from 'path';

const migrationsFolder = path.resolve(__dirname, 'migrations');

console.log('Rodando migrations...');
migrate(db, { migrationsFolder });
console.log('Migrations concluídas!');
