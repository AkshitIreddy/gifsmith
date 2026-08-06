/**
 * The MCP server, spoken to over the real protocol.
 *
 * The SDK is an OPTIONAL PEER dependency, which is two promises pulling in
 * opposite directions, and both have to be tested or the shape drifts back:
 *
 *   1. Installing gifsmith must NOT install the SDK. That is packaging.test.mjs,
 *      which checks the tarball rather than the intention.
 *   2. `gifsmith-mcp` must still work for anyone who DOES install it. That is
 *      this file — the half that a dependency change can quietly break while
 *      every other test stays green, because nothing else in gifsmith imports
 *      the SDK at all.
 *
 * It goes through stdio JSON-RPC rather than importing anything, so it covers
 * the lazy string-specifier `import()`s, the transport wiring and the tool
 * registration together — which is precisely the path that has no other cover.
 *
 * Without the SDK present these tests SKIP, because `npm test` has to pass for
 * someone who has not installed it. CI is where "skipped" is not good enough:
 * set GIFSMITH_REQUIRE_MCP=1 and a skip becomes a failure.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverPath = path.join(root, 'dist', 'mcp', 'server.js');

const EXPECTED_TOOLS = [
  'gifsmith_contact_sheet',
  'gifsmith_dry_run',
  'gifsmith_probe',
  'gifsmith_render',
  'gifsmith_snapshot',
];

function sdkInstalled() {
  try {
    createRequire(import.meta.url).resolve('@modelcontextprotocol/sdk/package.json');
    return true;
  } catch {
    return false;
  }
}

const haveSdk = sdkInstalled();
const required = process.env.GIFSMITH_REQUIRE_MCP === '1';

if (!haveSdk && required) {
  throw new Error(
    'GIFSMITH_REQUIRE_MCP=1 but @modelcontextprotocol/sdk is not installed. ' +
      'It is a devDependency of this repo (and an optional peer for consumers) — run `npm ci`.',
  );
}

const skip = haveSdk ? false : 'requires @modelcontextprotocol/sdk (optional peer)';

/** A live server process plus the newline-delimited JSON-RPC it speaks. */
class Client {
  constructor() {
    this.child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.stderr = '';
    this.replies = new Map();
    this.waiters = new Map();
    this.buf = '';
    this.child.stderr.on('data', (d) => (this.stderr += d));
    this.child.stdout.on('data', (d) => this.#onData(String(d)));
  }

  #onData(chunk) {
    this.buf += chunk;
    for (let nl = this.buf.indexOf('\n'); nl >= 0; nl = this.buf.indexOf('\n')) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // not ours; the transport tolerates noise and so do we
      }
      if (msg.id === undefined) continue; // a notification
      this.replies.set(msg.id, msg);
      this.waiters.get(msg.id)?.(msg);
    }
  }

  notify(method, params = {}) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  request(id, method, params = {}) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    if (this.replies.has(id)) return Promise.resolve(this.replies.get(id));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no reply to ${method} within 15s\nserver stderr:\n${this.stderr}`)),
        15_000,
      );
      this.waiters.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
  }

  close() {
    this.child.stdin.end();
    this.child.kill();
  }
}

let client;

before(() => {
  if (!haveSdk) return;
  client = new Client();
});

after(() => client?.close());

test('the server completes an MCP initialize handshake over stdio', { skip }, async () => {
  const res = await client.request(1, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'gifsmith-tests', version: '0' },
  });
  assert.equal(res.error, undefined, `initialize failed: ${JSON.stringify(res.error)}`);
  assert.equal(res.result?.serverInfo?.name, 'gifsmith');
  // It reported 0.1.0 while the package was 0.3.0 — a literal that was true once.
  assert.equal(
    res.result?.serverInfo?.version,
    JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version,
  );
  assert.ok(res.result?.capabilities?.tools, 'the server should advertise tool support');
  client.notify('notifications/initialized');
});

test('it lists exactly the five gifsmith tools', { skip }, async () => {
  const res = await client.request(2, 'tools/list');
  assert.equal(res.error, undefined, `tools/list failed: ${JSON.stringify(res.error)}`);
  const tools = res.result?.tools ?? [];
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    EXPECTED_TOOLS,
  );
  for (const t of tools) {
    assert.equal(t.inputSchema?.type, 'object', `${t.name}: no object input schema`);
    assert.ok(t.description?.length > 20, `${t.name}: no usable description`);
  }
});

test('an unknown tool is an error result, not a dead server', { skip }, async () => {
  const res = await client.request(3, 'tools/call', { name: 'gifsmith_nope', arguments: {} });
  assert.equal(res.error, undefined, 'the dispatch throw should be caught and reported');
  assert.equal(res.result?.isError, true);
  assert.match(res.result?.content?.[0]?.text ?? '', /unknown tool/);
});

test('and it is still answering afterwards', { skip }, async () => {
  const res = await client.request(4, 'tools/list');
  assert.equal(res.error, undefined);
  assert.equal((res.result?.tools ?? []).length, EXPECTED_TOOLS.length);
});

/**
 * The `inputSchema` each tool advertises, actually enforced.
 *
 * It was advertised and not checked, which is the same defect as everything else
 * in this changeset one more layer out: a client is trusted to honour a schema
 * it was merely shown. `gifsmith_render` with `{}` reached `path.resolve
 * (undefined)` and answered `error: The "paths[0]" argument must be of type
 * string. Received undefined` — no tool name, no argument name, and nothing
 * saying gifsmith was speaking, to a caller that is usually a model.
 *
 * Derived from `tools/list` rather than from a list written here, so a tool
 * added later is covered by this test on the day it is added.
 */
test('a required argument that is missing is named, per tool, from the advertised schema', { skip }, async () => {
  const { result } = await client.request(10, 'tools/list');
  let id = 11;
  for (const tool of result.tools) {
    for (const key of tool.inputSchema.required ?? []) {
      // Everything the schema requires except this one, so the only thing wrong
      // is the field under test.
      const args = {};
      for (const other of tool.inputSchema.required ?? []) {
        if (other !== key) args[other] = tool.inputSchema.properties[other]?.type === 'number' ? 1 : 'x';
      }
      const res = await client.request(id++, 'tools/call', { name: tool.name, arguments: args });
      assert.equal(res.error, undefined, `${tool.name} without ${key}: the server should answer, not fail`);
      const said = res.result?.content?.[0]?.text ?? '';
      assert.equal(res.result?.isError, true, `${tool.name} without ${key}: not reported as an error — ${said}`);
      assert.match(said, new RegExp(`${tool.name} needs \`${key}\``), `${tool.name} without ${key}: ${said}`);
      assert.doesNotMatch(said, /paths\[0\]/, `${tool.name} without ${key}: leaked node's own message`);
    }
  }
});

test('an argument of the wrong type is named too, rather than failing somewhere else', { skip }, async () => {
  const cases = [
    ['gifsmith_render', { configPath: 42 }, /`configPath` must be a string; got 42/],
    ['gifsmith_probe', { url: ['http://x'] }, /`url` must be a string/],
    ['gifsmith_snapshot', { configPath: 'x.mjs', atSeconds: 'two' }, /`atSeconds` must be a number; got "two"/],
    ['gifsmith_contact_sheet', { configPath: 'x.mjs', n: 'six' }, /`n` must be a number; got "six"/],
  ];
  let id = 40;
  for (const [tool, args, message] of cases) {
    const res = await client.request(id++, 'tools/call', { name: tool, arguments: args });
    assert.equal(res.error, undefined);
    assert.equal(res.result?.isError, true, `${tool} ${JSON.stringify(args)} was accepted`);
    assert.match(res.result?.content?.[0]?.text ?? '', message);
  }
});

test('a config module the agent cannot load is named, with the file in the message', { skip }, async () => {
  // The MCP half of the CLI's third round. This copy had no guards at all, and
  // its dispatcher prints `e.message` with no stack — so a syntax error read
  // `error: Unexpected identifier 'out'` and named nothing whatsoever.
  const missing = path.join(root, 'no-such-scene-anywhere.mjs');
  const res = await client.request(60, 'tools/call', {
    name: 'gifsmith_dry_run',
    arguments: { configPath: missing },
  });
  assert.equal(res.result?.isError, true);
  const said = res.result?.content?.[0]?.text ?? '';
  assert.match(said, /cannot open config/);
  assert.ok(said.includes('no-such-scene-anywhere.mjs'), `did not name the file: ${said}`);
});
