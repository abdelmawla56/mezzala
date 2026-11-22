#!/usr/bin/env node
/**
 * db-migrate.mjs
 * Runs all pending migrations by delegating to infra/scripts/apply-migrations.sh (via WSL).
 * Uses DATABASE_URL_OWNER — never touches mz_app credentials.
 * Called by: npm run db:setup
 */

import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");

// apply-migrations.sh lives in infra/scripts/ and uses docker exec internally
const script = "/mnt/c/Users/YOUSSEF/Desktop/clip/mezzala/infra/scripts/apply-migrations.sh";

console.log("=== db-migrate: running migrations via apply-migrations.sh ===");
try {
  execSync(`wsl bash "${script}"`, {
    stdio: "inherit",
    cwd: repoRoot,
  });
  console.log("=== db-migrate: done ===");
} catch (err) {
  console.error("db-migrate: migration failed", err.message);
  process.exit(1);
}
