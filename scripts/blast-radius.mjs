// blast-radius.mjs -- Deterministic change impact radar (~0 token cost).
//
// Usage:
//   node scripts/blast-radius.mjs [options] [<git-range>]
//
// Options:
//   --files f1,f2,...  Explicit changed-file list (comma-separated, repo-relative paths).
//   --json             Emit machine-readable JSON (default: human-readable).
//   --depth <N>        Follow import graph N levels deep (default 1 = direct importers only).
//   --help             Show this help and exit.
//   --smoke            Run built-in self-test and exit.
//
// Examples:
//   node scripts/blast-radius.mjs                          # uncommitted changes
//   node scripts/blast-radius.mjs HEAD~1                   # last commit
//   node scripts/blast-radius.mjs dev...HEAD               # dev..HEAD range
//   node scripts/blast-radius.mjs --files apps/server/src/features/work-items/routes.ts
//   node scripts/blast-radius.mjs --json HEAD~1 > blast.json
//
// Output sections:
//   1. CHANGED FILES  -- the files in scope
//   2. IMPORT GRAPH   -- which files import the changed files (reverse graph, BFS)
//   3. SEAM SWEEP     -- exported symbols, HTTP route paths, event/channel keys
//                        + where each appears across the repo (stringly-typed consumers)
//   4. VERDICT        -- boolean shared-surface flag + reasons
//
// Shared-surface means the change touches an HTTP route, an exported type/function, a DB
// schema/migration file, or a public function signature -- forces full plan/review path.

import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.mjs', '.cjs', '.js', '.jsx']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'data', '.git', '.next', 'build', 'out']);

// -- Utilities ---------------------------------------------------------------

/** Convert any path to forward-slash form for display. */
function fwd(p) { return p.replace(/\\/g, '/'); }
/** Make a path relative to REPO and normalise to forward slashes. */
function repoRel(absPath) { return fwd(relative(REPO, absPath)); }

// -- File walker -------------------------------------------------------------

function walkSourceFiles(dir, acc = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkSourceFiles(full, acc);
    else if (entry.isFile() && SOURCE_EXTS.has(extname(entry.name))) acc.push(full);
  }
  return acc;
}

// -- Workspace package map ---------------------------------------------------

function buildWorkspacePackageMap() {
  const map = new Map();
  for (const wsDir of ['packages', 'apps']) {
    const dir = join(REPO, wsDir);
    if (!existsSync(dir)) continue;
    let pkgs;
    try { pkgs = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const pkg of pkgs) {
      if (!pkg.isDirectory()) continue;
      const pkgJsonPath = join(dir, pkg.name, 'package.json');
      if (!existsSync(pkgJsonPath)) continue;
      try {
        const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
        if (!pkgJson.name) continue;
        const mainRel = pkgJson.main ?? './src/index.ts';
        map.set(pkgJson.name, resolve(dir, pkg.name, mainRel));
      } catch { /* skip */ }
    }
  }
  return map;
}

// -- Import parser -----------------------------------------------------------

// Matches: import/export ... from 'path' or "path"
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^'"]*?['"]([^'"]+)['"]/g;

function parseImports(content, filePath, pkgMap) {
  const results = [];
  const seen = new Set();
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(content)) !== null) {
    const raw = m[1];
    if (seen.has(raw)) continue;
    seen.add(raw);

    let resolved = null;
    if (raw.startsWith('.')) {
      // Relative import -- repo uses explicit .ts extensions on imports.
      resolved = resolve(dirname(filePath), raw);
      if (!SOURCE_EXTS.has(extname(resolved))) {
        const candidate = resolved + '.ts';
        resolved = existsSync(candidate) ? candidate : null;
      }
    } else {
      // Workspace package: exact name or sub-path (@scope/pkg/sub -> @scope/pkg)
      const slashIdx = raw.startsWith('@')
        ? raw.indexOf('/', raw.indexOf('/') + 1)
        : raw.indexOf('/');
      const pkgName = slashIdx === -1 ? raw : raw.slice(0, slashIdx);
      if (pkgMap.has(pkgName)) resolved = pkgMap.get(pkgName);
    }
    results.push({ raw, resolved });
  }
  return results;
}

// -- Reverse import graph ----------------------------------------------------

function buildReverseGraph(allFiles, pkgMap, fileContents) {
  const reverse = new Map();
  for (const filePath of allFiles) {
    const content = fileContents.get(filePath);
    if (!content) continue;
    for (const { resolved } of parseImports(content, filePath, pkgMap)) {
      if (!resolved) continue;
      if (!reverse.has(resolved)) reverse.set(resolved, new Set());
      reverse.get(resolved).add(filePath);
    }
  }
  return reverse;
}

function findImporters(changedAbs, reverseGraph, depth) {
  const result = new Map();
  for (const target of changedAbs) {
    const direct = [], transitive = [];
    const visited = new Set([target]);
    let frontier = [target];
    for (let d = 1; d <= depth; d++) {
      const next = [];
      for (const node of frontier) {
        for (const imp of (reverseGraph.get(node) ?? new Set())) {
          if (visited.has(imp)) continue;
          visited.add(imp); next.push(imp);
          (d === 1 ? direct : transitive).push(imp);
        }
      }
      frontier = next;
      if (!frontier.length) break;
    }
    result.set(target, { direct, transitive });
  }
  return result;
}

// -- Seam extraction ---------------------------------------------------------

function extractExportedSymbols(content) {
  const syms = new Set();
  // export function/class/const/let/var/type/interface/enum/abstract class Name
  const declRe = /\bexport\s+(?:default\s+)?(?:abstract\s+)?(?:function\s*\*?\s*|class\s+|const\s+|let\s+|var\s+|type\s+|interface\s+|enum\s+)([A-Za-z_$][A-Za-z0-9_$]*)/g;
  let m;
  while ((m = declRe.exec(content)) !== null) syms.add(m[1]);
  // export { Name, Name as Alias }
  const namedRe = /\bexport\s*\{([^}]+)\}/g;
  while ((m = namedRe.exec(content)) !== null) {
    for (const part of m[1].split(',')) {
      const halves = part.trim().split(/\s+as\s+/);
      // If `X as Y`, the exported (consumer-visible) name is Y; otherwise it's the only token.
      const name = (halves.length > 1 ? halves[1] : halves[0]).trim();
      if (name && /^[A-Za-z_$]/.test(name)) syms.add(name);
    }
  }
  return [...syms].filter((s) => s.length > 1);
}

function extractRoutePaths(content) {
  const paths = new Set();
  // Match /api/ and /ws/ route strings in single/double-quoted literals
  const re = /['"](\/(api|ws)\/[^'"\s]*)['"]/g;
  let m;
  while ((m = re.exec(content)) !== null) paths.add(m[1]);
  return [...paths];
}

// Extensions that disqualify a matched token from being an event key.
const NON_EVENT_EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.sql', '.md']);

function extractEventKeys(content) {
  const keys = new Set();
  // dot- or colon-separated kebab-case identifiers: 'work-item.updated', 'agent-run.started'
  const re = /['"]([a-z][a-z0-9]*(?:-[a-z0-9]+)*[.:][a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:[.:][a-z][a-z0-9]*(?:-[a-z0-9]+)*)*)['"]/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const tok = m[1];
    if (tok.includes('/')) continue;            // path fragment, not an event key
    if (tok.startsWith('node:')) continue;      // Node.js built-in module specifier
    if (NON_EVENT_EXTS.has('.' + tok.split('.').pop())) continue; // filename with ext
    keys.add(tok);
  }
  return [...keys];
}

function grepRepo(needle, fileContents, excludeAbs) {
  const hits = [];
  for (const [absPath, content] of fileContents) {
    if (excludeAbs.has(absPath)) continue;
    if (content.includes(needle)) hits.push(repoRel(absPath));
  }
  return hits;
}

function sweepSeams(changedAbs, allFileContents) {
  const excluded = new Set(changedAbs);
  const symbols = [], routes = [], events = [];
  for (const absPath of changedAbs) {
    const content = allFileContents.get(absPath);
    if (!content) continue;
    for (const sym of extractExportedSymbols(content))
      symbols.push({ value: sym, occurrences: grepRepo(sym, allFileContents, excluded) });
    for (const route of extractRoutePaths(content))
      routes.push({ value: route, occurrences: grepRepo(route, allFileContents, excluded) });
    for (const key of extractEventKeys(content))
      events.push({ value: key, occurrences: grepRepo(key, allFileContents, excluded) });
  }
  return { symbols, routes, events };
}

// -- Shared-surface verdict --------------------------------------------------

const SCHEMA_FILE_NAMES = new Set(['schema.ts', 'schema-agent-system.ts', 'migrate.ts', 'migration.ts']);

function isSchemaOrMigration(absPath) {
  const name = basename(absPath);
  if (SCHEMA_FILE_NAMES.has(name)) return true;
  if (extname(name) === '.sql') return true;
  if (/^schema[-.]/i.test(name) || /[.-]schema\.ts$/i.test(name)) return true;
  return false;
}

function isPublicPackageEntry(absPath, pkgMap) {
  for (const mainAbs of pkgMap.values()) if (mainAbs === absPath) return true;
  return false;
}

function assessSharedSurface(changedAbs, importerMap, seam, pkgMap) {
  const reasons = [];

  if (seam.routes.length > 0)
    reasons.push('HTTP routes defined: ' + seam.routes.map((r) => r.value).join(', '));

  const exportedNames = seam.symbols.map((s) => s.value);
  if (exportedNames.length > 0) {
    const preview = exportedNames.slice(0, 10).join(', ');
    const more = exportedNames.length > 10 ? ' ... (+' + (exportedNames.length - 10) + ' more)' : '';
    reasons.push('Exported symbols: ' + preview + more);
  }

  const schemaFiles = changedAbs.filter(isSchemaOrMigration);
  if (schemaFiles.length > 0)
    reasons.push('DB schema/migration files: ' + schemaFiles.map(repoRel).join(', '));

  const entryFiles = changedAbs.filter((f) => isPublicPackageEntry(f, pkgMap));
  if (entryFiles.length > 0)
    reasons.push('Package entry points: ' + entryFiles.map(repoRel).join(', '));

  const withImporters = changedAbs.filter((f) => (importerMap.get(f)?.direct.length ?? 0) > 0);
  if (withImporters.length > 0) {
    const total = withImporters.reduce((n, f) => n + (importerMap.get(f)?.direct.length ?? 0), 0);
    reasons.push(total + ' direct importer(s) across ' + withImporters.length + ' changed file(s)');
  }

  return { isShared: reasons.length > 0, reasons };
}

// -- Get changed files -------------------------------------------------------

function getChangedFiles(gitRange, explicitFiles) {
  if (explicitFiles && explicitFiles.length > 0) return explicitFiles;

  const cmd = gitRange ? 'git diff --name-only ' + gitRange : 'git status --short';
  let out;
  try { out = execSync(cmd, { cwd: REPO, encoding: 'utf8' }); }
  catch (err) { throw new Error('git failed: ' + err.message); }

  if (gitRange) return out.trim().split('\n').map((l) => l.trim()).filter(Boolean);

  // Parse git status --short output
  const files = [];
  for (const line of out.trim().split('\n')) {
    if (!line.trim()) continue;
    const parts = line.slice(3).trim().split(' -> ');
    files.push(fwd(parts[parts.length - 1].trim().replace(/^"|"$/g, '')));
  }
  return files.filter(Boolean);
}

// -- Report assembly ---------------------------------------------------------

function buildReport(changedRelPaths, pkgMap, allFiles, depth) {
  const allFileContents = new Map();
  for (const f of allFiles) {
    try { allFileContents.set(f, readFileSync(f, 'utf8')); } catch { /* skip */ }
  }

  const changedAbs = changedRelPaths
    .map((p) => resolve(REPO, p))
    .filter((p) => allFileContents.has(p));

  const reverseGraph = buildReverseGraph(allFiles, pkgMap, allFileContents);
  const importerMap = findImporters(changedAbs, reverseGraph, depth);
  const seam = sweepSeams(changedAbs, allFileContents);
  const verdict = assessSharedSurface(changedAbs, importerMap, seam, pkgMap);

  const importGraph = {};
  for (const relPath of changedRelPaths) {
    const absPath = resolve(REPO, relPath);
    const { direct = [], transitive = [] } = importerMap.get(absPath) ?? {};
    importGraph[relPath] = { direct: direct.map(repoRel), transitive: transitive.map(repoRel) };
  }

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      depth,
      input: changedRelPaths.length ? changedRelPaths.length + ' changed file(s)' : 'no changed files',
    },
    changedFiles: changedRelPaths,
    importGraph,
    seam: { symbols: seam.symbols, routes: seam.routes, events: seam.events },
    verdict,
  };
}

// -- Human output ------------------------------------------------------------

function hr() { return '-'.repeat(70); }

function printHuman(report) {
  const { meta, changedFiles, importGraph, seam, verdict } = report;
  console.log('\n  BLAST RADIUS RADAR\n  ' + meta.input + '\n');

  console.log(hr()); console.log('  1. CHANGED FILES'); console.log(hr());
  if (!changedFiles.length) console.log('  (no changed files detected)');
  else for (const f of changedFiles) console.log('  * ' + f);
  console.log('');

  console.log(hr()); console.log('  2. REVERSE IMPORT GRAPH  (depth=' + meta.depth + ')'); console.log(hr());
  let anyImp = false;
  for (const [file, { direct, transitive }] of Object.entries(importGraph)) {
    if (!direct.length && !transitive.length) continue;
    anyImp = true;
    console.log('  ^ ' + file);
    for (const imp of direct) console.log('      imported by: ' + imp);
    for (const imp of transitive) console.log('      (transitive): ' + imp);
  }
  if (!anyImp) console.log('  (no importers found in scanned source files)');
  console.log('');

  console.log(hr()); console.log('  3. STRINGLY-TYPED SEAM SWEEP'); console.log(hr());
  function printSec(label, items) {
    if (!items.length) return;
    console.log('\n  [' + label + ']');
    for (const { value, occurrences } of items) {
      console.log('  * "' + value + '"');
      console.log('    consumers: ' + (occurrences.length ? occurrences.join(', ') : '(none outside changed files)'));
    }
  }
  printSec('exported symbols', seam.symbols);
  printSec('HTTP routes', seam.routes);
  printSec('event/channel keys', seam.events);
  if (!seam.symbols.length && !seam.routes.length && !seam.events.length)
    console.log('  (no seams detected in changed files)');
  console.log('');

  console.log(hr()); console.log('  4. SHARED-SURFACE VERDICT'); console.log(hr());
  console.log('  ' + (verdict.isShared
    ? '!! SHARED -- full plan/review required; cannot be trivial'
    : 'OK NOT SHARED -- advisory only; may be marked trivial'));
  if (verdict.reasons.length) {
    console.log('\n  Reasons:');
    for (const r of verdict.reasons) console.log('    * ' + r);
  }
  console.log('');
  console.log('shared_surface=' + verdict.isShared);
}

// -- Smoke test --------------------------------------------------------------

function runSmokeTest() {
  console.log('[blast-radius] running smoke test...');

  const syms = extractExportedSymbols(
    'export function doThing() {}\nexport class MyClass {}\n' +
    'export const VALUE = 42;\nexport type MyType = string;\n' +
    'export interface IFoo {}\nexport { bar, baz as Baz }'
  );
  for (const s of ['doThing', 'MyClass', 'VALUE', 'MyType', 'IFoo', 'bar', 'Baz']) {
    if (!syms.includes(s)) throw new Error('smoke: missing symbol "' + s + '" -- got ' + JSON.stringify(syms));
  }

  const rpaths = extractRoutePaths(
    "app.get('/api/projects/:id/work-items', h);\nconst x = '/api/live-events';"
  );
  if (!rpaths.includes('/api/projects/:id/work-items')) throw new Error('smoke: missing /api/projects/:id/work-items');
  if (!rpaths.includes('/api/live-events')) throw new Error('smoke: missing /api/live-events');

  const ekeys = extractEventKeys(
    "type: 'context-doc.changed',\ntype: 'work-item.updated',\ntype: 'agent-run.started',"
  );
  if (!ekeys.includes('context-doc.changed')) throw new Error('smoke: missing context-doc.changed');
  if (!ekeys.includes('work-item.updated')) throw new Error('smoke: missing work-item.updated');

  const pkgMap = buildWorkspacePackageMap();
  if (!pkgMap.has('@pc/domain')) throw new Error('smoke: missing @pc/domain in pkgMap');
  if (!pkgMap.has('@pc/db')) throw new Error('smoke: missing @pc/db in pkgMap');

  const allFiles = walkSourceFiles(REPO);
  if (allFiles.length < 10) throw new Error('smoke: too few files -- ' + allFiles.length);

  const allFileContents = new Map();
  for (const f of allFiles) {
    try { allFileContents.set(f, readFileSync(f, 'utf8')); } catch { /* skip */ }
  }
  const reverseGraph = buildReverseGraph(allFiles, pkgMap, allFileContents);
  const schemaAbs = resolve(REPO, 'packages/db/src/schema.ts');
  const schemaImporters = reverseGraph.get(schemaAbs) ?? new Set();
  if (schemaImporters.size === 0) throw new Error('smoke: schema.ts has no importers -- import parsing broken');

  console.log('[blast-radius] smoke PASSED -- files: ' + allFiles.length +
    ', packages: ' + pkgMap.size + ', schema.ts importers: ' + schemaImporters.size);
}

// -- CLI parsing -------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const lines = src.split('\n');
    const commentLines = [];
    for (const line of lines.slice(1)) {
      if (!line.startsWith('//')) break;
      commentLines.push(line.replace(/^\/\/\s?/, ''));
    }
    console.log(commentLines.join('\n'));
    process.exit(0);
  }

  if (args.includes('--smoke')) { runSmokeTest(); process.exit(0); }

  const jsonMode = args.includes('--json');

  const filesIdx = args.indexOf('--files');
  let explicitFiles = null;
  if (filesIdx !== -1) {
    if (!args[filesIdx + 1]) { console.error('--files requires a value'); process.exit(1); }
    explicitFiles = args[filesIdx + 1].split(',').map((f) => fwd(f.trim())).filter(Boolean);
  }

  const depthIdx = args.indexOf('--depth');
  let depth = 1;
  if (depthIdx !== -1) {
    depth = parseInt(args[depthIdx + 1], 10);
    if (isNaN(depth) || depth < 1) depth = 1;
  }

  const skipIdx = new Set();
  if (filesIdx !== -1) { skipIdx.add(filesIdx); skipIdx.add(filesIdx + 1); }
  if (depthIdx !== -1) { skipIdx.add(depthIdx); skipIdx.add(depthIdx + 1); }
  const positional = args.filter((a, i) => !a.startsWith('--') && !skipIdx.has(i));
  const gitRange = positional[0] ?? null;

  return { jsonMode, explicitFiles, depth, gitRange };
}

// -- Main --------------------------------------------------------------------

async function main() {
  const { jsonMode, explicitFiles, depth, gitRange } = parseArgs(process.argv);

  let changedRelPaths;
  try { changedRelPaths = getChangedFiles(gitRange, explicitFiles); }
  catch (err) { console.error('Error: ' + err.message); process.exit(1); }

  if (!jsonMode) console.log('[blast-radius] scanning repo...');

  const allFiles = walkSourceFiles(REPO);
  const pkgMap = buildWorkspacePackageMap();
  const report = buildReport(changedRelPaths, pkgMap, allFiles, depth);

  if (jsonMode) console.log(JSON.stringify(report, null, 2));
  else printHuman(report);
}

main().catch((err) => { console.error('[blast-radius] fatal:', err); process.exit(1); });
