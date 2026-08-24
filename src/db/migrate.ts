import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// __dirname is not available in ESM — reconstruct it from import.meta.url
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export async function runMigrations(connectionString?: string) {
  const pool = new Pool({ connectionString: connectionString ?? process.env.DATABASE_URL });
  const db = drizzle(pool);
  console.log('▶ Running migrations...');
  await migrate(db, { migrationsFolder: join(__dirname, 'migrations') });
  console.log('✅ Migrations complete');
  await pool.end();
}

// If run directly, execute migrations using env DATABASE_URL
runMigrations().catch((err) => {
  console.error('❌ Migration failed:', err.message);
  process.exit(1);
});
