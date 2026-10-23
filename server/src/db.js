import { MongoClient } from 'mongodb';
import { config, MISSING_MONGO_URI } from './config.js';
import { keepsAgent, LEGACY_AGENT } from './ingest.js';

/** @type {MongoClient} */
let client;

/** @type {import('mongodb').Db} */
export let db;

let ready = false;
let stopping = false;

/** Whether the database is connected and its indexes exist. */
export const isReady = () => ready;

/** Connection options shared by the server and scripts: fail fast instead of hanging 30 s when the DB is down. */
export const clientOptions = {
  appName: 'cc-usage-server',
  serverSelectionTimeoutMS: 10_000,
  connectTimeoutMS: 10_000,
};

async function dropIndexIfExists(collection, name) {
  try {
    await db.collection(collection).dropIndex(name);
  } catch (error) {
    if (error.codeName !== 'IndexNotFound' && error.codeName !== 'NamespaceNotFound') throw error;
  }
}

/**
 * Deletes other agents' usage of users outside CODEX_EMAILS (stored before that rule, or before they were removed
 * from the list): their daily days, and the agent entries of their reports, whose periodTotal becomes Claude Code's.
 */
async function removeUnkeptAgents() {
  const otherAgent = { $elemMatch: { agent: { $ne: LEGACY_AGENT } } };
  const [dailyUsers, reportUsers] = await Promise.all([
    db.collection('daily').distinct('user', { agent: { $ne: LEGACY_AGENT } }),
    db.collection('reports').distinct('user', { agents: otherAgent }),
  ]);
  const users = [...new Set([...dailyUsers, ...reportUsers])].filter((user) => !keepsAgent(user, 'codex'));
  if (!users.length) return;
  const [days, reports] = await Promise.all([
    db.collection('daily').deleteMany({ user: { $in: users }, agent: { $ne: LEGACY_AGENT } }),
    db.collection('reports').updateMany({ user: { $in: users }, agents: otherAgent }, [
      { $set: { agents: { $filter: { input: '$agents', cond: { $eq: ['$$this.agent', LEGACY_AGENT] } } } } },
      { $set: { periodTotal: { $ifNull: [{ $arrayElemAt: ['$agents.periodTotal', 0] }, '$periodTotal'] } } },
    ]),
  ]);
  console.log(`[db] removed other agents' usage of ${users.join(', ')}: ${days.deletedCount} days, ${reports.modifiedCount} reports`);
}

async function connectOnce() {
  client = new MongoClient(config.mongoUri, clientOptions);
  try {
    await client.connect();
    db = client.db(config.mongoDb);
    // Days stored before reports carried agents are Claude Code usage. Runs before anything is accepted (the
    // routes wait for isReady), so every day has an agent by the time reports from other agents arrive.
    await db.collection('daily').updateMany({ agent: { $exists: false } }, { $set: { agent: LEGACY_AGENT } });
    await removeUnkeptAgents();
    await Promise.all([
      // One document per user/machine/agent/day (machine = machineId + hostname): re-submitting an overlapping
      // window replaces the day, while reports from a user's other machines and agents are kept and summed.
      db.collection('daily').createIndex({ user: 1, machineId: 1, hostname: 1, agent: 1, date: 1 }, { unique: true }),
      db.collection('daily').createIndex({ date: 1 }),
      // Lets the all-time ranking in listUsers() read the index instead of every document.
      db.collection('daily').createIndex({ user: 1, totalTokens: 1 }),
      db.collection('users').createIndex({ user: 1 }, { unique: true }),
      // Full history: every submitted report is kept as received.
      db.collection('reports').createIndex({ receivedAt: -1 }),
      db.collection('reports').createIndex({ user: 1, machineId: 1, hostname: 1, receivedAt: -1 }),
      // /api/reports filtered by user or machine, newest first.
      db.collection('reports').createIndex({ user: 1, receivedAt: -1 }),
      db.collection('reports').createIndex({ machineId: 1, receivedAt: -1 }),
      // Export: reports whose [since, until] overlaps the requested range.
      db.collection('reports').createIndex({ until: 1, since: 1 }),
    ]);
    // Before the hostname, and then the agent, joined the key. An old unique index would reject a second hostname
    // that shares a machineId, or a second agent on the same day, so they must go.
    await Promise.all([
      dropIndexIfExists('daily', 'user_1_machineId_1_date_1'),
      dropIndexIfExists('daily', 'user_1_machineId_1_hostname_1_date_1'),
      dropIndexIfExists('reports', 'user_1_machineId_1_receivedAt_-1'),
    ]);
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}

/**
 * Connects in the background and keeps retrying (2 s, doubling up to 30 s) until it succeeds, so the HTTP server
 * and its health check are up even while the database is unreachable or still starting.
 */
export async function connectWithRetry() {
  if (!config.mongoUri) {
    console.error(`[db] ${MISSING_MONGO_URI}`);
    return;
  }
  for (let attempt = 1, delay = 2_000; !stopping; attempt += 1, delay = Math.min(delay * 2, 30_000)) {
    try {
      await connectOnce();
      ready = true;
      console.log(`[db] connected to ${config.mongoDb}`);
      return;
    } catch (error) {
      console.error(`[db] connection attempt ${attempt} failed: ${error.message}; retrying in ${delay / 1000}s`);
      await new Promise((resolve) => setTimeout(resolve, delay).unref());
    }
  }
}

export async function ping() {
  await db.command({ ping: 1 });
}

export function close() {
  stopping = true;
  return client?.close();
}
