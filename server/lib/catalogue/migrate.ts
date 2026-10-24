import { initializeCatalogue, shutdownCatalogue } from './index';

async function migrate(): Promise<void> {
  if (!(await initializeCatalogue())) process.exitCode = 1;
  await shutdownCatalogue();
}

if (require.main === module) void migrate();
