import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, stat, rm, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createTokenStore } from "../src/token-store.js";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "xero-mcp-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "private", "tokens.json");
  return { path, store: createTokenStore(path) };
}

test("missing synthetic token file returns null", async (t) => {
  const { path, store } = await fixture(t);
  assert.equal(store.getTokenPath(), path);
  assert.equal(await store.loadTokens(), null);
});

test("malformed synthetic JSON reports its path", async (t) => {
  const { path, store } = await fixture(t);
  await mkdir(dirname(path));
  await writeFile(path, "{invalid");
  await assert.rejects(store.loadTokens(), (error) => error.message.includes(`Could not parse ${path}`));
});

test("token JSON round-trips actual bytes with 0700 directory and 0600 file", async (t) => {
  const { path, store } = await fixture(t);
  await mkdir(dirname(path), { mode: 0o755 });
  const value = { access_token: "synthetic-access", refresh_token: "synthetic-refresh", tenantId: "synthetic-tenant", expires_at: 1234 };
  await store.saveTokens(value);
  assert.equal(await readFile(path, "utf8"), `${JSON.stringify(value, null, 2)}\n`);
  assert.deepEqual(await store.loadTokens(), value);
  assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await store.saveTokens({ ...value, access_token: "rotated" });
  assert.equal((await store.loadTokens()).access_token, "rotated");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("parallel atomic saves leave one complete record and no temporary files", async (t) => {
  const { path, store } = await fixture(t);
  const records = Array.from({ length: 24 }, (_, writer) => ({ writer, access_token: `synthetic-${writer}`, payload: String(writer).repeat(10000) }));
  await Promise.all(records.map((record) => store.saveTokens(record)));
  const saved = await store.loadTokens();
  assert.deepEqual(saved, records[saved.writer]);
  assert.deepEqual(await readdir(dirname(path)), ["tokens.json"]);
  assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("pre-rename failure removes only its temporary file and preserves previous bytes", async (t) => {
  const { path, store } = await fixture(t);
  await store.saveTokens({ access_token: "synthetic-original" });
  const original = await readFile(path, "utf8");
  const unrelatedPath = `${path}.other-writer.tmp`;
  await writeFile(unrelatedPath, "other writer");
  const failure = new Error("synthetic rename failure");
  let attemptedPath;
  const failingStore = createTokenStore(path, { rename: async (source, destination) => {
    attemptedPath = source;
    assert.equal(dirname(source), dirname(path));
    assert.equal(destination, path);
    assert.deepEqual(JSON.parse(await readFile(source, "utf8")), { access_token: "synthetic-new" });
    throw failure;
  } });
  await assert.rejects(failingStore.saveTokens({ access_token: "synthetic-new" }), (error) => error === failure);
  assert.ok(attemptedPath);
  await assert.rejects(stat(attemptedPath), { code: "ENOENT" });
  assert.equal(await readFile(path, "utf8"), original);
  assert.equal(await readFile(unrelatedPath, "utf8"), "other writer");
  assert.deepEqual((await readdir(dirname(path))).sort(), ["tokens.json", "tokens.json.other-writer.tmp"]);
});

test("cleanup failure does not replace the original persistence error", async (t) => {
  const { path, store } = await fixture(t);
  await store.saveTokens({ access_token: "synthetic-original" });
  const failure = new Error("synthetic primary error");
  let cleanupCalls = 0;
  const failingStore = createTokenStore(path, {
    rename: async () => { throw failure; },
    remove: async (temporaryPath) => {
      cleanupCalls++;
      await rm(temporaryPath);
      throw new Error("synthetic cleanup failure");
    },
  });
  await assert.rejects(failingStore.saveTokens({ access_token: "synthetic-new" }), (error) => error === failure);
  assert.equal(cleanupCalls, 1);
  assert.deepEqual(await store.loadTokens(), { access_token: "synthetic-original" });
  assert.deepEqual(await readdir(dirname(path)), ["tokens.json"]);
});
