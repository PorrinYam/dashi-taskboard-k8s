#!/usr/bin/env node
// Device credential administration for PostgreSQL-backed boards.
//
// Operates directly on the authoritative store through DATABASE_URL, so it works both
// against a local development database and inside the cluster, e.g.:
//   kubectl -n taskboard exec deploy/taskboard -- node scripts/device-admin.mjs list
//
// Usage:
//   DATABASE_URL=postgres://... node scripts/device-admin.mjs issue <deviceId> <displayName>
//   DATABASE_URL=postgres://... node scripts/device-admin.mjs list
//   DATABASE_URL=postgres://... node scripts/device-admin.mjs revoke <deviceId>
import { PgTaskboardDatabase } from "../server/pg-database.mjs";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(2);
}

const [command, ...operands] = process.argv.slice(2);
const database = new PgTaskboardDatabase(databaseUrl);
try {
  // Bootstraps the schema so every command works against a fresh database too.
  await database.ensureSchema();
  if (command === "issue") {
    const [id, name] = operands;
    if (!id || !name) throw new Error("usage: device-admin.mjs issue <deviceId> <displayName>");
    const device = await database.createDevice({ id, name });
    // The token is displayed once; only its SHA-256 hash is persisted.
    console.log(JSON.stringify({ device: { id: device.id, name: device.name }, token: device.token }));
  } else if (command === "list") {
    console.log(JSON.stringify({ devices: await database.listDevices() }, null, 2));
  } else if (command === "revoke") {
    const [id] = operands;
    if (!id) throw new Error("usage: device-admin.mjs revoke <deviceId>");
    await database.revokeDevice(id);
    console.log(JSON.stringify({ revoked: id }));
  } else {
    throw new Error("expected command: issue | list | revoke");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await database.close();
}
