import pg from "pg";

const NOTIFY_CHANNEL = "taskboard_events";
const NOTIFY_RESTART_DELAY_MS = 1_000;
const CATCH_UP_POLL_INTERVAL_MS = 2_000;
// Event rows only exist so late-notifying replicas can catch up; pruning keeps the table bounded.
const PRUNE_INTERVAL_MS = 10 * 60 * 1_000;
const EVENT_RETENTION_INTERVAL = "24 hours";

// Cross-replica fanout over PostgreSQL LISTEN/NOTIFY.
//
// Publishers insert each change envelope into taskboard_events and NOTIFY the channel with
// nothing but the sequence number. Every replica (including the writer) tails new sequences
// and hands payloads to onEvent, which fans them out to that replica's own connected clients.
export class PgEventBus {
  constructor(pool, { onEvent } = {}) {
    this.pool = pool;
    this.onEvent = onEvent ?? (() => {});
    this.lastSeq = 0;
    this.client = null;
    this.reconnectTimer = null;
    this.catchUpTimer = null;
    this.pruneTimer = null;
    this.connecting = null;
    this.closed = false;
  }

  async start() {
    if (this.closed) return;
    await this.#ensureConnected();
    await this.#catchUp();
    // Backstop poll: recovers events whose NOTIFY was lost to a connection blip.
    this.catchUpTimer = setInterval(() => {
      void this.#catchUp();
    }, CATCH_UP_POLL_INTERVAL_MS);
    this.catchUpTimer.unref();
    this.pruneTimer = setInterval(() => {
      void this.#prune();
    }, PRUNE_INTERVAL_MS);
    this.pruneTimer.unref();
  }

  async publish(payload) {
    const result = await this.pool.query(
      "INSERT INTO taskboard_events (payload) VALUES ($1::jsonb) RETURNING seq",
      [JSON.stringify(payload)],
    );
    const seq = Number(result.rows[0].seq);
    // Wake every listening replica promptly; delivery itself goes through #catchUp below
    // and each replica's own notify handling, so sequencing stays authoritative in the table.
    await this.pool.query("SELECT pg_notify($1, $2)", [NOTIFY_CHANNEL, String(seq)]);
    return seq;
  }

  async close() {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.catchUpTimer) clearInterval(this.catchUpTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    await this.#teardownClient();
  }

  async #ensureConnected() {
    if (this.client) return;
    if (!this.connecting) {
      this.connecting = (async () => {
        const client = new pg.Client({ connectionString: this.pool.options.connectionString });
        client.on("notification", (notification) => {
          void this.#catchUp();
        });
        client.on("error", () => {
          void this.#handleConnectionLoss();
        });
        client.on("end", () => {
          void this.#handleConnectionLoss();
        });
        await client.connect();
        await client.query(`LISTEN ${NOTIFY_CHANNEL}`);
        this.client = client;
      })().finally(() => {
        this.connecting = null;
      });
    }
    await this.connecting;
  }

  async #handleConnectionLoss() {
    await this.#teardownClient();
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.#ensureConnected()
        .then(() => this.#catchUp())
        .catch(() => {
          // Retry via timer until the database comes back.
          this.#handleConnectionLoss().catch(() => {});
        });
    }, NOTIFY_RESTART_DELAY_MS);
    this.reconnectTimer.unref();
  }

  async #teardownClient() {
    const client = this.client;
    this.client = null;
    if (!client) return;
    client.removeAllListeners();
    try {
      await client.end();
    } catch {}
  }

  async #catchUp() {
    if (this.closed || !this.client) return;
    try {
      for (;;) {
        const rows = (await this.pool.query(
          "SELECT seq, payload FROM taskboard_events WHERE seq > $1 ORDER BY seq LIMIT 200",
          [this.lastSeq],
        )).rows;
        if (rows.length === 0) return;
        for (const row of rows) {
          this.lastSeq = Math.max(this.lastSeq, Number(row.seq));
          let payload = row.payload;
          if (typeof payload === "string") payload = JSON.parse(payload);
          this.onEvent(payload, Number(row.seq));
        }
      }
    } catch (error) {
      console.error("taskboard event catch-up failed", error);
    }
  }

  async #prune() {
    if (this.closed) return;
    try {
      await this.pool.query(
        `DELETE FROM taskboard_events WHERE created_at < now() - interval '${EVENT_RETENTION_INTERVAL}'`,
      );
    } catch {}
  }
}
