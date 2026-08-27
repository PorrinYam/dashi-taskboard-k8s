import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import os from "node:os";

import { loadPg } from "./pg-module.mjs";
import { DEFAULT_LABEL_NAMES, JIRA_PROJECT_ID } from "../shared/domain.mjs";
import {
  ApiError,
  aiChatEventFromRow,
  aiChatRunFromRow,
  aiChatThreadFromRow,
  attachTaskActivity,
  attachmentFromRow,
  commentFromRow,
  legacyLocalThreadIdFromRow,
  parseAiChatTodoProgress,
  projectFromRow,
  projectPrefix,
  projectReadmeAttachmentFromRow,
  projectReadmeFromRow,
  projectSummaryFromRow,
  relationActivityValue,
  storedThreadBinding,
  storedThreadBindingForExisting,
  taskActivityFromRow,
  taskFieldChanges,
  taskFromRow,
  taskRelationSummaryFromRow,
  taskTreeNode,
} from "./database.mjs";

const TASK_TREE_MAX_NODES = 1_000;
const NOW = () => new Date().toISOString();
const DEFAULT_PROJECT_LABELS_JSON = JSON.stringify(DEFAULT_LABEL_NAMES);

// Turns the ? placeholders used by the SQLite sources into $n parameters for PostgreSQL.
function pgParams(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  workspace_path TEXT,
  labels TEXT NOT NULL DEFAULT '${DEFAULT_PROJECT_LABELS_JSON}',
  next_task_number INTEGER NOT NULL DEFAULT 1 CHECK (next_task_number > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN (
    'backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'canceled'
  )),
  priority TEXT NOT NULL CHECK (priority IN ('none', 'urgent', 'high', 'medium', 'low')),
  labels TEXT NOT NULL DEFAULT '[]',
  sort_order DOUBLE PRECISION NOT NULL,
  thread_id TEXT,
  thread_codex_project_id TEXT,
  thread_codex_project_kind TEXT,
  thread_codex_host_id TEXT,
  thread_workspace_path TEXT,
  creator_type TEXT NOT NULL DEFAULT 'user',
  creator_id TEXT NOT NULL DEFAULT 'local-user',
  creator_name TEXT NOT NULL DEFAULT '本地用户',
  creator_avatar_url TEXT,
  assignee_type TEXT NOT NULL DEFAULT 'user' CHECK (assignee_type IN ('user', 'agent')),
  assignee_id TEXT NOT NULL DEFAULT 'local-user',
  assignee_name TEXT NOT NULL DEFAULT '本地用户',
  assignee_avatar_url TEXT,
  git_branch TEXT,
  worktree_path TEXT,
  worktree_branch TEXT,
  start_date TEXT,
  due_date TEXT,
  recurrence_interval INTEGER,
  recurrence_unit TEXT,
  external_source TEXT,
  external_origin TEXT,
  external_id TEXT,
  external_key TEXT,
  external_url TEXT,
  archived_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS tasks_project_status_sort
  ON tasks(project_id, archived_at, status, sort_order, created_at);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  thread_id TEXT,
  thread_codex_project_id TEXT,
  thread_codex_project_kind TEXT,
  thread_codex_host_id TEXT,
  thread_workspace_path TEXT,
  author_type TEXT NOT NULL DEFAULT 'user',
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  author_avatar_url TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  change_revision INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS comments_task_created
  ON comments(task_id, created_at, id);

CREATE TABLE IF NOT EXISTS task_activities (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent')),
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  actor_avatar_url TEXT,
  changes TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS task_activities_task_created
  ON task_activities(task_id, created_at, id);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('inline', 'attachment')),
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  created_at TEXT NOT NULL,
  change_revision INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS attachments_task_created
  ON attachments(task_id, created_at, id);

CREATE TABLE IF NOT EXISTS comment_attachment_revision (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  value INTEGER NOT NULL CHECK (value >= 0)
);

INSERT INTO comment_attachment_revision (id, value)
VALUES (1, 0)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS project_readmes (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  content TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_readme_attachments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_summaries (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  summary TEXT,
  generated_at TEXT,
  attempted_at TEXT NOT NULL,
  error TEXT
);

CREATE TABLE IF NOT EXISTS ai_chat_threads (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'failed')),
  origin_project_id TEXT NOT NULL,
  origin_project_name TEXT NOT NULL,
  origin_workspace_path TEXT NOT NULL,
  origin_issue_id TEXT,
  origin_issue_identifier TEXT,
  codex_thread_id TEXT,
  model TEXT NOT NULL,
  reasoning_effort TEXT NOT NULL,
  sandbox TEXT NOT NULL CHECK (sandbox IN (
    'read-only', 'workspace-write', 'danger-full-access'
  )),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ai_chat_threads_updated
  ON ai_chat_threads(updated_at DESC, id);

CREATE TABLE IF NOT EXISTS ai_chat_runs (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES ai_chat_threads(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN (
    'running', 'completed', 'failed', 'interrupted'
  )),
  exit_code INTEGER,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  -- Server instance (pod) that owns a running turn; startup cleanup only interrupts
  -- its own leftovers plus NULL rows left by the SQLite migration importer.
  runner_host TEXT
);

CREATE INDEX IF NOT EXISTS ai_chat_runs_thread_started
  ON ai_chat_runs(thread_id, started_at, id);

CREATE UNIQUE INDEX IF NOT EXISTS ai_chat_runs_one_active
  ON ai_chat_runs(thread_id)
  WHERE status = 'running';

CREATE TABLE IF NOT EXISTS ai_chat_events (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES ai_chat_threads(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES ai_chat_runs(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'activity', 'error')),
  content TEXT NOT NULL,
  data TEXT,
  created_at TEXT NOT NULL,
  seq BIGINT GENERATED ALWAYS AS IDENTITY
);

CREATE INDEX IF NOT EXISTS ai_chat_events_thread_created
  ON ai_chat_events(thread_id, created_at, seq);

-- Attachment payloads live in the authoritative store in PostgreSQL mode so every
-- replica can serve them; the standalone SQLite backend keeps filesystem storage.
CREATE TABLE IF NOT EXISTS attachment_blobs (
  id TEXT PRIMARY KEY,
  content BYTEA NOT NULL
);

CREATE TABLE IF NOT EXISTS task_relations (
  relation_type TEXT NOT NULL CHECK (relation_type IN ('parent', 'blocks', 'related')),
  source_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  target_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'mention')),
  created_at TEXT NOT NULL,
  CHECK (source_task_id <> target_task_id),
  CHECK (relation_type <> 'related' OR source_task_id < target_task_id),
  PRIMARY KEY (relation_type, source_task_id, target_task_id)
);

CREATE INDEX IF NOT EXISTS task_relations_target
  ON task_relations(relation_type, target_task_id);

CREATE UNIQUE INDEX IF NOT EXISTS task_relations_one_parent
  ON task_relations(target_task_id)
  WHERE relation_type = 'parent';

-- Cross-replica realtime fanout log: writers append committed change envelopes here and
-- NOTIFY their sequence numbers; every replica tails it by sequence and pushes to its own clients.
CREATE TABLE IF NOT EXISTS taskboard_events (
  seq BIGINT GENERATED ALWAYS AS IDENTITY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB NOT NULL,
  PRIMARY KEY (seq)
);

-- Per-device board credentials: Basic username = device id, password = device token.
-- Only the SHA-256 hash of the token is stored; revocation flips revoked_at.
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

-- Idempotent column-level upgrades for databases bootstrapped by earlier revisions of
-- this schema (CREATE TABLE IF NOT EXISTS never adds columns to existing tables).
ALTER TABLE ai_chat_runs ADD COLUMN IF NOT EXISTS runner_host TEXT;
`;

export class PgTaskboardDatabase {
  constructor(databaseUrl) {
    this.databaseUrl = databaseUrl;
    this.readyPromise = null;
    this.closed = false;
    // Identity of this server instance for run ownership; in Kubernetes this is the pod name.
    this.runnerHost = process.env.HOSTNAME || os.hostname();
    // The pool and the pg driver are created lazily (getPool) so the packaged standalone
    // App never touches the PostgreSQL module.
    this.pool = null;
    // Uniform attachment-bytes surface consumed by server/app.mjs for both backends.
    this.blobs = {
      put: async (id, body) => {
        await (await this.getPool()).query(
          "INSERT INTO attachment_blobs (id, content) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
          [id, body],
        );
      },
      get: async (id) => {
        const result = await (await this.getPool()).query(
          "SELECT content FROM attachment_blobs WHERE id = $1",
          [id],
        );
        return result.rows[0]?.content ?? null;
      },
      delete: async (id) => {
        await (await this.getPool()).query("DELETE FROM attachment_blobs WHERE id = $1", [id]);
      },
    };
  }

  // Creates the connection pool on first use, importing the pg driver dynamically.
  async getPool() {
    if (this.closed) throw new Error("PgTaskboardDatabase is closed");
    if (!this.pool) {
      const pg = await loadPg();
      this.pool = new pg.Pool({ connectionString: this.databaseUrl, max: 10 });
    }
    return this.pool;
  }

  async #ready() {
    if (!this.readyPromise) {
      this.readyPromise = (async () => {
        if (this.closed) throw new Error("PgTaskboardDatabase is closed");
        await (await this.getPool()).query(SCHEMA);
        const timestamp = NOW();
        await (await this.getPool()).query(
          `INSERT INTO projects (id, name, workspace_path, next_task_number, created_at, updated_at)
           VALUES ('local', '全局', NULL, 1, $1, $2)
           ON CONFLICT (id) DO NOTHING`,
          [timestamp, timestamp],
        );
      })().catch((error) => {
        this.readyPromise = null;
        throw error;
      });
    }
    await this.readyPromise;
  }

  async close() {
    this.closed = true;
    if (this.pool) await this.pool.end();
  }

  // Idempotent schema bootstrap for tooling (migration importer, admin scripts).
  async ensureSchema() {
    await this.#ready();
  }

  // Pool-bound statement runner for reads and single-statement writes.
  #root() {
    if (!this.pool) {
      throw new Error("PgTaskboardDatabase pool used before initialization");
    }
    const pool = this.pool;
    return {
      async run(sql, ...params) {
        const result = await pool.query(pgParams(sql), params);
        return { changes: result.rowCount };
      },
      async get(sql, ...params) {
        const result = await pool.query(pgParams(sql), params);
        return result.rows[0];
      },
      async all(sql, ...params) {
        const result = await pool.query(pgParams(sql), params);
        return result.rows;
      },
    };
  }

  // Transaction-scoped statement runner; every multi-statement mutation goes here.
  async #tx(work) {
    await this.#ready();
    const client = await (await this.getPool()).connect();
    try {
      await client.query("BEGIN");
      const db = {
        async run(sql, ...params) {
          const result = await client.query(pgParams(sql), params);
          return { changes: result.rowCount };
        },
        async get(sql, ...params) {
          const result = await client.query(pgParams(sql), params);
          return result.rows[0];
        },
        async all(sql, ...params) {
          const result = await client.query(pgParams(sql), params);
          return result.rows;
        },
      };
      const output = await work(db);
      await client.query("COMMIT");
      return output;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  async #scoped(work) {
    await this.#ready();
    return work(this.#root());
  }

  uniqueViolation(error) {
    return error?.code === "23505";
  }

  // ---- projects ----

  listProjects() {
    return this.#scoped((db) => db.all(`
      SELECT
        projects.id,
        projects.name,
        projects.workspace_path,
        projects.labels,
        projects.created_at,
        projects.updated_at,
        COUNT(tasks.id) AS issue_count
      FROM projects
      LEFT JOIN tasks
        ON tasks.project_id = projects.id
        AND tasks.archived_at IS NULL
      GROUP BY
        projects.id,
        projects.name,
        projects.workspace_path,
        projects.labels,
        projects.created_at,
        projects.updated_at
      ORDER BY projects.created_at, projects.id
    `).then((rows) => rows.map(projectFromRow)));
  }

  async createProject(input) {
    await this.#ready();
    const timestamp = NOW();
    try {
      await (await this.getPool()).query(
        pgParams(`
          INSERT INTO projects (
            id, name, workspace_path, labels, next_task_number, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 1, ?, ?)
        `),
        [
          input.id,
          input.name,
          input.workspacePath,
          DEFAULT_PROJECT_LABELS_JSON,
          timestamp,
          timestamp,
        ],
      );
    } catch (error) {
      if (this.uniqueViolation(error)) {
        throw new ApiError(409, "PROJECT_EXISTS", `Project '${input.id}' already exists`);
      }
      throw error;
    }
    return this.getProject(input.id);
  }

  ensureJiraProject(name) {
    return this.#tx(async (db) => {
      const timestamp = NOW();
      await db.run(`
        INSERT INTO projects (id, name, workspace_path, labels, next_task_number, created_at, updated_at)
        VALUES (?, ?, NULL, '[]', 1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
      `, JIRA_PROJECT_ID, name, timestamp, timestamp);
      return db.get(`
        SELECT
          projects.id,
          projects.name,
          projects.workspace_path,
          projects.labels,
          projects.created_at,
          projects.updated_at,
          COUNT(tasks.id) AS issue_count
        FROM projects
        LEFT JOIN tasks ON tasks.project_id = projects.id AND tasks.archived_at IS NULL
        WHERE projects.id = ?
        GROUP BY
          projects.id,
          projects.name,
          projects.workspace_path,
          projects.labels,
          projects.created_at,
          projects.updated_at
      `, JIRA_PROJECT_ID);
    });
  }

  syncJiraTasks(issues, { archiveMissing = true, projectName, legacyIdentity = null } = {}) {
    return this.#tx(async (db) => {
      const timestamp = NOW();
      const seenTaskIds = new Set();
      const projectLabels = JSON.stringify([
        ...new Set(issues.flatMap((issue) => issue.labels)),
      ]);
      await db.run(`
        INSERT INTO projects (id, name, workspace_path, labels, next_task_number, created_at, updated_at)
        VALUES (?, ?, NULL, ?, 1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          labels = excluded.labels,
          updated_at = excluded.updated_at
      `, JIRA_PROJECT_ID, projectName, projectLabels, timestamp, timestamp);
      if (legacyIdentity) {
        const legacyTasks = await db.all(`
          SELECT id, identifier, external_id
          FROM tasks
          WHERE project_id = ?
            AND external_source = 'jira'
            AND external_origin IS NULL
            AND substring(external_id FROM 1 FOR 17) = ?
            AND id = 'jira:' || external_id
        `, JIRA_PROJECT_ID, `${legacyIdentity.urlHash}:`);
        for (const legacyTask of legacyTasks) {
          const externalId = legacyTask.external_id.slice(17);
          await db.run(`
            UPDATE tasks SET
              identifier = ?, external_origin = ?, external_id = ?, external_key = ?
            WHERE id = ?
          `,
            `JIRA:${legacyIdentity.originId.toUpperCase()}:${externalId}`,
            legacyIdentity.originId,
            externalId,
            legacyTask.identifier,
            legacyTask.id,
          );
        }
      }

      for (const issue of issues) {
        const existing = await db.get(`
          SELECT * FROM tasks
          WHERE external_source = 'jira' AND external_origin = ? AND external_id = ?
        `, issue.externalOrigin, issue.externalId);
        seenTaskIds.add(existing?.id ?? issue.id);
        const labels = JSON.stringify(issue.labels);
        if (!existing) {
          await db.run(`
            INSERT INTO tasks (
              id, identifier, project_id, title, description, status, priority, labels,
              sort_order, thread_id, thread_codex_project_id, thread_codex_project_kind,
              thread_codex_host_id, thread_workspace_path,
              creator_type, creator_id, creator_name, creator_avatar_url,
              assignee_type, assignee_id, assignee_name, assignee_avatar_url,
              git_branch, worktree_path, worktree_branch,
              start_date, due_date, recurrence_interval, recurrence_unit,
              external_source, external_origin, external_id, external_key, external_url,
              archived_at, version, created_at, updated_at
            ) VALUES (
              ?, ?, ?, ?, ?, ?, ?, ?,
              ?, NULL, NULL, NULL, NULL, NULL,
              ?, ?, ?, ?,
              ?, ?, ?, ?,
              NULL, NULL, NULL,
              NULL, ?, NULL, NULL,
              'jira', ?, ?, ?, ?,
              NULL, 1, ?, ?
            )
          `,
            issue.id,
            issue.identifier,
            JIRA_PROJECT_ID,
            issue.title,
            issue.description,
            issue.status,
            issue.priority,
            labels,
            issue.sortOrder,
            issue.creator.type,
            issue.creator.id,
            issue.creator.name,
            issue.creator.avatarUrl,
            issue.assignee.type,
            issue.assignee.id,
            issue.assignee.name,
            issue.assignee.avatarUrl,
            issue.dueDate,
            issue.externalOrigin,
            issue.externalId,
            issue.externalKey,
            issue.externalUrl,
            issue.createdAt,
            issue.updatedAt,
          );
          continue;
        }

        const changed = existing.identifier !== issue.identifier
          || existing.title !== issue.title
          || existing.description !== issue.description
          || existing.status !== issue.status
          || existing.priority !== issue.priority
          || existing.labels !== labels
          || existing.sort_order !== issue.sortOrder
          || existing.creator_type !== issue.creator.type
          || existing.creator_id !== issue.creator.id
          || existing.creator_name !== issue.creator.name
          || existing.creator_avatar_url !== issue.creator.avatarUrl
          || existing.assignee_type !== issue.assignee.type
          || existing.assignee_id !== issue.assignee.id
          || existing.assignee_name !== issue.assignee.name
          || existing.assignee_avatar_url !== issue.assignee.avatarUrl
          || existing.due_date !== issue.dueDate
          || existing.external_origin !== issue.externalOrigin
          || existing.external_id !== issue.externalId
          || existing.external_key !== issue.externalKey
          || existing.external_url !== issue.externalUrl
          || existing.archived_at !== null;
        if (!changed) continue;
        await db.run(`
          UPDATE tasks SET
            identifier = ?, title = ?, description = ?, status = ?, priority = ?, labels = ?,
            sort_order = ?, creator_type = ?, creator_id = ?, creator_name = ?, creator_avatar_url = ?,
            assignee_type = ?, assignee_id = ?, assignee_name = ?, assignee_avatar_url = ?,
            due_date = ?, external_origin = ?, external_id = ?, external_key = ?, external_url = ?,
            archived_at = NULL,
            version = version + 1, updated_at = ?
          WHERE id = ?
        `,
          issue.identifier,
          issue.title,
          issue.description,
          issue.status,
          issue.priority,
          labels,
          issue.sortOrder,
          issue.creator.type,
          issue.creator.id,
          issue.creator.name,
          issue.creator.avatarUrl,
          issue.assignee.type,
          issue.assignee.id,
          issue.assignee.name,
          issue.assignee.avatarUrl,
          issue.dueDate,
          issue.externalOrigin,
          issue.externalId,
          issue.externalKey,
          issue.externalUrl,
          issue.updatedAt,
          existing.id,
        );
      }

      if (archiveMissing) {
        const existingTasks = await db.all(`
          SELECT id FROM tasks
          WHERE project_id = ? AND external_source = 'jira' AND archived_at IS NULL
        `, JIRA_PROJECT_ID);
        for (const task of existingTasks) {
          if (!seenTaskIds.has(task.id)) {
            await db.run(`
              UPDATE tasks SET archived_at = ?, version = version + 1, updated_at = ?
              WHERE id = ?
            `, timestamp, timestamp, task.id);
          }
        }
      }
      await db.run("UPDATE projects SET updated_at = ? WHERE id = ?", timestamp, JIRA_PROJECT_ID);
    });
  }

  async deleteProject(id) {
    const project = await this.getProject(id);
    if (!project) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${id}' does not exist`);
    }
    if (!id.startsWith("temp-")) {
      throw new ApiError(403, "PROJECT_DELETE_FORBIDDEN", "Only manually created projects can be deleted");
    }
    const result = await this.#tx(async (db) => db.run(`
      DELETE FROM projects
      WHERE id = ?
        AND NOT EXISTS (SELECT 1 FROM tasks WHERE project_id = ?)
    `, id, id));
    if (result.changes !== 1) {
      const row = await (await this.getPool()).query(
        "SELECT COUNT(*)::int AS issue_count FROM tasks WHERE project_id = $1",
        [id],
      );
      throw new ApiError(409, "PROJECT_NOT_EMPTY", "Project still contains issues", {
        issueCount: Number(row.rows[0].issue_count),
      });
    }
    return project;
  }

  async getProject(id) {
    const row = await this.#scoped((db) => db.get(`
      SELECT
        projects.id,
        projects.name,
        projects.workspace_path,
        projects.labels,
        projects.created_at,
        projects.updated_at,
        COUNT(tasks.id) AS issue_count
      FROM projects
      LEFT JOIN tasks
        ON tasks.project_id = projects.id
        AND tasks.archived_at IS NULL
      WHERE projects.id = ?
      GROUP BY
        projects.id,
        projects.name,
        projects.workspace_path,
        projects.labels,
        projects.created_at,
        projects.updated_at
    `, id));
    return row ? projectFromRow(row) : null;
  }

  addProjectLabel(projectId, label) {
    return this.#tx(async (db) => {
      const project = await db.get("SELECT labels FROM projects WHERE id = ?", projectId);
      if (!project) {
        throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
      }
      const labels = JSON.parse(project.labels);
      if (!labels.includes(label)) {
        await db.run(`
          UPDATE projects SET labels = ?, updated_at = ? WHERE id = ?
        `, JSON.stringify([...labels, label]), NOW(), projectId);
      }
      return null;
    }).then(() => this.getProject(projectId));
  }

  deleteProjectLabel(projectId, label) {
    return this.#tx(async (db) => {
      const project = await db.get("SELECT labels FROM projects WHERE id = ?", projectId);
      if (!project) {
        throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
      }
      const timestamp = NOW();
      const labels = JSON.parse(project.labels);
      if (labels.includes(label)) {
        await db.run(`
          UPDATE projects SET labels = ?, updated_at = ? WHERE id = ?
        `, JSON.stringify(labels.filter((current) => current !== label)), timestamp, projectId);
      }
      const tasks = await db.all(`
        SELECT id, labels FROM tasks WHERE project_id = ?
      `, projectId);
      for (const task of tasks) {
        const taskLabels = JSON.parse(task.labels);
        if (taskLabels.includes(label)) {
          await db.run(`
            UPDATE tasks
            SET labels = ?, version = version + 1, updated_at = ?
            WHERE id = ?
          `,
            JSON.stringify(taskLabels.filter((current) => current !== label)),
            timestamp,
            task.id,
          );
        }
      }
      return null;
    }).then(() => this.getProject(projectId));
  }

  // ---- project summaries / readmes ----

  async getProjectSummary(projectId) {
    const row = await this.#scoped((db) => db.get(`
      SELECT project_id, summary, generated_at, attempted_at, error
      FROM project_summaries
      WHERE project_id = ?
    `, projectId));
    return row ? projectSummaryFromRow(row) : {
      projectId,
      summary: null,
      generatedAt: null,
      attemptedAt: null,
      error: null,
    };
  }

  listProjectSummaries() {
    return this.#scoped((db) => db.all(`
      SELECT project_id, summary, generated_at, attempted_at, error
      FROM project_summaries
      ORDER BY project_id
    `).then((rows) => rows.map(projectSummaryFromRow)));
  }

  async saveProjectSummary(projectId, summary) {
    const timestamp = NOW();
    await this.#tx(async (db) => db.run(`
      INSERT INTO project_summaries (
        project_id, summary, generated_at, attempted_at, error
      ) VALUES (?, ?, ?, ?, NULL)
      ON CONFLICT(project_id) DO UPDATE SET
        summary = excluded.summary,
        generated_at = excluded.generated_at,
        attempted_at = excluded.attempted_at,
        error = NULL
    `, projectId, summary, timestamp, timestamp));
    return this.getProjectSummary(projectId);
  }

  async saveProjectSummaryError(projectId, error) {
    const timestamp = NOW();
    await this.#tx(async (db) => db.run(`
      INSERT INTO project_summaries (
        project_id, summary, generated_at, attempted_at, error
      ) VALUES (?, NULL, NULL, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        attempted_at = excluded.attempted_at,
        error = excluded.error
    `, projectId, timestamp, error));
    return this.getProjectSummary(projectId);
  }

  async getProjectReadme(projectId) {
    const row = await this.#scoped(async (db) => {
      const exists = await db.get("SELECT 1 AS found FROM projects WHERE id = ?", projectId);
      if (!exists) {
        throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
      }
      return db.get(`
        SELECT project_id, content, version, created_at, updated_at
        FROM project_readmes
        WHERE project_id = ?
      `, projectId);
    });
    return row
      ? projectReadmeFromRow(row, projectId)
      : { projectId, content: "", version: 0, createdAt: null, updatedAt: null };
  }

  async saveProjectReadme(projectId, content, expectedVersion) {
    const timestamp = NOW();
    await this.#tx(async (db) => {
      const exists = await db.get("SELECT 1 AS found FROM projects WHERE id = ?", projectId);
      if (!exists) {
        throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
      }
      const current = await db.get(`
        SELECT version FROM project_readmes WHERE project_id = ?
      `, projectId);
      if (expectedVersion !== undefined) {
        const actualVersion = current?.version ?? 0;
        if (actualVersion !== expectedVersion) {
          throw new ApiError(409, "VERSION_CONFLICT", "Project README changed since it was last read", {
            expectedVersion,
            actualVersion,
          });
        }
      }
      if (current) {
        if (expectedVersion !== undefined) {
          return db.run(`
            UPDATE project_readmes
            SET content = ?, version = version + 1, updated_at = ?
            WHERE project_id = ? AND version = ?
          `, content, timestamp, projectId, expectedVersion);
        }
        return db.run(`
          UPDATE project_readmes
          SET content = ?, version = version + 1, updated_at = ?
          WHERE project_id = ?
        `, content, timestamp, projectId);
      }
      return db.run(`
        INSERT INTO project_readmes (project_id, content, version, created_at, updated_at)
        VALUES (?, ?, 1, ?, ?)
      `, projectId, content, timestamp, timestamp);
    });
    return this.getProjectReadme(projectId);
  }

  async createProjectReadmeAttachment(projectId, input) {
    await this.#ready();
    const exists = await (await this.getPool()).query(
      pgParams("SELECT 1 AS found FROM projects WHERE id = ?"),
      [projectId],
    );
    if (exists.rows.length === 0) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    }
    await (await this.getPool()).query(pgParams(`
      INSERT INTO project_readme_attachments (
        id, project_id, filename, content_type, size, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `), [input.id, projectId, input.filename, input.contentType, input.size, NOW()]);
    return this.getProjectReadmeAttachment(input.id);
  }

  async getProjectReadmeAttachment(id) {
    const row = await this.#scoped((db) => db.get(`
      SELECT * FROM project_readme_attachments WHERE id = ?
    `, id));
    return row ? projectReadmeAttachmentFromRow(row) : null;
  }

  // ---- AI chat ----

  listAiChatThreads() {
    return this.#scoped(async (db) => {
      const rows = await db.all(`
        SELECT * FROM ai_chat_threads
        ORDER BY updated_at DESC, id
      `);
      if (rows.length === 0) return [];

      const currentRuns = new Map();
      for (const row of await db.all(`
        SELECT * FROM ai_chat_runs
        WHERE status = 'running'
        ORDER BY thread_id, started_at DESC, id DESC
      `)) {
        if (!currentRuns.has(row.thread_id)) currentRuns.set(row.thread_id, aiChatRunFromRow(row));
      }

      const latestTodos = new Map();
      for (const row of await db.all(`
        SELECT id, thread_id, run_id, data, created_at
        FROM ai_chat_events
        WHERE type = 'todo_list'
        ORDER BY thread_id, created_at DESC, seq DESC
      `)) {
        if (latestTodos.has(row.thread_id)) continue;
        const currentRun = currentRuns.get(row.thread_id);
        if (currentRun && row.run_id !== currentRun.id) continue;
        const progress = parseAiChatTodoProgress(row);
        if (progress) latestTodos.set(row.thread_id, progress);
      }

      return rows.map((row) => {
        const thread = aiChatThreadFromRow(row);
        thread.currentRun = currentRuns.get(thread.id) ?? null;
        thread.latestTodo = latestTodos.get(thread.id) ?? null;
        return thread;
      });
    });
  }

  async getAiChatThread(id) {
    const row = await this.#scoped((db) => db.get("SELECT * FROM ai_chat_threads WHERE id = ?", id));
    return row ? this.#aiChatThreadWithCurrentRun(row) : null;
  }

  hasAiChatThreadProjectConflict(issueRef, projectId) {
    return this.#scoped(async (db) => Boolean(await db.get(`
      SELECT 1 AS found
      FROM ai_chat_threads
      WHERE (origin_issue_id = ? OR origin_issue_identifier = ?)
        AND origin_project_id != ?
      LIMIT 1
    `, issueRef, issueRef, projectId)));
  }

  async createAiChatThread(input) {
    const id = input.id ?? randomUUID();
    const timestamp = input.createdAt ?? NOW();
    await this.#tx(async (db) => db.run(`
      INSERT INTO ai_chat_threads (
        id, title, status,
        origin_project_id, origin_project_name, origin_workspace_path,
        origin_issue_id, origin_issue_identifier,
        codex_thread_id, model, reasoning_effort, sandbox,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      id,
      input.title,
      input.status ?? "idle",
      input.origin.projectId,
      input.origin.projectName,
      input.origin.workspacePath,
      input.origin.issueId ?? null,
      input.origin.issueIdentifier ?? null,
      input.codexThreadId ?? null,
      input.model,
      input.reasoningEffort,
      input.sandbox,
      timestamp,
      input.updatedAt ?? timestamp,
    ));
    return this.getAiChatThread(id);
  }

  async updateAiChatThread(id, changes) {
    const current = await this.getAiChatThread(id);
    if (!current) {
      throw new ApiError(404, "AI_CHAT_THREAD_NOT_FOUND", `AI chat thread '${id}' does not exist`);
    }
    const columns = {
      title: "title",
      status: "status",
      codexThreadId: "codex_thread_id",
      model: "model",
      reasoningEffort: "reasoning_effort",
      sandbox: "sandbox",
    };
    const assignments = [];
    const values = [];
    for (const [key, column] of Object.entries(columns)) {
      if (!Object.hasOwn(changes, key)) continue;
      assignments.push(`${column} = ?`);
      values.push(changes[key]);
    }
    if (assignments.length === 0) return current;
    assignments.push("updated_at = ?");
    values.push(changes.updatedAt ?? NOW(), id);
    await this.#tx((db) => db.run(`
      UPDATE ai_chat_threads SET ${assignments.join(", ")} WHERE id = ?
    `, ...values));
    return this.getAiChatThread(id);
  }

  async deleteAiChatThread(id) {
    const current = await this.getAiChatThread(id);
    if (!current) {
      throw new ApiError(404, "AI_CHAT_THREAD_NOT_FOUND", `AI chat thread '${id}' does not exist`);
    }
    await this.#tx((db) => db.run("DELETE FROM ai_chat_threads WHERE id = ?", id));
    return current;
  }

  listAiChatRuns(threadId) {
    return this.#scoped((db) => db.all(`
      SELECT * FROM ai_chat_runs
      WHERE thread_id = ?
      ORDER BY started_at, id
    `, threadId).then((rows) => rows.map(aiChatRunFromRow)));
  }

  async getAiChatRun(id) {
    const row = await this.#scoped((db) => db.get("SELECT * FROM ai_chat_runs WHERE id = ?", id));
    return row ? aiChatRunFromRow(row) : null;
  }

  async createAiChatRun(input) {
    const id = input.id ?? randomUUID();
    const timestamp = input.startedAt ?? NOW();
    await this.#tx(async (db) => {
      await db.run(`
        INSERT INTO ai_chat_runs (
          id, thread_id, status, exit_code, error, started_at, finished_at, runner_host
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
        id,
        input.threadId,
        input.status ?? "running",
        input.exitCode ?? null,
        input.error ?? null,
        timestamp,
        input.finishedAt ?? null,
        input.runnerHost ?? null,
      );
      if ((input.status ?? "running") === "running") {
        await db.run(`
          UPDATE ai_chat_threads
          SET status = 'running', updated_at = ?
          WHERE id = ?
        `, timestamp, input.threadId);
      }
      return null;
    });
    return this.getAiChatRun(id);
  }

  async updateAiChatRun(id, changes) {
    const current = await this.getAiChatRun(id);
    if (!current) {
      throw new ApiError(404, "AI_CHAT_RUN_NOT_FOUND", `AI chat run '${id}' does not exist`);
    }
    const columns = {
      status: "status",
      exitCode: "exit_code",
      error: "error",
      finishedAt: "finished_at",
    };
    const assignments = [];
    const values = [];
    for (const [key, column] of Object.entries(columns)) {
      if (!Object.hasOwn(changes, key)) continue;
      assignments.push(`${column} = ?`);
      values.push(changes[key]);
    }
    if (assignments.length === 0) return current;

    await this.#tx(async (db) => {
      values.push(id);
      await db.run(`
        UPDATE ai_chat_runs SET ${assignments.join(", ")} WHERE id = ?
      `, ...values);
      const status = changes.status ?? current.status;
      if (status !== "running") {
        const threadStatus = status === "failed" ? "failed" : "idle";
        await db.run(`
          UPDATE ai_chat_threads
          SET status = ?, updated_at = ?
          WHERE id = ?
            AND NOT EXISTS (
              SELECT 1 FROM ai_chat_runs
              WHERE thread_id = ? AND status = 'running'
            )
        `, threadStatus, changes.finishedAt ?? NOW(), current.threadId, current.threadId);
      }
      return null;
    });
    return this.getAiChatRun(id);
  }

  async insertAiChatEvent(input) {
    const id = input.id ?? randomUUID();
    const timestamp = input.createdAt ?? NOW();
    const row = await this.#tx(async (db) => {
      await db.run(`
        INSERT INTO ai_chat_events (
          id, thread_id, run_id, type, role, content, data, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
        id,
        input.threadId,
        input.runId ?? null,
        input.type,
        input.role,
        input.content,
        input.data === undefined || input.data === null ? null : JSON.stringify(input.data),
        timestamp,
      );
      return db.get("SELECT * FROM ai_chat_events WHERE id = ?", id);
    });
    return aiChatEventFromRow(row);
  }

  listAiChatEvents(threadId) {
    return this.#scoped((db) => db.all(`
      SELECT * FROM ai_chat_events
      WHERE thread_id = ?
      ORDER BY created_at, seq
    `, threadId).then((rows) => rows.map(aiChatEventFromRow)));
  }

  async interruptAbandonedAiChatRuns({ runnerHost } = {}) {
    return this.#tx(async (db) => {
      const timestamp = NOW();
      // Scoped mode (replica startup): only this instance's leftovers, plus NULL rows the
      // migration importer brought over — never another live replica's running turns.
      const ownershipFilter = runnerHost === undefined
        ? ""
        : " AND (runner_host IS NULL OR runner_host = ?)";
      const result = await db.run(`
        UPDATE ai_chat_runs
        SET
          status = 'interrupted',
          error = COALESCE(error, 'Taskboard service restarted'),
          finished_at = COALESCE(finished_at, ?)
        WHERE status = 'running'${ownershipFilter}
      `, ...(runnerHost === undefined ? [timestamp] : [timestamp, runnerHost]));
      if (result.changes > 0) {
        await db.run(`
          UPDATE ai_chat_threads
          SET status = 'idle', updated_at = ?
          WHERE status = 'running'
            AND NOT EXISTS (
              SELECT 1 FROM ai_chat_runs
              WHERE ai_chat_runs.thread_id = ai_chat_threads.id
                AND ai_chat_runs.status = 'running'
            )
        `, timestamp);
      }
      return Number(result.changes);
    });
  }

  // ---- tasks ----

  listTasks(filters) {
    return this.#scoped(async (db) => {
      const where = [];
      const values = [];
      if (filters.projectId) {
        where.push("project_id = ?");
        values.push(filters.projectId);
      }
      if (filters.status) {
        where.push("status = ?");
        values.push(filters.status);
      }
      if (filters.archived === "false") {
        where.push("archived_at IS NULL");
      } else if (filters.archived === "true") {
        where.push("archived_at IS NOT NULL");
      }

      const sql = `
        SELECT * FROM tasks
        ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY
          CASE status
            WHEN 'backlog' THEN 1
            WHEN 'todo' THEN 2
            WHEN 'in_progress' THEN 3
            WHEN 'in_review' THEN 4
            WHEN 'blocked' THEN 5
            WHEN 'done' THEN 6
            WHEN 'canceled' THEN 7
          END,
          sort_order,
          created_at,
          id
      `;
      const rows = await db.all(sql, ...values);
      const ids = rows.map((row) => row.id);
      const commentsByTask = await this.#commentsForTaskActivity(ids, db);
      const activitiesByTask = await this.#activitiesForTasks(ids, db);
      const previewImagesByTask = await this.#taskPreviewImages(ids, db);
      return Promise.all(rows.map(async (row) => attachTaskActivity(
        await this.#taskWithRelations(row, db),
        commentsByTask.get(row.id) ?? [],
        activitiesByTask.get(row.id) ?? [],
        previewImagesByTask.get(row.id) ?? null,
      )));
    });
  }

  async getTask(id) {
    return this.#scoped(async (db) => {
      const row = await db.get("SELECT * FROM tasks WHERE id = ? OR identifier = ?", id, id);
      if (!row) return null;
      return this.#assembledTask(row, db);
    });
  }

  async #assembledTask(row, db) {
    const task = await this.#taskWithRelations(row, db);
    const comments = (await this.#commentsForTaskActivity([task.id], db)).get(task.id) ?? [];
    const activities = (await this.#activitiesForTasks([task.id], db)).get(task.id) ?? [];
    const previewImage = (await this.#taskPreviewImages([task.id], db)).get(task.id) ?? null;
    return attachTaskActivity(task, comments, activities, previewImage);
  }

  async getTaskTree(id, direction, depth) {
    return this.#scoped(async (db) => {
      const root = await db.get(
        "SELECT * FROM tasks WHERE id = ? OR identifier = ?",
        id,
        id,
      );
      if (!root) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);

      const nodes = [taskTreeNode(root, null, 0, [root.id])];
      const seen = new Set([root.id]);
      let frontier = [nodes[0]];
      const relationJoin = direction === "descendants"
        ? `
          FROM task_relations
          JOIN tasks ON tasks.id = task_relations.target_task_id
          WHERE task_relations.relation_type = 'parent'
            AND task_relations.source_task_id IN (%PLACEHOLDERS%)
        `
        : `
          FROM task_relations
          JOIN tasks ON tasks.id = task_relations.source_task_id
          WHERE task_relations.relation_type = 'parent'
            AND task_relations.target_task_id IN (%PLACEHOLDERS%)
        `;
      const parentColumn = direction === "descendants"
        ? "task_relations.source_task_id"
        : "task_relations.target_task_id";

      for (let level = 1; level <= depth && frontier.length > 0; level += 1) {
        const placeholders = frontier.map(() => "?").join(", ");
        const rows = await db.all(`
          SELECT tasks.*, ${parentColumn} AS tree_parent_id
          ${relationJoin.replace("%PLACEHOLDERS%", placeholders)}
          ORDER BY tasks.sort_order, tasks.created_at, tasks.id
        `, ...frontier.map((node) => node.id));
        const rowsByParent = new Map();
        for (const row of rows) {
          const siblings = rowsByParent.get(row.tree_parent_id) ?? [];
          siblings.push(row);
          rowsByParent.set(row.tree_parent_id, siblings);
        }
        const next = [];
        for (const parent of frontier) {
          for (const row of rowsByParent.get(parent.id) ?? []) {
            if (seen.has(row.id)) continue;
            if (nodes.length >= TASK_TREE_MAX_NODES) {
              throw new ApiError(413, "TREE_TOO_LARGE", `Task tree cannot exceed ${TASK_TREE_MAX_NODES} nodes`);
            }
            const node = taskTreeNode(row, parent.id, level, [...parent.path, row.id]);
            nodes.push(node);
            next.push(node);
            seen.add(row.id);
          }
        }
        frontier = next;
      }

      return {
        rootId: root.id,
        direction,
        depth,
        nodeCount: nodes.length,
        nodes,
      };
    });
  }

  async createTask(input) {
    const id = await this.#tx(async (db) => {
      const project = await db.get(`
        SELECT
          projects.id,
          projects.name,
          projects.labels,
          projects.next_task_number,
          (
            SELECT tasks.identifier
            FROM tasks
            WHERE tasks.project_id = projects.id
            ORDER BY tasks.created_at, tasks.id
            LIMIT 1
          ) AS first_identifier
        FROM projects
        WHERE projects.id = ?
      `, input.projectId);
      if (!project) {
        throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${input.projectId}' does not exist`);
      }

      const prefix = projectPrefix(project);
      // Mirrors the SQLite GLOB '<prefix>-[0-9]*' scan; the prefix is alphanumeric-safe in regex.
      const maximumRow = await db.get(`
        SELECT MAX(CAST(substring(identifier FROM ?) AS INTEGER)) AS number
        FROM tasks
        WHERE identifier ~ ('^' || ? || '-[0-9]+$')
      `, prefix.length + 2, prefix);
      const maximum = maximumRow?.number ?? null;
      const number = Math.max(project.next_task_number, maximum === null ? 1 : maximum + 1);
      const identifier = `${prefix}-${number}`;
      const taskId = randomUUID();
      const timestamp = NOW();
      let sortOrder = input.sortOrder;
      if (sortOrder === undefined) {
        const row = await db.get(`
          SELECT MIN(sort_order) AS minimum
          FROM tasks
          WHERE project_id = ? AND status = ? AND archived_at IS NULL
        `, input.projectId, input.status);
        sortOrder = row.minimum === null ? 1000 : row.minimum - 1000;
      }

      await db.run(`
        UPDATE projects SET next_task_number = ?, labels = ?, updated_at = ? WHERE id = ?
      `,
        number + 1,
        JSON.stringify([...new Set([...JSON.parse(project.labels), ...input.labels])]),
        timestamp,
        input.projectId,
      );
      await db.run(`
        INSERT INTO tasks (
          id, identifier, project_id, title, description, status, priority, labels,
          sort_order, thread_id, thread_codex_project_id, thread_codex_project_kind,
          thread_codex_host_id, thread_workspace_path,
          creator_type, creator_id, creator_name, creator_avatar_url,
          assignee_type, assignee_id, assignee_name, assignee_avatar_url,
          git_branch, worktree_path, worktree_branch,
          start_date, due_date, recurrence_interval, recurrence_unit,
          archived_at, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)
      `,
        taskId,
        identifier,
        input.projectId,
        input.title,
        input.description,
        input.status,
        input.priority,
        JSON.stringify(input.labels),
        sortOrder,
        ...(storedThreadBinding(input.threadBinding, input.threadId) ?? [null, null, null, null, null]),
        input.actor.type,
        input.actor.id,
        input.actor.name,
        input.actor.avatarUrl,
        input.assignee.type,
        input.assignee.id,
        input.assignee.name,
        input.assignee.avatarUrl,
        input.developmentContext?.type === "branch" ? input.developmentContext.branch : null,
        input.developmentContext?.type === "worktree" ? input.developmentContext.path : null,
        input.developmentContext?.type === "worktree" ? input.developmentContext.branch : null,
        input.startDate,
        input.dueDate,
        input.recurrence?.interval ?? null,
        input.recurrence?.unit ?? null,
        timestamp,
        timestamp,
      );
      return taskId;
    });
    return this.getTask(id);
  }

  async updateTask(id, version, changes, threadId, threadBinding, actor) {
    await this.#tx(async (db) => {
      const current = await this.#requireTask(id, db);
      this.#requireVersion(current, version);
      this.#assertThreadBindingOwnership(current, threadBinding, threadId);
      const activityChanges = taskFieldChanges(current, changes);
      const targetProject = Object.hasOwn(changes, "projectId")
        ? await db.get("SELECT id, name, workspace_path, labels FROM projects WHERE id = ?", changes.projectId)
        : null;
      if (Object.hasOwn(changes, "projectId") && !targetProject) {
        throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${changes.projectId}' does not exist`);
      }
      const projectChanged = Boolean(targetProject && targetProject.id !== current.projectId);
      if (projectChanged) {
        const relation = await db.get(`
          SELECT 1 AS found
          FROM task_relations
          WHERE source_task_id = ? OR target_task_id = ?
          LIMIT 1
        `, current.id, current.id);
        if (relation) {
          throw new ApiError(
            409,
            "CROSS_PROJECT_RELATION",
            "Remove issue relations before moving the issue to another project",
          );
        }
        if (await this.#hasAiChatThreadProjectConflictScoped(current.id, targetProject.id, db)) {
          throw new ApiError(
            409,
            "AI_CHAT_PROJECT_MOVE_BLOCKED",
            "Delete issue-linked AI conversations before moving the issue to another project",
          );
        }
      }
      const dueDate = Object.hasOwn(changes, "dueDate") ? changes.dueDate : current.dueDate;
      const recurrence = Object.hasOwn(changes, "recurrence") ? changes.recurrence : current.recurrence;
      if (recurrence && !dueDate) {
        throw new ApiError(400, "INVALID_FIELD", "A recurring issue requires a due date");
      }

      const columns = {
        projectId: "project_id",
        title: "title",
        description: "description",
        status: "status",
        priority: "priority",
        labels: "labels",
        startDate: "start_date",
        dueDate: "due_date",
      };
      const assignments = [];
      const values = [];
      for (const [key, value] of Object.entries(changes)) {
        if (key === "developmentContext") {
          assignments.push("git_branch = ?", "worktree_path = ?", "worktree_branch = ?");
          values.push(
            value?.type === "branch" ? value.branch : null,
            value?.type === "worktree" ? value.path : null,
            value?.type === "worktree" ? value.branch : null,
          );
          continue;
        }
        if (key === "recurrence") {
          assignments.push("recurrence_interval = ?", "recurrence_unit = ?");
          values.push(value?.interval ?? null, value?.unit ?? null);
          continue;
        }
        if (key === "assignee") {
          assignments.push(
            "assignee_type = ?",
            "assignee_id = ?",
            "assignee_name = ?",
            "assignee_avatar_url = ?",
          );
          values.push(value.type, value.id, value.name, value.avatarUrl);
          continue;
        }
        assignments.push(`${columns[key]} = ?`);
        values.push(key === "labels" ? JSON.stringify(value) : value);
      }
      if (Object.hasOwn(changes, "status") && changes.status !== current.status) {
        const placementProjectId = projectChanged ? targetProject.id : current.projectId;
        const row = await db.get(`
          SELECT MIN(sort_order) AS minimum
          FROM tasks
          WHERE project_id = ? AND status = ? AND archived_at IS NULL AND id != ?
        `, placementProjectId, changes.status, current.id);
        assignments.push("sort_order = ?");
        values.push(row.minimum === null ? 1000 : row.minimum - 1000);
      }
      const storedBinding = storedThreadBindingForExisting(current, threadBinding, threadId);
      if (storedBinding && !Object.hasOwn(changes, "projectId")) {
        assignments.push(
          "thread_id = ?",
          "thread_codex_project_id = ?",
          "thread_codex_project_kind = ?",
          "thread_codex_host_id = ?",
          "thread_workspace_path = ?",
        );
        values.push(...storedBinding);
      }
      assignments.push("version = version + 1", "updated_at = ?");
      const timestamp = NOW();
      values.push(timestamp, current.id, version);

      const updateResult = await db.run(`
        UPDATE tasks SET ${assignments.join(", ")} WHERE id = ? AND version = ?
      `, ...values);
      if (updateResult.changes !== 1) {
        await this.#throwMissingOrConflict(id, version);
      }
      if (projectChanged) {
        await db.run(`
          UPDATE projects SET updated_at = ? WHERE id IN (?, ?)
        `, timestamp, current.projectId, targetProject.id);
      }
      const destinationProjectId = projectChanged ? targetProject.id : current.projectId;
      const destinationProject = await db.get(`
        SELECT labels FROM projects WHERE id = ?
      `, destinationProjectId);
      const taskLabels = Object.hasOwn(changes, "labels") ? changes.labels : current.labels;
      const projectLabels = JSON.parse(destinationProject.labels);
      const mergedLabels = [...new Set([...projectLabels, ...taskLabels])];
      if (mergedLabels.length !== projectLabels.length) {
        await db.run(`
          UPDATE projects SET labels = ?, updated_at = ? WHERE id = ?
        `, JSON.stringify(mergedLabels), timestamp, destinationProjectId);
      }
      await this.#recordTaskActivity(current.id, actor, activityChanges, timestamp, db);
      return null;
    });
    return this.getTask(id);
  }

  async moveTask(id, version, status, sortOrder, threadId, threadBinding, actor) {
    await this.#tx(async (db) => {
      const current = await this.#requireTask(id, db);
      this.#requireVersion(current, version);
      if (current.archivedAt !== null) {
        throw new ApiError(409, "TASK_ARCHIVED", "Archived tasks cannot be moved");
      }
      this.#assertThreadBindingOwnership(current, threadBinding, threadId);
      if (status !== current.status && sortOrder === undefined) {
        const row = await db.get(`
          SELECT MIN(sort_order) AS minimum
          FROM tasks
          WHERE project_id = ? AND status = ? AND archived_at IS NULL AND id != ?
        `, current.projectId, status, current.id);
        sortOrder = row.minimum === null ? 1000 : row.minimum - 1000;
      } else if (sortOrder === undefined) {
        const row = await db.get(`
          SELECT COALESCE(MAX(sort_order), 0) AS maximum
          FROM tasks
          WHERE project_id = ? AND status = ? AND archived_at IS NULL AND id != ?
        `, current.projectId, status, current.id);
        sortOrder = row.maximum + 1000;
      }

      const timestamp = NOW();
      const storedBinding = storedThreadBindingForExisting(current, threadBinding, threadId);
      const threadAssignment = storedBinding
        ? `thread_id = ?, thread_codex_project_id = ?, thread_codex_project_kind = ?,
          thread_codex_host_id = ?, thread_workspace_path = ?,`
        : "";
      const result = await db.run(`
        UPDATE tasks
        SET status = ?, sort_order = ?, ${threadAssignment} version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `, status, sortOrder, ...(storedBinding ?? []), timestamp, current.id, version);
      if (result.changes !== 1) {
        await this.#throwMissingOrConflict(id, version);
      }
      await this.#recordTaskActivity(
        current.id,
        actor,
        taskFieldChanges(current, { status }),
        timestamp,
        db,
      );
      return null;
    });
    return this.getTask(id);
  }

  async archiveTask(id, version, threadId, threadBinding, actor) {
    await this.#tx(async (db) => {
      const current = await this.#requireTask(id, db);
      this.#requireVersion(current, version);
      this.#assertThreadBindingOwnership(current, threadBinding, threadId);
      const timestamp = NOW();
      const storedBinding = storedThreadBindingForExisting(current, threadBinding, threadId);
      const threadAssignment = storedBinding
        ? `thread_id = ?, thread_codex_project_id = ?, thread_codex_project_kind = ?,
          thread_codex_host_id = ?, thread_workspace_path = ?,`
        : "";
      const result = await db.run(`
        UPDATE tasks
        SET archived_at = ?, ${threadAssignment} version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `, timestamp, ...(storedBinding ?? []), timestamp, current.id, version);
      if (result.changes !== 1) {
        await this.#throwMissingOrConflict(id, version);
      }
      await this.#recordTaskActivity(
        current.id,
        actor,
        [{ field: "archivedAt", before: current.archivedAt, after: timestamp }],
        timestamp,
        db,
      );
      return null;
    });
    return this.getTask(id);
  }

  async restoreTask(id, version, threadId, threadBinding, actor) {
    await this.#tx(async (db) => {
      const current = await this.#requireTask(id, db);
      this.#requireVersion(current, version);
      if (current.archivedAt === null) {
        throw new ApiError(409, "TASK_NOT_ARCHIVED", "Only archived tasks can be restored");
      }
      const timestamp = NOW();
      const storedBinding = storedThreadBindingForExisting(current, threadBinding, threadId);
      const threadAssignment = storedBinding
        ? `thread_id = ?, thread_codex_project_id = ?, thread_codex_project_kind = ?,
          thread_codex_host_id = ?, thread_workspace_path = ?,`
        : "";
      const result = await db.run(`
        UPDATE tasks
        SET archived_at = NULL, ${threadAssignment} version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `, ...(storedBinding ?? []), timestamp, current.id, version);
      if (result.changes !== 1) {
        await this.#throwMissingOrConflict(id, version);
      }
      await this.#recordTaskActivity(
        current.id,
        actor,
        [{ field: "archivedAt", before: current.archivedAt, after: null }],
        timestamp,
        db,
      );
      return null;
    });
    return this.getTask(id);
  }

  async deleteArchivedTask(id, version) {
    return this.#tx(async (db) => {
      const current = await this.#requireTask(id, db);
      this.#requireVersion(current, version);
      if (current.archivedAt === null) {
        throw new ApiError(409, "TASK_NOT_ARCHIVED", "Only archived tasks can be deleted");
      }
      const attachmentRows = await db.all(
        "SELECT id FROM attachments WHERE task_id = ? ORDER BY created_at, id",
        current.id,
      );
      const attachmentIds = attachmentRows.map((attachment) => attachment.id);
      const result = await db.run(
        "DELETE FROM tasks WHERE id = ? AND version = ? AND archived_at IS NOT NULL",
        current.id,
        version,
      );
      if (result.changes !== 1) await this.#throwMissingOrConflict(id, version);
      return { task: current, attachmentIds };
    });
  }

  async addTaskRelation(id, version, type, relatedId, threadId, threadBinding, actor, origin = "manual") {
    return this.#tx(async (db) => {
      const task = await this.#requireTask(id, db);
      const relatedTask = await this.#requireTask(relatedId, db);
      this.#requireVersion(task, version);
      this.#validateRelationTasks(task, relatedTask);

      const { relationType, sourceTaskId, targetTaskId } = this.#relationEndpoints(
        type,
        task.id,
        relatedTask.id,
      );
      if (relationType === "parent") {
        await this.#assertNoParentCycle(task.id, relatedTask.id, db);
        const existing = await db.get(`
          SELECT source_task_id
          FROM task_relations
          WHERE relation_type = 'parent' AND target_task_id = ?
        `, task.id);
        if (existing?.source_task_id === relatedTask.id) {
          throw new ApiError(409, "RELATION_EXISTS", "This parent relation already exists");
        }
        if (existing) {
          await db.run(`
            DELETE FROM task_relations
            WHERE relation_type = 'parent' AND target_task_id = ?
          `, task.id);
        }
      } else {
        const existing = await db.get(`
          SELECT 1 AS found
          FROM task_relations
          WHERE relation_type = ? AND source_task_id = ? AND target_task_id = ?
        `, relationType, sourceTaskId, targetTaskId);
        if (existing) {
          throw new ApiError(409, "RELATION_EXISTS", "This issue relation already exists");
        }
      }

      const timestamp = NOW();
      const previousRelation = type === "parent" && task.relations.parent
        ? relationActivityValue(type, task.relations.parent)
        : null;
      await db.run(`
        INSERT INTO task_relations (
          relation_type, source_task_id, target_task_id, origin, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `, relationType, sourceTaskId, targetTaskId, origin, timestamp);
      await this.#touchTask(task.id, version, threadId, threadBinding, timestamp, db);
      await this.#recordTaskActivity(task.id, actor, [{
        field: "relation",
        before: previousRelation,
        after: relationActivityValue(type, relatedTask),
      }], timestamp, db);
      return {
        task: await this.getTask(task.id),
        relatedTask: await this.getTask(relatedTask.id),
      };
    });
  }

  async removeTaskRelation(id, version, type, relatedId, threadId, threadBinding, actor, origin) {
    return this.#tx(async (db) => {
      const task = await this.#requireTask(id, db);
      const relatedTask = await this.#requireTask(relatedId, db);
      this.#requireVersion(task, version);
      this.#validateRelationTasks(task, relatedTask);
      const { relationType, sourceTaskId, targetTaskId } = this.#relationEndpoints(
        type,
        task.id,
        relatedTask.id,
      );
      const relation = await db.get(`
        SELECT origin
        FROM task_relations
        WHERE relation_type = ? AND source_task_id = ? AND target_task_id = ?
      `, relationType, sourceTaskId, targetTaskId);
      if (!relation) {
        throw new ApiError(404, "RELATION_NOT_FOUND", "This issue relation does not exist");
      }
      if (origin && relation.origin !== origin) {
        return {
          task: await this.getTask(task.id),
          relatedTask: await this.getTask(relatedTask.id),
        };
      }
      let deletedCount;
      if (origin === "mention" && relationType === "related") {
        const taskReference = `](?${new URLSearchParams({
          project: task.projectId,
          issue: relatedTask.identifier,
        })})`;
        const relatedTaskReference = `](?${new URLSearchParams({
          project: task.projectId,
          issue: task.identifier,
        })})`;
        deletedCount = (await db.run(`
          DELETE FROM task_relations
          WHERE relation_type = ? AND source_task_id = ? AND target_task_id = ?
            AND origin = 'mention'
            AND NOT EXISTS (
              SELECT 1
              FROM tasks
              WHERE (id = ? AND position(? IN description) > 0)
                OR (id = ? AND position(? IN description) > 0)
            )
            AND NOT EXISTS (
              SELECT 1
              FROM comments
              WHERE (task_id = ? AND position(? IN body) > 0)
                OR (task_id = ? AND position(? IN body) > 0)
            )
        `,
          relationType,
          sourceTaskId,
          targetTaskId,
          task.id,
          taskReference,
          relatedTask.id,
          relatedTaskReference,
          task.id,
          taskReference,
          relatedTask.id,
          relatedTaskReference,
        )).changes;
      } else {
        deletedCount = (await db.run(`
          DELETE FROM task_relations
          WHERE relation_type = ? AND source_task_id = ? AND target_task_id = ?
        `, relationType, sourceTaskId, targetTaskId)).changes;
      }
      if (origin === "mention" && relationType === "related" && deletedCount === 0) {
        return {
          task: await this.getTask(task.id),
          relatedTask: await this.getTask(relatedTask.id),
        };
      }
      const timestamp = NOW();
      await this.#touchTask(task.id, version, threadId, threadBinding, timestamp, db);
      await this.#recordTaskActivity(task.id, actor, [{
        field: "relation",
        before: relationActivityValue(type, relatedTask),
        after: null,
      }], timestamp, db);
      return {
        task: await this.getTask(task.id),
        relatedTask: await this.getTask(relatedTask.id),
      };
    });
  }

  listTaskActivities(taskId) {
    return this.#scoped(async (db) => {
      const task = await this.#requireTask(taskId, db);
      const rows = await db.all(`
        SELECT * FROM task_activities
        WHERE task_id = ?
        ORDER BY created_at, id
      `, task.id);
      return rows.map(taskActivityFromRow);
    });
  }

  // ---- comments & attachments ----

  listComments(taskId) {
    return this.#scoped(async (db) => {
      const task = await this.#requireTask(taskId, db);
      const rows = await db.all(`
        SELECT * FROM comments
        WHERE task_id = ?
        ORDER BY created_at, id
      `, task.id);
      return Promise.all(rows.map((row) => this.#commentWithAttachments(row, db)));
    });
  }

  listCommentsAfter(taskId, after) {
    return this.#scoped(async (db) => {
      const task = await this.#requireTask(taskId, db);
      const rows = await db.all(`
        SELECT * FROM comments
        WHERE task_id = ?
          AND change_revision > ?
        ORDER BY change_revision
      `, task.id, after.revision);
      return Promise.all(rows.map((row) => this.#commentWithAttachments(row, db)));
    });
  }

  async createComment(taskId, input) {
    const id = randomUUID();
    await this.#tx(async (db) => {
      const task = await this.#requireTask(taskId, db);
      const changeRevision = await this.#nextCommentAttachmentRevision(db);
      const timestamp = NOW();
      await db.run(`
        INSERT INTO comments (
          id, task_id, body, thread_id, thread_codex_project_id, thread_codex_project_kind,
          thread_codex_host_id, thread_workspace_path,
          author_type, author_id, author_name, author_avatar_url,
          version, created_at, updated_at, change_revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      `,
        id,
        task.id,
        input.body,
        ...(storedThreadBinding(input.threadBinding, input.threadId) ?? [null, null, null, null, null]),
        input.actor.type,
        input.actor.id,
        input.actor.name,
        input.actor.avatarUrl,
        timestamp,
        timestamp,
        changeRevision,
      );
      return null;
    });
    return this.getComment(id);
  }

  async getComment(id) {
    const row = await this.#scoped((db) => db.get("SELECT * FROM comments WHERE id = ?", id));
    return row ? this.#commentWithAttachments(row) : null;
  }

  async updateComment(id, version, body, threadId, threadBinding) {
    const storedBinding = storedThreadBinding(threadBinding, threadId);
    const threadAssignment = storedBinding
      ? `thread_id = ?, thread_codex_project_id = ?, thread_codex_project_kind = ?,
        thread_codex_host_id = ?, thread_workspace_path = ?,`
      : "";
    await this.#tx(async (db) => {
      const current = await this.#requireComment(id, db);
      this.#requireCommentVersion(current, version);
      const changeRevision = await this.#nextCommentAttachmentRevision(db);
      const result = await db.run(`
        UPDATE comments
        SET body = ?, ${threadAssignment} version = version + 1, updated_at = ?,
          change_revision = ?
        WHERE id = ? AND version = ?
      `, body, ...(storedBinding ?? []), NOW(), changeRevision, id, version);
      if (result.changes !== 1) {
        await this.#throwMissingCommentOrConflict(id, version);
      }
      return null;
    });
    return this.getComment(id);
  }

  async deleteComment(id, version) {
    const result = await this.#tx(async (db) => {
      const current = await this.#requireComment(id, db);
      this.#requireCommentVersion(current, version);
      const deleteResult = await db.run(`
        DELETE FROM comments WHERE id = ? AND version = ?
      `, id, version);
      if (deleteResult.changes !== 1) {
        await this.#throwMissingCommentOrConflict(id, version);
      }
      return current;
    });
    return result;
  }

  listAttachments(taskId, after = null) {
    return this.#scoped(async (db) => {
      const task = await this.#requireTask(taskId, db);
      if (after) {
        const rows = await db.all(`
          SELECT * FROM attachments
          WHERE task_id = ? AND comment_id IS NULL
            AND change_revision > ?
          ORDER BY change_revision
        `, task.id, after.revision);
        return rows.map(attachmentFromRow);
      }
      const rows = await db.all(`
        SELECT * FROM attachments
        WHERE task_id = ? AND comment_id IS NULL
        ORDER BY created_at, id
      `, task.id);
      return rows.map(attachmentFromRow);
    });
  }

  async createAttachment(taskId, input) {
    await this.#tx(async (db) => {
      const task = await this.#requireTask(taskId, db);
      const changeRevision = await this.#nextCommentAttachmentRevision(db);
      await db.run(`
        INSERT INTO attachments (
          id, task_id, comment_id, kind, filename, content_type, size, created_at, change_revision
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)
      `,
        input.id,
        task.id,
        input.kind,
        input.filename,
        input.contentType,
        input.size,
        NOW(),
        changeRevision,
      );
      return null;
    });
    return this.getAttachment(input.id);
  }

  listCommentAttachments(commentId, after = null) {
    return this.#scoped(async (db) => {
      const comment = await db.get("SELECT id FROM comments WHERE id = ?", commentId);
      if (!comment) {
        throw new ApiError(404, "COMMENT_NOT_FOUND", `Comment '${commentId}' does not exist`);
      }
      return this.#attachmentsForComment(commentId, after, db);
    });
  }

  async createCommentAttachment(commentId, input) {
    await this.#tx(async (db) => {
      const comment = await this.#requireComment(commentId, db);
      const changeRevision = await this.#nextCommentAttachmentRevision(db);
      await db.run(`
        INSERT INTO attachments (
          id, task_id, comment_id, kind, filename, content_type, size, created_at, change_revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        input.id,
        comment.taskId,
        comment.id,
        input.kind,
        input.filename,
        input.contentType,
        input.size,
        NOW(),
        changeRevision,
      );
      return null;
    });
    return this.getAttachment(input.id);
  }

  async getAttachment(id) {
    const row = await this.#scoped((db) => db.get("SELECT * FROM attachments WHERE id = ?", id));
    return row ? attachmentFromRow(row) : null;
  }

  async deleteAttachment(id) {
    const attachment = await this.getAttachment(id);
    if (!attachment) {
      throw new ApiError(404, "ATTACHMENT_NOT_FOUND", `Attachment '${id}' does not exist`);
    }
    await this.#tx((db) => db.run("DELETE FROM attachments WHERE id = ?", id));
    return attachment;
  }

  // ---- device credentials ----

  async createDevice({ id, name }) {
    if (!id || id.includes(":") || !name) {
      // ':' would corrupt the "deviceId:token" composite string carried by companions.
      throw new ApiError(400, "INVALID_DEVICE_ID", "Device id must not contain ':' and requires a name");
    }
    await this.#ready();
    const token = randomBytes(32).toString("base64url");
    try {
      await (await this.getPool()).query(
        pgParams(`
          INSERT INTO devices (id, name, token_hash, created_at, revoked_at)
          VALUES (?, ?, ?, ?, NULL)
        `),
        [id, name, createHash("sha256").update(token).digest("hex"), NOW()],
      );
    } catch (error) {
      if (this.uniqueViolation(error)) {
        throw new ApiError(409, "DEVICE_EXISTS", `Device '${id}' already exists`);
      }
      throw error;
    }
    return { id, name, token };
  }

  async listDevices() {
    const result = await (await this.getPool()).query(
      "SELECT id, name, created_at, revoked_at FROM devices ORDER BY created_at, id",
    );
    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
    }));
  }

  async revokeDevice(id) {
    await this.#ready();
    const result = await (await this.getPool()).query(
      pgParams("UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL"),
      [NOW(), id],
    );
    if (result.rowCount !== 1) {
      throw new ApiError(404, "DEVICE_NOT_FOUND", `Active device '${id}' does not exist`);
    }
  }

  async authenticateDevice(username, password) {
    if (!username || !password) return null;
    await this.#ready();
    const row = (await (await this.getPool()).query(
      "SELECT id, name, token_hash, revoked_at FROM devices WHERE id = $1",
      [username],
    )).rows[0];
    if (!row || row.revoked_at !== null) return null;
    const expected = Buffer.from(row.token_hash, "hex");
    const provided = Buffer.from(createHash("sha256").update(password).digest(), "hex");
    if (expected.length !== provided.length || !timingSafeEqual(provided, expected)) return null;
    return { type: "user", id: row.id, name: row.name, avatarUrl: null };
  }

  // ---- shared internals (each accepts an optional scoped statement runner) ----

  async #hasAiChatThreadProjectConflictScoped(issueRef, projectId, db) {
    return Boolean(await db.get(`
      SELECT 1 AS found
      FROM ai_chat_threads
      WHERE (origin_issue_id = ? OR origin_issue_identifier = ?)
        AND origin_project_id != ?
      LIMIT 1
    `, issueRef, issueRef, projectId));
  }

  async #commentWithAttachments(row, db = this.#root()) {
    const comment = commentFromRow(row);
    comment.attachments = await this.#attachmentsForComment(comment.id, null, db);
    return comment;
  }

  async #aiChatThreadWithCurrentRun(row, db = this.#root()) {
    const thread = aiChatThreadFromRow(row);
    const currentRun = await db.get(`
      SELECT * FROM ai_chat_runs
      WHERE thread_id = ? AND status = 'running'
      ORDER BY started_at DESC, id DESC
      LIMIT 1
    `, thread.id);
    thread.currentRun = currentRun ? aiChatRunFromRow(currentRun) : null;
    const todoRows = await db.all(`
      SELECT id, thread_id, run_id, data, created_at
      FROM ai_chat_events
      WHERE thread_id = ? AND type = 'todo_list'
      ORDER BY created_at DESC, seq DESC
    `, thread.id);
    thread.latestTodo = todoRows
      .filter((todoRow) => !thread.currentRun || todoRow.run_id === thread.currentRun.id)
      .map(parseAiChatTodoProgress)
      .find(Boolean) ?? null;
    return thread;
  }

  async #commentsForTaskActivity(taskIds, db = this.#root()) {
    const commentsByTask = new Map(taskIds.map((taskId) => [taskId, []]));
    for (let offset = 0; offset < taskIds.length; offset += 400) {
      const chunk = taskIds.slice(offset, offset + 400);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = await db.all(`
        SELECT
          id, task_id,
          CASE WHEN thread_id IS NULL THEN NULL ELSE substring(body FROM 1 FOR 512) END AS body,
          thread_id, thread_codex_project_id, thread_codex_project_kind,
          thread_codex_host_id, thread_workspace_path,
          author_type, author_id, author_name,
          author_avatar_url, version, updated_at
        FROM comments
        WHERE task_id IN (${placeholders})
        ORDER BY task_id, id
      `, ...chunk);
      for (const row of rows) commentsByTask.get(row.task_id)?.push(row);
    }
    return commentsByTask;
  }

  async #activitiesForTasks(taskIds, db = this.#root()) {
    const activitiesByTask = new Map(taskIds.map((taskId) => [taskId, []]));
    for (let offset = 0; offset < taskIds.length; offset += 400) {
      const chunk = taskIds.slice(offset, offset + 400);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = await db.all(`
        SELECT
          id, task_id, actor_type, actor_id, actor_name, actor_avatar_url, created_at
        FROM task_activities
        WHERE task_id IN (${placeholders})
        ORDER BY task_id, created_at, id
      `, ...chunk);
      for (const row of rows) activitiesByTask.get(row.task_id)?.push(row);
    }
    return activitiesByTask;
  }

  async #taskPreviewImages(taskIds, db = this.#root()) {
    const imagesByTask = new Map();
    for (let offset = 0; offset < taskIds.length; offset += 400) {
      const chunk = taskIds.slice(offset, offset + 400);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = await db.all(`
        SELECT attachments.*
        FROM attachments
        JOIN tasks ON tasks.id = attachments.task_id
        WHERE attachments.task_id IN (${placeholders})
          AND attachments.comment_id IS NULL
          AND attachments.content_type LIKE 'image/%'
          AND position(('api/attachments/' || attachments.id || '/content') IN tasks.description) > 0
        ORDER BY attachments.task_id, attachments.created_at, attachments.id
      `, ...chunk);
      for (const row of rows) {
        if (!imagesByTask.has(row.task_id)) imagesByTask.set(row.task_id, attachmentFromRow(row));
      }
    }
    return imagesByTask;
  }

  async #attachmentsForComment(commentId, after = null, db = this.#root()) {
    if (after) {
      const rows = await db.all(`
        SELECT * FROM attachments
        WHERE comment_id = ?
          AND change_revision > ?
        ORDER BY change_revision
      `, commentId, after.revision);
      return rows.map(attachmentFromRow);
    }
    const rows = await db.all(`
      SELECT * FROM attachments
      WHERE comment_id = ?
      ORDER BY created_at, id
    `, commentId);
    return rows.map(attachmentFromRow);
  }

  async #nextCommentAttachmentRevision(db = this.#root()) {
    return (await db.get(`
      UPDATE comment_attachment_revision
      SET value = value + 1
      WHERE id = 1
      RETURNING value
    `)).value;
  }

  async #taskWithRelations(row, db = this.#root()) {
    const task = taskFromRow(row);
    const parent = await db.get(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.source_task_id
      WHERE task_relations.relation_type = 'parent'
        AND task_relations.target_task_id = ?
    `, task.id);
    const subIssues = await db.all(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.target_task_id
      WHERE task_relations.relation_type = 'parent'
        AND task_relations.source_task_id = ?
      ORDER BY tasks.sort_order, tasks.created_at, tasks.id
    `, task.id);
    const blockedBy = await db.all(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.source_task_id
      WHERE task_relations.relation_type = 'blocks'
        AND task_relations.target_task_id = ?
      ORDER BY tasks.sort_order, tasks.created_at, tasks.id
    `, task.id);
    const blocks = await db.all(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.target_task_id
      WHERE task_relations.relation_type = 'blocks'
        AND task_relations.source_task_id = ?
      ORDER BY tasks.sort_order, tasks.created_at, tasks.id
    `, task.id);
    const related = await db.all(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = CASE
        WHEN task_relations.source_task_id = ? THEN task_relations.target_task_id
        ELSE task_relations.source_task_id
      END
      WHERE task_relations.relation_type = 'related'
        AND (
          task_relations.source_task_id = ?
          OR task_relations.target_task_id = ?
        )
      ORDER BY tasks.sort_order, tasks.created_at, tasks.id
    `, task.id, task.id, task.id);
    task.relations = {
      parent: parent ? taskRelationSummaryFromRow(parent) : null,
      subIssues: subIssues.map(taskRelationSummaryFromRow),
      blockedBy: blockedBy.map(taskRelationSummaryFromRow),
      blocks: blocks.map(taskRelationSummaryFromRow),
      related: related.map(taskRelationSummaryFromRow),
    };
    return task;
  }

  #validateRelationTasks(task, relatedTask) {
    if (task.id === relatedTask.id) {
      throw new ApiError(400, "SELF_RELATION", "An issue cannot be related to itself");
    }
    if (task.projectId !== relatedTask.projectId) {
      throw new ApiError(400, "CROSS_PROJECT_RELATION", "Issue relations must stay within one project");
    }
  }

  #relationEndpoints(type, taskId, relatedTaskId) {
    if (type === "parent") {
      return {
        relationType: "parent",
        sourceTaskId: relatedTaskId,
        targetTaskId: taskId,
      };
    }
    if (type === "blocks") {
      return {
        relationType: "blocks",
        sourceTaskId: taskId,
        targetTaskId: relatedTaskId,
      };
    }
    if (type === "blocked_by") {
      return {
        relationType: "blocks",
        sourceTaskId: relatedTaskId,
        targetTaskId: taskId,
      };
    }
    const [sourceTaskId, targetTaskId] = [taskId, relatedTaskId].sort();
    return { relationType: "related", sourceTaskId, targetTaskId };
  }

  async #assertNoParentCycle(childId, parentId, db = this.#root()) {
    const cycle = await db.get(`
      WITH RECURSIVE ancestors(id) AS (
        SELECT source_task_id
        FROM task_relations
        WHERE relation_type = 'parent' AND target_task_id = ?
        UNION
        SELECT task_relations.source_task_id
        FROM task_relations
        JOIN ancestors ON task_relations.target_task_id = ancestors.id
        WHERE task_relations.relation_type = 'parent'
      )
      SELECT 1 AS found FROM ancestors WHERE id = ?
    `, parentId, childId);
    if (cycle) {
      throw new ApiError(409, "RELATION_CYCLE", "This parent would create a cycle");
    }
  }

  async #recordTaskActivity(taskId, actor, changes, timestamp, db = this.#root()) {
    if (changes.length === 0) return;
    await db.run(`
      INSERT INTO task_activities (
        id, task_id, actor_type, actor_id, actor_name, actor_avatar_url, changes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      randomUUID(),
      taskId,
      actor.type,
      actor.id,
      actor.name,
      actor.avatarUrl,
      JSON.stringify(changes),
      timestamp,
    );
  }

  async #touchTask(id, version, threadId, threadBinding, timestamp, db = this.#root()) {
    const current = await this.#requireTask(id, db);
    const storedBinding = storedThreadBindingForExisting(current, threadBinding, threadId);
    const threadAssignment = storedBinding
      ? `thread_id = ?, thread_codex_project_id = ?, thread_codex_project_kind = ?,
        thread_codex_host_id = ?, thread_workspace_path = ?,`
      : "";
    const result = await db.run(`
      UPDATE tasks
      SET ${threadAssignment} version = version + 1, updated_at = ?
      WHERE id = ? AND version = ?
    `, ...(storedBinding ?? []), timestamp, id, version);
    if (result.changes !== 1) {
      await this.#throwMissingOrConflict(id, version);
    }
  }

  async #requireTask(id, db = this.#root()) {
    const task = await this.getTaskVia(db, id);
    if (!task) {
      throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
    }
    return task;
  }

  async getTaskVia(db, id) {
    const row = await db.get("SELECT * FROM tasks WHERE id = ? OR identifier = ?", id, id);
    if (!row) return null;
    return this.#assembledTask(row, db);
  }

  async #requireComment(id, db = this.#root()) {
    const row = await db.get("SELECT * FROM comments WHERE id = ?", id);
    if (!row) {
      throw new ApiError(404, "COMMENT_NOT_FOUND", `Comment '${id}' does not exist`);
    }
    // Mirrors the SQLite contract: callers receive the mapped comment incl. attachments.
    return this.#commentWithAttachments(row, db);
  }

  #assertThreadBindingOwnership(current, threadBinding, threadId) {
    const stored = current.threadBinding;
    if (!stored?.codexHostId) return;
    if (threadBinding === null) return;
    if (threadBinding !== undefined) {
      if (
        threadBinding.codexHostId === stored.codexHostId
        && threadBinding.threadId === stored.threadId
      ) return;
      throw new ApiError(409, "BINDING_CONFLICT", "Issue is bound to another Codex host", {
        codexHostId: stored.codexHostId,
      });
    }
    if (threadId === stored.threadId) return;
    throw new ApiError(409, "BINDING_CONFLICT", "Issue is bound to another Codex host", {
      codexHostId: stored.codexHostId,
    });
  }

  #requireVersion(task, expectedVersion) {
    if (task.version !== expectedVersion) {
      throw new ApiError(409, "VERSION_CONFLICT", "Task was changed by another client", {
        expectedVersion,
        actualVersion: task.version,
      });
    }
  }

  #requireCommentVersion(comment, expectedVersion) {
    if (comment.version !== expectedVersion) {
      throw new ApiError(409, "VERSION_CONFLICT", "Comment was changed by another client", {
        expectedVersion,
        actualVersion: comment.version,
      });
    }
  }

  async #throwMissingOrConflict(id, expectedVersion) {
    const task = await this.getTask(id);
    if (!task) {
      throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
    }
    throw new ApiError(409, "VERSION_CONFLICT", "Task was changed by another client", {
      expectedVersion,
      actualVersion: task.version,
    });
  }

  async #throwMissingCommentOrConflict(id, expectedVersion) {
    const comment = await this.getComment(id);
    if (!comment) {
      throw new ApiError(404, "COMMENT_NOT_FOUND", `Comment '${id}' does not exist`);
    }
    throw new ApiError(409, "VERSION_CONFLICT", "Comment was changed by another client", {
      expectedVersion,
      actualVersion: comment.version,
    });
  }
}
