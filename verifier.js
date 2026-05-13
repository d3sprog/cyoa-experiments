import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createAllProviders, resolveType, resolveMethodReturn, getGlobals } from './providers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const snippets = JSON.parse(
  readFileSync(join(__dirname, 'data', 'eval-snippets.json'), 'utf8')
);

// Type tag names for readable output
const TYPE_TAGS = { 0: 'Delayed', 1: 'Object', 2: 'Primitive', 3: 'List', 4: 'Method', 5: 'Any' };

// Steps that operate on a series result rather than navigating the type tree.
// When we hit a Method type and the next step is one of these, we've reached
// the series and should stop early rather than report a failure.
const SERIES_OPS = new Set([
  'get series', 'get the data',
  'with key', 'and value',
  'take', 'skip', 'shuffle', 'reverse', 'sortKeys', 'sortValues',
  'setProperties', 'map', 'append',
]);

// Follow a single step from the current type. Returns { typ, status } where
// status is 'ok', 'series_stop', 'not_found', or 'wrong_type'.
async function followStep(typ, step) {
  typ = await resolveType(typ);

  if (!typ) return { typ: null, status: 'wrong_type', detail: 'null type' };

  if (typ.tag !== 1) {
    if (typ.tag === 4) {
      const baseName = step.replace(/\([^)]*\)$/, '');
      if (SERIES_OPS.has(baseName) || SERIES_OPS.has(step))
        return { typ, status: 'series_stop' };
      // Call through the method using its declared arg types to get the return type,
      // then retry the step from there.
      const retTyp = await resolveMethodReturn(typ);
      return retTyp ? followStep(retTyp, step) : { typ, status: 'wrong_type', detail: 'Method (no return type)' };
    }
    return { typ, status: 'wrong_type', detail: TYPE_TAGS[typ.tag] ?? `tag ${typ.tag}` };
  }

  const members = typ.fields[0].Members;
  // Strip (args) suffix when looking up the member name
  const baseName = step.replace(/\([^)]*\)$/, '');
  const member = members.find(m => m.Name === baseName || m.Name === step);

  if (!member) return { typ, status: 'not_found', memberCount: members.length };
  return { typ: member.Type, status: 'ok' };
}

// Returns { ok, navSteps, seriesTail } where navSteps are the verified
// navigation steps and seriesTail is the remaining steps after a series_stop.
async function verifyChain(entities, chain) {
  const [providerName, ...steps] = chain.steps;

  const entity = entities.find(e => e.Kind.fields[0].Name === providerName);
  if (!entity)
    return { ok: false, navSteps: [{ step: providerName, status: 'not_found', detail: 'not in globals' }], seriesTail: [] };

  let typ = entity.Type;
  const navSteps = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const { typ: nextTyp, status, detail, memberCount } = await followStep(typ, step);

    if (status === 'series_stop')
      return { ok: true, navSteps, seriesTail: steps.slice(i) };

    navSteps.push({ step, status, detail, memberCount });
    if (status !== 'ok')
      return { ok: false, navSteps, seriesTail: [] };

    typ = nextTyp;
  }

  return { ok: true, navSteps, seriesTail: [] };
}

async function main() {
  process.stdout.write('Setting up providers...');
  const p = createAllProviders();
  const entities = await getGlobals(p);
  process.stdout.write(`\r${' '.repeat(30)}\r`);

  let totalChains = 0, passed = 0;
  const failures = [];

  for (const snippet of snippets) {
    for (const chain of snippet.chains) {
      totalChains++;
      process.stdout.write(`Verifying #${snippet.id} [${chain.provider}]...\r`);

      const { ok, navSteps, seriesTail } = await verifyChain(entities, chain);

      if (ok) {
        passed++;
        if (seriesTail.length)
          console.log(`OK  #${snippet.id} [${chain.provider}] → series: ${seriesTail.join(' > ')}`);
      } else {
        failures.push({ snippet, chain, navSteps });
      }
    }
  }

  process.stdout.write(' '.repeat(40) + '\r');

  if (failures.length === 0) {
    console.log(`All ${totalChains} chains verified OK`);
    return;
  }

  for (const { snippet, chain, navSteps } of failures) {
    const bad = navSteps.find(r => r.status !== 'ok');
    const okCount = navSteps.filter(r => r.status === 'ok').length;
    console.log(`FAIL #${snippet.id} [${chain.provider}] ${snippet.title}`);
    console.log(`  Passed ${okCount}/${chain.steps.length - 1} steps, stopped at: "${bad.step}"`);
    if (bad.status === 'not_found')
      console.log(`  Not found among ${bad.memberCount} members`);
    else if (bad.status === 'wrong_type')
      console.log(`  Type was: ${bad.detail}`);
    else if (bad.detail)
      console.log(`  ${bad.detail}`);
    console.log();
  }

  console.log(`Results: ${passed}/${totalChains} passed, ${failures.length} failed`);
}

main().catch(e => { console.error(e); process.exit(1); });
