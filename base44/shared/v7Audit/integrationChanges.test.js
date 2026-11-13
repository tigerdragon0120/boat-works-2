// Validates proposed edits in memory. Does not apply them or load deployed handlers.
import { createRequire } from 'node:module';
const ts = createRequire(import.meta.url)('typescript');

const root = new URL('../../../', import.meta.url);
const assert = (condition, message = 'Assertion failed') => { if (!condition) throw new Error(message); };

async function proposedSources() {
  const plan = JSON.parse(await Deno.readTextFile(new URL('./integrationChanges.json', import.meta.url)));
  assert(plan.status === 'LOCAL_ONLY_NOT_APPLIED' && plan.files.length === 3);
  const output = new Map();
  for (const file of plan.files) {
    let source = await Deno.readTextFile(new URL(file.path, root));
    if (file.replacement) source = file.replacement;
    for (const edit of file.edits || []) {
      const first = source.indexOf(edit.find);
      assert(first >= 0 && source.indexOf(edit.find, first + edit.find.length) < 0, `Edit must match exactly once: ${file.path}`);
      source = source.replace(edit.find, edit.replace);
    }
    output.set(file.path, source);
  }
  return output;
}

Deno.test('three-file integration proposal applies uniquely in memory and parses without syntax errors', async () => {
  for (const [fileName, source] of await proposedSources()) {
    const result = ts.transpileModule(source, { fileName, reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
    const errors = (result.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error);
    assert(errors.length === 0, `${fileName}: ${errors.map(item => ts.flattenDiagnosticMessageText(item.messageText, ' ')).join('; ')}`);
  }
});

Deno.test('proposed generation only imports the read-only inspector and blocks before engine execution', async () => {
  const source = (await proposedSources()).get('base44/shared/v7AutoGeneration.js');
  assert(source.includes('await inspectStageClaims(sr, targets, { nowMs })'));
  for (const forbidden of ['provisionStageClaims', 'v7StageClaimProvision', 'acquireLock', 'releaseLock', 'allowCreate', 'V7StageClaim.create']) {
    assert(!source.includes(forbidden), `Generation must not prepare claims: ${forbidden}`);
  }
  assert(source.indexOf('if (!claims.readyPairs.has(') < source.indexOf('const output = unifiedV7(snapshot, stage)'));
  assert(source.includes('uniqueness_guaranteed: false') && source.includes('claim_unprepared'));
});

Deno.test('proposed administrator entry defaults to read-only, discloses limits, and has no database lock', async () => {
  const source = (await proposedSources()).get('base44/functions/provisionV7StageClaims/entry.ts');
  assert(source.includes('body?.dry_run !== false') && source.includes('SINGLE_ADMIN_RUN_REQUIRED'));
  assert(source.includes('user.role !== "admin"') && source.includes('uniqueness_guaranteed: false'));
  for (const forbidden of ['acquireLock', 'releaseLock', 'ProcessLock']) assert(!source.includes(forbidden));
});

Deno.test('proposed wiring preserves every engine, BUY and ticket calculation statement', async () => {
  const changed = await proposedSources();
  const path = 'base44/shared/v7AutoGeneration.js';
  const before = await Deno.readTextFile(new URL(path, root));
  const after = changed.get(path);
  const block = source => source.slice(source.indexOf('      const output = unifiedV7(snapshot, stage);'), source.indexOf('      docs.push(doc);'));
  assert(block(before) === block(after) && block(before).length > 1000);
  const plans = source => source.slice(source.indexOf('function rankOrder(output)'), source.indexOf('export async function runV7AutoGeneration'));
  assert(plans(before) === plans(after));
  assert([...changed.keys()].every(file => !/predictionEngine|predictionServiceV65|womensRace|src\//.test(file)));
});