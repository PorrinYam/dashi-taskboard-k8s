#!/usr/bin/env node
// One-shot phase-1 -> B版 data migration: SQLite (.data) into the PostgreSQL store.
//
// The source database file is NEVER modified: it (plus its -wal/-shm siblings) is copied to a
// scratch directory first, the copy is opened through TaskboardDatabase so every historical
// migration runs against it, and only then are rows bulk-copied with ON CONFLICT DO NOTHING.
// Re-running is therefore safe (forward-replayable and idempotent): the comparison report must
// show identical row counts and zero duplicate keys after any number of runs.
//
// Usage:
//   DATABASE_URL=postgres://... node tools/migrate-sqlite-to-pg.mjs --sqlite /path/.data/taskboard.sqlite
import { copyFile, cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { TaskboardDatabase } from "../server/database.mjs";
import { PgTaskboardDatabase } from "../server/pg-database.mjs";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument near '${key ?? ""}'`);
    }
    args[key.slice(2)] = value;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const databaseUrl = args["database-url"] ?? process.env.DATABASE_URL;
const sqliteSource = path.resolve(args.sqlite);
if (!databaseUrl || !args.sqlite) {
  console.error("usage: migrate-sqlite-to-pg.mjs --sqlite <taskboard.sqlite> [--database-url postgres://...]");
  process.exit(2);
}
if (!existsSync(sqliteSource)) {
  console.error(`source database not found: ${sqliteSource}`);
  process.exit(2);
}

// Tables in dependency order; each entry lists its conflict target (primary key columns).
const TABLES = [
  ["projects", ["id"]],
  ["tasks", ["id"]],
  ["comments", ["id"]],
  ["task_activities", ["id"]],
  ["attachments", ["id"]],
  ["project_readmes", ["project_id"]],
  ["project_readme_attachments", ["id"]],
  ["project_summaries", ["project_id"]],
  ["ai_chat_threads", ["id"]],
  ["ai_chat_runs", ["id"]],
  ["ai_chat_events", ["id"], { generatedColumns: ["seq"] }],
  ["task_relations", ["relation_type", "source_task_id", "target_task_id"]],
];

// 1. Scratch copy of the whole .data-style SQLite pair so the source stays pristine.
const scratch = await mkdtemp(path.join(tmpdir(), "taskboard-migrate-"));
try {
  const workingCopy = path.join(scratch, "taskboard.sqlite");
  await copyFile(sqliteSource, workingCopy);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${sqliteSource}${suffix}`)) {
      await copyFile(`${sqliteSource}${suffix}`, `${workingCopy}${suffix}`);
    }
  }
  const sourceAttachments = path.join(path.dirname(sqliteSource), "attachments");
  const attachmentsDirectory = path.join(scratch, "attachments");
  if (existsSync(sourceAttachments)) {
    await cp(sourceAttachments, attachmentsDirectory, { recursive: true });
  }

  // 2. Run every historical TaskboardDatabase migration against the copy.
  const normalized = new TaskboardDatabase(workingCopy);
  normalized.close();

  // 3. Read fully-normalized rows from the copy.
  const source = new DatabaseSync(workingCopy);

  // 4. Ensure the PostgreSQL schema, then import with conflict skipping.
  const target = new PgTaskboardDatabase(databaseUrl);
  await target.ensureSchema();

  const pool = target.pool;
  const report = [];
  let failures = 0;

  async function targetColumns(table, options = {}) {
    const result = await pool.query(
      "SELECT column_name, column_default, is_nullable FROM information_schema.columns WHERE table_name = $1",
      [table],
    );
    const generated = new Set(options.generatedColumns ?? []);
    return result.rows
      .filter((row) => !generated.has(row.column_name))
      .map((row) => row.column_name);
  }

  for (const [table, conflictKeys, options] of TABLES) {
    const sourceCount = Number(
      source.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,
    );
    const columns = await targetColumns(table, options);
    const quotedColumns = columns.map((column) => `"${column}"`).join(", ");
    const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
    const conflictClause = `ON CONFLICT (${conflictKeys.map((key) => `"${key}"`).join(", ")}) DO NOTHING`;
    let inserted = 0;
    const rows = source.prepare(`
      SELECT ${columns.map((column) => `"${column}"`).join(", ")}
      FROM "${table}"
    `).iterate();
    for (const row of rows) {
      const params = columns.map((column) => {
        const value = row[column];
        return value === undefined ? null : value;
      });
      const result = await pool.query(
        `INSERT INTO "${table}" (${quotedColumns}) VALUES (${placeholders}) ${conflictClause}`,
        params,
      );
      inserted += result.rowCount;
    }
    const targetCount = Number((await pool.query(`SELECT COUNT(*) AS n FROM "${table}"`)).rows[0].n);
    const ok = targetCount === sourceCount && targetCount >= 0;
    if (!ok) failures += 1;
    report.push({ table, source: sourceCount, importedNow: inserted, target: targetCount, ok });
  }

  // Attachment bytes: filesystem payloads beside the SQLite file move into attachment_blobs.
  let blobTargetCount = 0;
  if (existsSync(attachmentsDirectory)) {
    const meta = source.prepare("SELECT id FROM attachments ORDER BY created_at, id");
    for (const row of meta.iterate()) {
      const file = path.join(attachmentsDirectory, row.id);
      if (!existsSync(file)) continue;
      const content = await readFile(file);
      await pool.query(
        "INSERT INTO attachment_blobs (id, content) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
        [row.id, content],
      );
      blobTargetCount += 1;
    }
  }

  // 5. Reconcile the global change-revision counter (authoritative sequencing).
  const maxRevision = Number(source.prepare(`
    SELECT MAX(value) AS value FROM (
      SELECT change_revision AS value FROM comments
      UNION ALL
      SELECT change_revision AS value FROM attachments
      UNION ALL
      SELECT 0 AS value
    )
  `).get().value);
  await pool.query(
    "UPDATE comment_attachment_revision SET value = GREATEST(value, $1::int) WHERE id = 1",
    [maxRevision],
  );
  source.close();

  console.log("+--------------------------------------+--------+---------+------------+");
  console.log("| table                                | source | target  | consistent |");
  console.log("+--------------------------------------+--------+---------+------------+");
  for (const entry of report) {
    const name = entry.table.padEnd(36, " ").slice(0, 36);
    console.log(`| ${name} | ${String(entry.source).padStart(6)} | ${String(entry.target).padStart(7)} | ${entry.ok ? "yes" : "NO"}         |`);
  }
  console.log("+--------------------------------------+--------+---------+------------+");
  if (blobTargetCount > 0) {
    console.log(`attachment blobs imported: ${blobTargetCount}`);
  }
  console.log(`change_revision counter set to: >= ${maxRevision}`);

  if (failures > 0) {
    console.error("MIGRATION MISMATCH detected — do not proceed with the cutover.");
    process.exitCode = 2;
  }
  await target.close();
} finally {
  await rm(scratch, { recursive: true, force: true });
}
