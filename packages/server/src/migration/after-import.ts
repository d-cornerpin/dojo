// After import: migrate, then the boot's owner-star conversion, so an older box keeps its owner pre-reboot.
import { runMigrations } from '../db/migrations.js';
import { starTheOwnersTheOldReaderImplied } from '../services/owner-star-upgrade.js';

export async function reopenDatabaseAfterImport(): Promise<void> {
  runMigrations();
  starTheOwnersTheOldReaderImplied();
}
