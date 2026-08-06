/**
 * What actually ships.
 *
 * Every bug this file guards against was invisible from inside the repo: the
 * build was clean, the tests were green, the API worked, and the tarball was
 * still wrong. The worst of them shipped an HTTP server stack to everyone who
 * installed a GIF library, because `optionalDependencies` reads like "opt in"
 * and means "install it, but tolerate a failure" — npm installs those by
 * DEFAULT. A clean project that asked for gifsmith got 171 packages and 49.5 MB.
 *
 * So the packaging rules are assertions now, checked against `npm pack` itself
 * rather than against what package.json appears to say.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

/**
 * `npm pack --dry-run --json` — the real file list, no tarball written.
 *
 * Memoized: nothing in this file changes the working tree, and `npm pack` costs
 * a second or two per call on Windows.
 */
let packed;
function packedFiles() {
  return (packed ??= runPack());
}

/**
 * First complete top-level JSON value in `npm pack --json` stdout.
 *
 * Newer npm appends `npm notice` lines after the JSON, and those notices can
 * contain `]` (integrity hashes use `[...]`). `lastIndexOf(']')` then grabs a
 * stray bracket and leaves trailing text that `JSON.parse` rejects.
 */
export function firstJsonValue(out) {
  const start = out.search(/[[{]/);
  if (start < 0) throw new Error('npm pack --json returned no JSON');
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < out.length; i++) {
    const c = out[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      if (--depth === 0) return out.slice(start, i + 1);
    }
  }
  throw new Error('npm pack --json returned incomplete JSON');
}

/** npm < 12: `[{ files, … }]`; npm ≥ 12: `{ " ": { files, … } }`. */
function packReport(out) {
  const parsed = JSON.parse(firstJsonValue(out));
  const report = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  if (!report || !Array.isArray(report.files)) {
    throw new Error(`unexpected npm pack --json shape: ${JSON.stringify(parsed).slice(0, 300)}`);
  }
  return report;
}

function runPack() {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const out = execFileSync(npm, ['pack', '--dry-run', '--json'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: process.platform === 'win32',
  });
  return packReport(out);
}

test('firstJsonValue ignores npm notice lines after the pack report', () => {
  const array = '[{"name":"gifsmith","files":[{"path":"dist/index.js"}]}]';
  const object = '{"gifsmith-0.3.0.tgz":{"name":"gifsmith","files":[{"path":"dist/index.js"}]}}';
  const noisy = `${array}\nnpm notice\nnpm notice integrity: sha512-abc[...]xyz==\nnpm notice total files: 1\n`;
  assert.deepEqual(JSON.parse(firstJsonValue(noisy)), JSON.parse(array));
  assert.deepEqual(
    JSON.parse(firstJsonValue(`noise before\n${array}\nnpm notice ] stray`)),
    JSON.parse(array),
  );
  assert.equal(packReport(object).files.length, 1);
});

test('the MCP SDK is an optional peer, never something npm installs by default', () => {
  const name = '@modelcontextprotocol/sdk';

  assert.equal(
    pkg.dependencies?.[name],
    undefined,
    'a hard dependency would install express/hono/cors for every consumer',
  );
  assert.equal(
    pkg.optionalDependencies?.[name],
    undefined,
    'optionalDependencies are INSTALLED BY DEFAULT — "optional" only means ' +
      '"tolerate an install failure". This is the exact regression to prevent.',
  );
  assert.ok(pkg.peerDependencies?.[name], 'the SDK should still be declared, as a peer');
  assert.equal(
    pkg.peerDependenciesMeta?.[name]?.optional,
    true,
    'without optional:true, npm 7+ auto-installs the peer and nothing has changed',
  );
});

test('nothing but puppeteer-core is installed for a plain consumer', () => {
  assert.deepEqual(
    Object.keys(pkg.dependencies ?? {}),
    ['puppeteer-core'],
    'the runtime dependency list is the whole install cost; keep it deliberate',
  );
});

test('the tarball ships no source maps', () => {
  const maps = packedFiles().files.filter((f) => f.path.endsWith('.map'));
  assert.deepEqual(
    maps.map((f) => f.path),
    [],
    'maps list sources: ["../src/*.ts"] with no sourcesContent, and src/ is not ' +
      'shipped — so every one of them resolves to nothing. See .npmignore.',
  );
});

/**
 * The CHANGELOG quotes the packed-entry count, so the count has to be real.
 *
 * "156 packed entries → 82" was true when it was written and false by the end of
 * the same changeset: three new modules are six new entries (.js + .d.ts each),
 * and nothing said so. It is a small lie and it is the kind this file exists to
 * stop — a number in a release note is read as a measurement, and a measurement
 * nobody re-takes is just a claim.
 *
 * Only the "after" number is checked. The one before the arrow describes a
 * tarball that no longer exists and is history, which is allowed.
 */
test('the packed-entry count in the CHANGELOG is the real one', () => {
  const changelog = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const claim = /(\d+)\s+packed\s+entries\s*(?:→|->)\s*(\d+)/.exec(changelog.replace(/\s*\n\s*/g, ' '));
  assert.ok(claim, 'the CHANGELOG no longer states a packed-entry count — delete this test with it');
  assert.equal(
    Number(claim[2]),
    packedFiles().files.length,
    `the CHANGELOG says the tarball has ${claim[2]} entries; npm pack says ${packedFiles().files.length}`,
  );
});

test('no shipped file points at a source map that is not in the package', () => {
  // The other half of "stop shipping dead maps", and the half that leaves no
  // trace. Excluding `*.map` from `files` emptied the tarball of maps and left
  // all 78 `//# sourceMappingURL=…` comments in the shipped .js and .d.ts,
  // each naming a file that is no longer there. Node ignores a dangling map
  // silently — which is why this shipped — but bundlers and source-map-loader
  // warn once per file, and an editor following a declaration map finds
  // nothing.
  //
  // Fixed at the source rather than by filtering: `tsconfig.json` (the build
  // that ships) emits no maps at all, so there is no comment to strip and no
  // step anyone can forget. `tsconfig.dev.json` keeps them for local work.
  const offenders = packedFiles()
    .files.map((f) => f.path)
    .filter((p) => /\.(js|mjs|cjs|ts)$/.test(p))
    .filter((p) => readFileSync(path.join(root, p), 'utf8').includes('sourceMappingURL'));

  assert.deepEqual(offenders, [], 'these ship a sourceMappingURL comment with no map behind it');
});

test('the shipping build emits no maps, and local development keeps them', () => {
  const ship = JSON.parse(readFileSync(path.join(root, 'tsconfig.json'), 'utf8'));
  assert.equal(ship.compilerOptions.sourceMap, false, 'the shipped build must not emit .js.map');
  assert.equal(ship.compilerOptions.declarationMap, false, 'nor .d.ts.map');
  assert.match(pkg.scripts.build, /tsc -p tsconfig\.json/, '`build` is the shipping build');

  // The other side of the trade: a repo that debugs its own dist/ is worth
  // keeping, so the maps did not simply go away.
  const dev = JSON.parse(readFileSync(path.join(root, 'tsconfig.dev.json'), 'utf8'));
  assert.equal(dev.extends, './tsconfig.json', 'the dev config must not fork the compiler options');
  assert.equal(dev.compilerOptions.sourceMap, true);
  assert.equal(dev.compilerOptions.declarationMap, true);
  assert.match(pkg.scripts['build:dev'], /tsconfig\.dev\.json/);
  assert.match(pkg.scripts.watch, /tsconfig\.dev\.json/, 'the watch loop is where maps are actually used');
});

/**
 * The version being prepared, described in the past tense as one that already
 * went out — a claim that is false by construction and ships to the npm page.
 *
 * The README said "0.3.0's headline addition was this test suite, and the
 * release pipeline did not run it once" and `release.yml` said "This workflow
 * shipped 0.3.0 … without running it once", while npm's latest was 0.2.3 and no
 * v0.3.0 tag existed anywhere. Both read as a post-mortem of a shipped release;
 * both were about the working tree they were written in. The README is in the
 * tarball, so the first one was going out on the package page as a statement
 * about a release that does not exist.
 *
 * The invariant is small and it holds for every release, not just this one: the
 * version in package.json is the one being PREPARED, so nothing may describe it
 * as already shipped. It stops applying by itself the moment the version bumps,
 * which is exactly when talking about the old one in the past tense becomes
 * true. (The CHANGELOG's `## [0.3.0]` heading and its tag link are fine — a
 * heading names a release, it does not claim one happened.)
 */
/**
 * ...and the guard written to catch it then failed to, twice over, which is why
 * it is now three separate mechanisms instead of one regex.
 *
 * The claim came back in `.github/workflows/ci.yml` — a file this list already
 * named — reading "0.3's headline addition was a test suite, and for the whole
 * of that release nothing ran it". Three holes let it through:
 *
 *   1. THE VERSION. `mentionsVersion` was built from the full `0.3.0`, and the
 *      sentence says `0.3`. A version has several spellings and the guard has to
 *      know all of them: `0.3`, `0.3.0`, `v0.3.0`, `0.3's`.
 *   2. THE PHRASING. The claim list was a handful of exact phrases, so any other
 *      way of saying the same thing walked past. "For the whole of that release"
 *      is a completed period; "0.3's addition WAS" is the version in the past
 *      tense. Neither contains the word "shipped".
 *   3. THE LINE BREAK. Sentences were split on every `\n`, so a wrapped
 *      paragraph became fragments — a version at the end of one line and the
 *      claim at the start of the next could never be seen together. Text is
 *      joined into blocks first now, and split into sentences after.
 *
 * The detector is a heuristic over English and says so. What is NOT a heuristic
 * is the file list: every file that can carry the claim is derived (both docs,
 * every workflow, every source file), so a new workflow or a new module is
 * covered the day it is added rather than the day someone remembers.
 */

/** Any spelling of the version, and not a percentage: `+0.3% bytes` is not a release. */
function versionPattern(version) {
  const [major, minor] = version.split('.');
  return new RegExp(`(^|[^\\w.])v?${major}\\.${minor}(\\.\\d+)?(?![\\d.%])`, 'i');
}

/** A release event, in the past tense. Order-independent — it may precede the version. */
const RELEASE_PAST =
  /\b(shipped|published|released|tagged|went out|was out|was cut|has landed|already (out|released|published|shipped))\b/i;

/** A completed period: "for the whole of that release", "during this release". */
const COMPLETED_PERIOD = /\b(for|during|throughout|across|in|after) (the whole of |the rest of |most of )?(that|this|the) release\b/i;

/**
 * The version as the SUBJECT of a past-tense clause: "0.3's addition was …",
 * "in 0.3.0 the suite never ran".
 *
 * Order matters here and only here: "the package was 0.3.0" is a statement about
 * a literal in the source, not about a release, and it reads the other way round.
 */
const PAST_VERBS = /\b(was|were|had|did|ran|went|came|shipped|published|released|landed)\b/i;

/** Prose blocks: markdown paragraphs and comment blocks, with the markers off. */
function sentences(text) {
  const out = [];
  let block = [];
  const flush = () => {
    if (!block.length) return;
    const joined = block.join(' ').replace(/\s+/g, ' ').trim();
    if (joined) out.push(...joined.split(/(?<=[.!?])\s+/));
    block = [];
  };
  for (const raw of text.split('\n')) {
    // Strip a comment marker so a YAML/TS comment block reads as prose.
    const line = raw.replace(/^\s*(#+|\/\/+|\*|<!--)\s?/, '').replace(/-->\s*$/, '').trim();
    if (!line) flush();
    else block.push(line);
  }
  flush();
  return out;
}

/**
 * The check itself, as a pure function of (version, files) so it can be run
 * against the real tree AND against a mutated copy of it — see the test below
 * that proves every covered file is actually covered.
 */
export function shippingClaims(version, files) {
  const mentionsVersion = versionPattern(version);
  const offenders = [];
  for (const { path: rel, text } of files) {
    for (const sentence of sentences(text)) {
      const hit = mentionsVersion.exec(sentence);
      if (!hit) continue;
      const after = sentence.slice(hit.index + hit[0].length);
      if (RELEASE_PAST.test(sentence) || COMPLETED_PERIOD.test(sentence) || PAST_VERBS.test(after)) {
        offenders.push(`${rel}: ${sentence.trim()}`);
      }
    }
  }
  return offenders;
}

/**
 * Every file that can carry the claim, derived rather than listed.
 *
 * The README and CHANGELOG ship in the tarball; the workflows do not, and
 * carried the identical false claim twice, so they are held to the same rule. A
 * source comment is the third place it can hide and the least likely to be
 * re-read. `test/` is deliberately absent: this file has to hold the offending
 * sentences as fixtures, and a guard that flags its own test data is a guard
 * nobody keeps.
 */
function claimBearingFiles() {
  const files = ['README.md', 'CHANGELOG.md'];
  const workflows = path.join(root, '.github', 'workflows');
  for (const f of readdirSync(workflows)) {
    if (/\.ya?ml$/.test(f)) files.push(`.github/workflows/${f}`);
  }
  const walk = (dir) => {
    for (const e of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith('.ts')) files.push(rel);
    }
  };
  walk('src');
  return files.map((rel) => ({ path: rel, text: readFileSync(path.join(root, rel), 'utf8') }));
}

test('nothing claims the version being prepared has already shipped', () => {
  const offenders = shippingClaims(pkg.version, claimBearingFiles());
  assert.deepEqual(
    offenders,
    [],
    `these describe ${pkg.version} — the release being prepared — as one that already went out`,
  );
});

test('the guard covers every file that can carry the claim, proved one file at a time', () => {
  // The hole that let it back in was not the rule, it was the reach: `ci.yml`
  // was on the list and its version spelling was not. So coverage is asserted
  // per file, with the actual sentence that got through as the first fixture.
  const claims = [
    "0.3's headline addition was a test suite, and for the whole of that release nothing ran it.",
    '0.3.0 shipped without ever running its own test suite.',
    'This workflow published 0.3.0 without running it once.',
    'In 0.3.0 the suite never ran.',
    'Version 0.3.0 went out with a red suite behind it.',
  ];
  const files = claimBearingFiles();
  assert.ok(files.length > 10, 'the file list should be derived, not a handful');
  assert.ok(
    files.some((f) => f.path === '.github/workflows/ci.yml'),
    'ci.yml is where the claim came back',
  );

  for (const file of files) {
    for (const claim of claims) {
      // Mutate a COPY of the real file: appended as its own block, exactly as a
      // new paragraph or comment would arrive.
      const mutated = files.map((f) =>
        f.path === file.path ? { ...f, text: `${f.text}\n\n${commentFor(f.path)}${claim}\n` } : f,
      );
      const offenders = shippingClaims('0.3.0', mutated);
      assert.ok(
        offenders.some((o) => o.startsWith(`${file.path}: `)),
        `mutating ${file.path} with "${claim}" was not caught — the guard does not cover it`,
      );
    }
  }
});

/** How a claim would actually appear in that file: prose, YAML comment, or TS comment. */
function commentFor(rel) {
  if (rel.endsWith('.md')) return '';
  if (rel.endsWith('.ts')) return '// ';
  return '# ';
}

test('the guard does not fire on the honest sentences already in the tree', () => {
  // A guard with false positives gets deleted, so the discriminations it makes
  // are pinned: a percentage is not a version, a heading is not a claim, and
  // "the package was 0.3.0" describes a literal in the source rather than a
  // release that happened.
  const fine = [
    '**+0.3% bytes for +4.7 dB.** If your demo is a user interface rather than video…',
    '## [0.3.0](https://github.com/AkshitIreddy/gifsmith/releases/tag/v0.3.0)',
    'The version an MCP client displays should be gifsmith\'s, not a literal that was right once — this said 0.1.0 while the package was 0.3.0.',
    'The suite is this release’s headline addition, and until this file existed nothing in the pipeline ran it.',
    '0.3.0 adds a second capture backend.',
    'Through most of 0.3.0’s development this tree packed at 130 KB.',
  ];
  for (const text of fine) {
    assert.deepEqual(
      shippingClaims('0.3.0', [{ path: 'sample', text }]),
      [],
      `false positive on: ${text}`,
    );
  }
});

test('the tarball ships no sources, examples or docs', () => {
  const strays = packedFiles()
    .files.map((f) => f.path)
    .filter((p) => /^(src|examples|docs)\//.test(p));
  assert.deepEqual(strays, [], 'docs/demo.gif alone is 3.4 MB');
});

test('every path the package.json points at is actually in the tarball', () => {
  const files = new Set(packedFiles().files.map((f) => f.path));
  const pointers = [
    pkg.main,
    pkg.types,
    ...Object.values(pkg.bin ?? {}),
    ...Object.values(pkg.exports ?? {}).flatMap((e) =>
      typeof e === 'string' ? [e] : Object.values(e),
    ),
  ].filter(Boolean);

  for (const p of pointers) {
    const rel = p.replace(/^\.\//, '');
    assert.ok(files.has(rel), `${p} is declared in package.json but not packed`);
  }
});
