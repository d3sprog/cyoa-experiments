// Shared evaluation machinery for the scorer front-ends (score.js, score-jev.js).
// Everything here is model-agnostic: a front-end supplies an `ask` function and its
// own option cap, and this module owns the type-tree walk, the CSV and the console
// output, so the two entry points cannot drift apart.

import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createAllProviders, resolveType, resolveMethodReturn, getGlobals } from './providers.js';
import { log, clr } from './log.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── constants ─────────────────────────────────────────────────────────────────

// Jev's Choice questions accept at most 255 options, so both scorers cap there:
// the models must see identical menus for the accuracy numbers to be comparable.
export const MAX_OPTIONS = 255;

// Per-chain token counts ride along in the CSV so a run can be priced after the fact.
const CSV_HEADER =
  'snippet_id,snippet_title,chain_index,provider,total_steps,correct_steps,input_tokens,output_tokens\n';

// Members that end a chain — once we reach one there is nothing left to navigate.
export const SERIES_OPS = new Set([
  'get series', 'get the data',
  'with key', 'and value',
  'take', 'skip', 'shuffle', 'reverse', 'sortKeys', 'sortValues',
  'setProperties', 'map', 'append',
]);

// ── retry wrapper ─────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

// `classify` maps a thrown error to { retryable, retryAfterMs, label } so each
// front-end can recognise its own transport's rate-limit and transient failures.
export async function withRetry(fn, classify, maxAttempts = 5) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const { retryable, retryAfterMs, label } = classify(e);

      if (attempt === maxAttempts || !retryable) throw e;

      // Honour the retry-after header when present, otherwise exponential backoff
      const baseMs = retryAfterMs ?? Math.min(2 ** attempt * 1000, 60_000);
      const jitter = Math.random() * 1000;
      const delay = Math.round(baseMs + jitter);

      log.trace(`  ${label} — waiting ${(delay / 1000).toFixed(1)}s then retry ${attempt}/${maxAttempts - 1}...`);
      await sleep(delay);
    }
  }
}

// ── scoring (async generator — yields one result per scored step) ─────────────

// `ask` receives { title, description, hint, chainHint, path, members } and returns
// { index, inputTokens, outputTokens } — index being a 0-based index into `members`, or
// null when no answer could be resolved. Token counts are tallied per chain so the
// notebook can price a run straight from the CSV. With dryRun the walk still happens
// but nothing is asked — used to audit option-list sizes.
export async function* scoreChain(entities, snippet, chain, ask, maxOptions, dryRun = false) {
  const [providerName, ...steps] = chain.steps;
  const entity = entities.find(e => e.Kind.fields[0].Name === providerName);
  if (!entity) return;

  let typ = entity.Type;
  const path = [providerName];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    typ = await resolveType(typ);
    if (!typ) break;

    if (typ.tag !== 1) {
      if (typ.tag === 4) {
        const baseName = step.replace(/\([^)]*\)$/, '');
        if (SERIES_OPS.has(baseName) || SERIES_OPS.has(step)) break;
        typ = await resolveMethodReturn(typ);
        if (!typ) break;
        i--;
        continue;
      }
      break;
    }

    const members = typ.fields[0].Members;
    if (!members.length) break;

    const baseName = step.replace(/\([^)]*\)$/, '');
    const truthIdx = members.findIndex(m => m.Name === baseName || m.Name === step);
    if (truthIdx === -1) break;

    // If the member list is huge, sample maxOptions entries keeping the correct one
    let askMembers = members;
    let askTruthIdx = truthIdx;
    if (members.length > maxOptions) {
      const others = members.filter((_, i) => i !== truthIdx)
                            .sort(() => Math.random() - 0.5)
                            .slice(0, maxOptions - 1);
      askTruthIdx = Math.floor(Math.random() * maxOptions);
      others.splice(askTruthIdx, 0, members[truthIdx]);
      askMembers = others;
    }

    // Signal that we're about to ask, so the caller can show a spinner
    yield { pending: true, step, memberCount: members.length, truncated: askMembers.length < members.length };

    if (!dryRun) {
      const answer = await ask({
        title: snippet.title,
        description: snippet.description,
        hint: chain.hint ?? null,
        chainHint: chain.chainHint ?? null,
        path,
        members: askMembers,
      });
      const pickIdx = answer.index;
      const correct = pickIdx === askTruthIdx;
      const pick = pickIdx !== null ? askMembers[pickIdx]?.Name ?? null : null;

      yield {
        pending: false, step, pick, correct,
        inputTokens: answer.inputTokens ?? 0,
        outputTokens: answer.outputTokens ?? 0,
      };
    }

    path.push(members[truthIdx].Name);
    typ = members[truthIdx].Type;
  }
}

// ── snippet loading ───────────────────────────────────────────────────────────

export function loadSnippets(count, providerFilter) {
  const snippets = JSON.parse(
    readFileSync(join(__dirname, 'data', 'eval-snippets.json'), 'utf8')
  );

  return snippets
    .map(s => ({
      ...s,
      chains: providerFilter
        ? s.chains.filter(ch => ch.provider.toLowerCase() === providerFilter)
        : s.chains,
    }))
    .filter(s => s.chains.length > 0)
    .slice(0, count);
}

// ── dry run ───────────────────────────────────────────────────────────────────

// Walks every chain without calling any API. Writes the same CSV columns a real run
// would (correct_steps left at 0), so the step counts can be diffed against an
// existing results file, and reports how many menus exceed each model's option cap.
async function dryRun(entities, testSnippets, maxOptions, output) {
  const rows = [];
  const oversized = [];
  let totalSteps = 0;

  for (const snippet of testSnippets) {
    for (const [chainIdx, chain] of snippet.chains.entries()) {
      let steps = 0;

      for await (const ev of scoreChain(entities, snippet, chain, null, maxOptions, true)) {
        steps++;
        if (ev.memberCount > maxOptions) {
          oversized.push({ provider: chain.provider, step: ev.step, count: ev.memberCount });
        }
      }

      rows.push({ id: snippet.id, title: snippet.title, chainIdx, provider: chain.provider, steps });
      totalSteps += steps;
      log.trace(`  #${snippet.id} [${chain.provider}] chain ${chainIdx}: ${steps} steps`);
    }
  }

  log.info('');
  log.summary(`${rows.length} chains, ${totalSteps} steps`);

  // Every model sees the same cap, so these steps stay comparable — they are just
  // the ones where the menu is a random sample rather than the full member list.
  log.info(`\nSteps whose menu is sampled down to ${maxOptions}: ${oversized.length} of ${totalSteps}`);
  if (oversized.length) {
    const byProvider = {};
    for (const o of oversized) byProvider[o.provider] = (byProvider[o.provider] ?? 0) + 1;
    for (const [provider, n] of Object.entries(byProvider)) log.info(`  ${provider}: ${n}`);

    const worst = [...oversized].sort((a, b) => b.count - a.count).slice(0, 5);
    log.info('  largest menus:');
    for (const o of worst) log.info(`    ${o.count} options — "${o.step}" (${o.provider})`);
  }

  if (output) {
    mkdirSync(output, { recursive: true });
    const csvPath = join(output, 'dry-run.csv');
    const lines = rows.map(r =>
      `${r.id},"${r.title.replace(/"/g, '""')}",${r.chainIdx},${r.provider},${r.steps},0,0,0`);
    writeFileSync(csvPath, CSV_HEADER + lines.join('\n') + '\n');
    log.trace(`\nStep counts written to ${csvPath}`);
  }
}

// ── main evaluation loop ──────────────────────────────────────────────────────

export async function runEval({ model, promptLabel, maxOptions, ask, opts }) {
  log.trace('Setting up providers...');
  const p = createAllProviders();
  const entities = await getGlobals(p);
  log.trace('Providers ready.\n');

  const count = parseInt(opts.count, 10) || 3;
  const providerFilter = opts.provider?.toLowerCase() ?? null;
  const testSnippets = loadSnippets(count, providerFilter);

  if (opts.dryRun) {
    log.trace('Dry run — walking chains, no API calls\n');
    await dryRun(entities, testSnippets, maxOptions, opts.output);
    return;
  }

  log.trace(`Model: ${model}   Prompt: ${promptLabel}${providerFilter ? `   Provider: ${providerFilter}   ${testSnippets.length} snippet(s) matched` : ''}\n`);

  let csvPath = null;
  const doneChains = new Set(); // "snippetId:chainIdx" pairs already in CSV

  if (opts.resume) {
    csvPath = opts.resume;
    const lines = readFileSync(csvPath, 'utf8').trim().split('\n').slice(1); // skip header
    for (const line of lines) {
      if (!line.trim()) continue;
      // snippet_title is quoted and may itself contain commas ("MozFest - Trees in
      // Linz, Austria"), so a plain split() would misread chain_index and silently
      // re-run that chain, appending a duplicate row.
      const m = line.match(/^(\d+),(?:"(?:[^"]|"")*"|[^,]*),(\d+),/);
      if (m) doneChains.add(`${m[1]}:${m[2]}`);
    }
    log.trace(`Resuming ${csvPath} — skipping ${doneChains.size} already-scored chain(s)\n`);
  } else if (opts.output) {
    const ts = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 15);
    const prov = providerFilter ?? 'all';
    // Model ids can carry a vendor prefix ("typesafe/jev-1.13"); flatten it so the
    // name stays a single path segment and the notebook's filename regex still parses.
    const slug = model.replace(/^~/, '').replace(/[\\/]/g, '-');
    const filename = `${slug}__${promptLabel}__${prov}__${ts}.csv`;
    mkdirSync(opts.output, { recursive: true });
    csvPath = join(opts.output, filename);
    writeFileSync(csvPath, CSV_HEADER);
    log.trace(`Writing results to ${csvPath}\n`);
  }

  let grandTotal = 0, grandCorrect = 0, grandIn = 0, grandOut = 0;

  for (const snippet of testSnippets) {
    log.header(`#${snippet.id}: ${snippet.title}`);

    for (const [chainIdx, chain] of snippet.chains.entries()) {
      if (doneChains.has(`${snippet.id}:${chainIdx}`)) {
        log.trace(`  [${chain.provider}] skipped (already scored)`);
        continue;
      }
      log.trace(`  [${chain.provider}] ${chain.steps.length - 1} steps to score`);

      let chainTotal = 0, chainCorrect = 0, chainIn = 0, chainOut = 0;

      for await (const ev of scoreChain(entities, snippet, chain, ask, maxOptions)) {
        if (ev.pending) {
          const countStr = ev.truncated ? `${maxOptions}/${ev.memberCount} options` : `${ev.memberCount} options`;
          log.write(clr.trace(`    "${ev.step}" (${countStr})... `));
          continue;
        }

        if (ev.correct) {
          log.write(clr.success('✓') + '\n');
        } else {
          log.write(clr.fail('✗') + clr.trace(`  ← picked "${ev.pick}"`) + '\n');
        }

        chainTotal++;
        if (ev.correct) chainCorrect++;
        chainIn += ev.inputTokens;
        chainOut += ev.outputTokens;
      }

      const pct = chainTotal > 0 ? Math.round(100 * chainCorrect / chainTotal) : 0;
      const score = `  ${chainCorrect}/${chainTotal} (${pct}%)`;
      log.info(pct >= 70 ? clr.success(score) : pct >= 40 ? clr.warn(score) : clr.fail(score));

      grandTotal += chainTotal;
      grandCorrect += chainCorrect;
      grandIn += chainIn;
      grandOut += chainOut;

      if (csvPath) {
        const title = snippet.title.replace(/"/g, '""');
        appendFileSync(csvPath, `${snippet.id},"${title}",${chainIdx},${chain.provider},${chainTotal},${chainCorrect},${chainIn},${chainOut}\n`);
      }
    }

    log.info('');
  }

  const grandPct = grandTotal > 0 ? Math.round(100 * grandCorrect / grandTotal) : 0;
  const summary = `${grandCorrect}/${grandTotal} steps correct (${grandPct}%)`;
  const colouredSummary = grandPct >= 70 ? clr.success(summary) : grandPct >= 40 ? clr.warn(summary) : clr.fail(summary);
  log.summary(`Overall: ${colouredSummary}`);
  log.trace(`Tokens: ${grandIn.toLocaleString('en-US')} in, ${grandOut.toLocaleString('en-US')} out`
    + '  (priced in results.ipynb from pricing.json)');

  if (csvPath) log.trace(`\nResults written to ${csvPath}`);
}
