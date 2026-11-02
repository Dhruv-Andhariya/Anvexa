import path from 'node:path';
import { defineConfig } from 'prisma/config';

// Prisma CLI commands (migrate, studio, ...) read DATABASE_URL from the repo-root .env, like the API does.
// Real environment variables win over .env values.
try {
  process.loadEnvFile(path.resolve(__dirname, '../../.env'));
} catch {
  // no .env file - rely on the environment
}

export default defineConfig({
  schema: path.join('prisma', 'schema'),
});
