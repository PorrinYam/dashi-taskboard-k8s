#!/usr/bin/env node
// PostgreSQL gate for the K8s branch.
//
//   DATABASE_URL=postgres://user@host:5432/db node scripts/verify-postgres.mjs
//
// Why this exists: upstream code assumes synchronous storage access, while this branch's
// PostgreSQL backend returns Promises. Un-awaited calls still pass the whole test suite
// against the SQLite store, so a green `npm test` proves nothing about PostgreSQL. This
// script exercises the paths that actually break and fails loudly.
//
// It writes only to the database named by DATABASE_URL. Point it at a disposable database.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { PgTaskboardDatabase } from "../server/pg-database.mjs";
import { AiChatService } from "../server/ai-chat.mjs";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(2);
}

const results = [];
const check = async (name, body) => {
  try {
    await body();
    results.push(`PASS ${name}`);
  } catch (error) {
    results.push(`FAIL ${name}\n     ${error.message.split("\n")[0]}`);
    throw error;
  }
};

const database = new PgTaskboardDatabase(databaseUrl);
await database.ensureSchema();
assert.ok(database.runnerHost, "PgTaskboardDatabase must expose runnerHost");

const projectId = randomUUID();
await database.createProject({ id: projectId, name: "PG gate", workspacePath: "/tmp" });

// A stub app server keeps this hermetic: the point is the storage contract, not Codex.
const appServer = {
  subscribe: () => () => {},
  startThread: async () => ({ thread: { id: "gate-thread" } }),
  resumeThread: async ({ threadId }) => ({ thread: { id: threadId } }),
  startTurn: async () => ({ turn: { id: "gate-turn" } }),
};
const aiChat = new AiChatService({
  database,
  appServer,
  codexExecutable: "/bin/true",
  resolveContext: async (id) => ({
    workspacePath: "/tmp",
    addDirectories: [],
    project: { id, name: "PG gate" },
  }),
  composerCatalog: { resolveReferences: async () => [] },
});
aiChat.getCatalog = async () => ({
  available: true,
  models: [{
    slug: "gate-model",
    name: "Gate Model",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high"],
  }],
});

await check("project row persists under the async backend", async () => {
  assert.equal((await database.getProject(projectId)).id, projectId);
});

let thread;
await check("createThread resolves to a row, not a Promise", async () => {
  thread = await aiChat.createThread({ projectId });
  assert.equal(typeof thread?.id, "string");
  assert.equal(thread.model, "gate-model");
});

await check("getThread gate rejects an unknown id instead of returning undefined", async () => {
  const outcome = await aiChat.getThread("nope").then(
    () => ({ threw: false }),
    (error) => ({ threw: true, code: error.code }),
  );
  assert.equal(outcome.threw, true);
  assert.equal(outcome.code, "AI_CHAT_THREAD_NOT_FOUND");
});

let run;
await check("a turn persists run + user_message with the right run id", async () => {
  run = await aiChat.startTurn(thread.id, {
    contractVersion: "composer.v1",
    revision: 1,
    message: "gate prompt",
    document: { nodes: [{ type: "text", text: "gate prompt" }] },
    attachments: [],
  });
  assert.equal(typeof run?.id, "string", "#startAppServerRun must await run creation");
  const pool = await database.getPool();
  const events = await database.listAiChatEvents(thread.id);
  const userMessage = events.find((event) => event.type === "user_message");
  assert.ok(userMessage, "awaited insertAiChatEvent must persist the user_message row");
  assert.equal(userMessage.runId, run.id, "user_message must reference the created run");
  const stored = (await pool.query(
    "SELECT runner_host FROM ai_chat_runs WHERE id = $1",
    [run.id],
  )).rows[0];
  assert.equal(
    stored.runner_host,
    database.runnerHost,
    "run rows must carry runnerHost attribution (dropped by upstream once already)",
  );
});

await check("the codex thread id is written before the turn continues", async () => {
  const started = await aiChat.getThread(thread.id);
  assert.equal(started.codexThreadId, "gate-thread");
});

await check("getThreadSnapshot awaits events and runs", async () => {
  const snapshot = await aiChat.getThreadSnapshot(thread.id);
  assert.equal(snapshot.thread.id, thread.id);
  assert.ok(snapshot.events.length > 0);
  assert.ok(snapshot.runs.some((entry) => entry.id === run.id));
});

await database.close();
console.log(results.join("\n"));
console.log("\nPostgreSQL gate passed.");
