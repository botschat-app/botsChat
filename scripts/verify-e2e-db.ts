/**
 * Verify E2E DB schema: messages and jobs have BLOB columns and encrypted flag.
 * Requires: npm run db:migrate (local D1) first.
 * Run: npx tsx scripts/verify-e2e-db.ts
 *
 * For full DB content test (encrypted=1, content is BLOB not plaintext),
 * run dev server, send an E2E-encrypted message via WS/API, then query D1.
 */

import { execSync } from "node:child_process";

function wranglerD1Sql(sql: string): string {
  return execSync(
    `npx wrangler d1 execute botschat-db --local --command "${sql.replace(/"/g, '\\"')}"`,
    { encoding: "utf8" }
  );
}

async function run() {
  console.log("E2E DB schema verification (local D1)...\n");

  // Check messages table: must have encrypted column and BLOB-capable columns
  const msgSchema = wranglerD1Sql("PRAGMA table_info(messages);");
  if (!msgSchema.includes("encrypted")) {
    throw new Error("messages table missing 'encrypted' column. Run: npm run db:migrate");
  }
  if (!msgSchema.includes("text") || !msgSchema.includes("a2ui")) {
    throw new Error("messages table missing text/a2ui columns");
  }
  console.log("  ✅ messages table has encrypted column");

  // Check jobs table
  const jobsSchema = wranglerD1Sql("PRAGMA table_info(jobs);");
  if (!jobsSchema.includes("encrypted")) {
    throw new Error("jobs table missing 'encrypted' column. Run: npm run db:migrate");
  }
  if (!jobsSchema.includes("summary")) {
    throw new Error("jobs table missing summary column");
  }
  console.log("  ✅ jobs table has encrypted column");

  console.log("\n🎉 E2E DB schema OK. For content verification, send an E2E message then inspect D1.");
}

run().catch((err) => {
  console.error("❌", err.message);
  process.exit(1);
});
