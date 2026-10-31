// What the server does with its database right after a migration import swaps it in: bring the schema up to
// date, then the same one-time owner-star conversion the boot runs (an imported 3.4.1 box keeps exactly the
// owner it had, without waiting for the next reboot - ruling #27).
import { runMigrations } from '../db/migrations.js';
import { starTheOwnersTheOldReaderImplied } from '../services/owner-star-upgrade.js';

export async function reopenDatabaseAfterImport(): Promise<void> {
  runMigrations();
  starTheOwnersTheOldReaderImplied();
}
