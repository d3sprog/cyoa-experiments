// Per-step ranking log for Jev.
//
// score-jev.js records whether each step was right. This records *how* right: where the
// correct member ranked in Jev's probability distribution, how much mass it got, what
// nearly won instead, and how peaked the distribution was. None of that is recoverable
// after a run — the distribution only exists in the response — so it has to be captured
// at the time.
//
// Deliberately a separate command rather than a flag on score-jev.js, so the scorers and
// their resume logic stay untouched. It repeats the Jev calls, which costs about what a
// Jev scoring run costs (~$0.03 for all 61 snippets).
//
// Usage: node rank-jev.js [-n 61] [-p provider] [-m model] [-s prompt] [-o dir] [-r file]
//
// Analysed by ranking.ipynb. Requires thegamma-unified on http://localhost:5000.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, basename, extname } from 'path';
import { pathToFileURL } from 'url';
import { Command } from 'commander';
import { createAllProviders, getGlobals } from './providers.js';
import { scoreChain, loadSnippets, withRetry, csvCell, appendRow, MAX_OPTIONS } from './runner.js';
import { buildBody, buildCriteria, postDecision, classifyError, apiKey } from './score-jev.js';
import { log, clr } from './log.js';

// ── constants ─────────────────────────────────────────────────────────────────

const CSV_HEADER = [
  'snippet_id', 'chain_index', 'step_index', 'provider', 'step',
  'n_options', 'n_members', 'api_called', 'correct',
  'truth_rank', 'truth_tied', 'truth_prob',
  'top1_name', 'top1_prob', 'top2_name', 'top2_prob',
  'confidence', 'entropy_bits',
  'input_tokens', 'output_tokens',
].join(',') + '\n';

const KNOWN_MODELS = ['typesafe/jev-1.13', 'typesafe/jev-1.13-20260917', '~typesafe/jev-latest'];

// ── asking ────────────────────────────────────────────────────────────────────

// Returns the distribution as an array aligned with `members`, alongside the names, so
// the caller can rank it. The ask never sees the ground truth — scoreChain supplies
// truthIdx on the way back out.
function createAsk(model, systemPrompt) {
  return async (step) => {
    const { members } = step;
    const names = members.map(m => m.Name);
    const usable = Object.keys(buildCriteria(members));

    // A single-option menu is a forced move: no question to ask, nothing to rank.
    if (usable.length < 2) {
      const index = usable.length === 1 ? names.indexOf(usable[0]) : null;
      return { index, inputTokens: 0, outputTokens: 0, detail: { apiCalled: false } };
    }

    const res = await withRetry(
      () => postDecision(buildBody(model, step, systemPrompt)), classifyError);

    const answer = res.answers?.next_step ?? {};
    const byName = answer.probabilities ?? {};
    const name = answer.choice ?? null;

    return {
      index: name === null ? null : (names.indexOf(name) === -1 ? null : names.indexOf(name)),
      inputTokens: res.usage?.input_tokens ?? 0,
      outputTokens: res.usage?.output_tokens ?? 0,
      detail: {
        apiCalled: true,
        names,
        // Options dropped as duplicates never appear in the response; treat them as 0.
        probs: names.map(n => byName[n] ?? 0),
        confidence: answer.confidence ?? null,
      },
    };
  };
}

// ── ranking ───────────────────────────────────────────────────────────────────

// Sparse distributions are the norm — plenty of options come back at exactly 0. Rank is
// therefore "how many strictly beat the truth", and truth_tied says how many share its
// probability, so the notebook can tell a real rank from one that is just sort order.
function rankStats(probs, truthIdx) {
  const truthProb = probs[truthIdx] ?? 0;
  let rank = 1, tied = 0;
  for (const p of probs) {
    if (p > truthProb) rank++;
    else if (p === truthProb) tied++;
  }

  const order = probs.map((p, i) => [p, i]).sort((a, b) => b[0] - a[0]);
  const entropy = -probs.reduce((a, p) => (p > 0 ? a + p * Math.log2(p) : a), 0);

  return {
    truthProb, truthRank: rank, truthTied: tied,
    top1: order[0], top2: order[1] ?? [null, -1],
    entropy,
  };
}

const fix = (n, d = 6) => (typeof n === 'number' && isFinite(n) ? n.toFixed(d) : '');

function stepRow(ctx, ev, stepIndex) {
  const d = ev.detail ?? {};
  const base = [
    ctx.snippetId, ctx.chainIdx, stepIndex, csvCell(ctx.provider), csvCell(ev.step),
    ev.nOptions, ev.nMembers, d.apiCalled ? 1 : 0, ev.correct ? 1 : 0,
  ];

  if (!d.apiCalled || !d.probs) {
    // Forced move — real step, no distribution. Leave the ranking fields empty.
    return base.concat(['', '', '', '', '', '', '', '', '', ev.inputTokens, ev.outputTokens]).join(',');
  }

  const r = rankStats(d.probs, ev.truthIdx);
  return base.concat([
    r.truthRank, r.truthTied, fix(r.truthProb),
    csvCell(d.names[r.top1[1]]), fix(r.top1[0]),
    csvCell(r.top2[1] === -1 ? null : d.names[r.top2[1]]), fix(r.top2[0]),
    fix(d.confidence, 4), fix(r.entropy, 4),
    ev.inputTokens, ev.outputTokens,
  ]).join(',');
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const program = new Command();
  program
    .name('rank-jev')
    .description("Log Jev's full ranking of every step, for ranking.ipynb")
    .option('-n, --count <n>', 'number of snippets to test', '3')
    .option('-p, --provider <name>', 'filter to a specific provider')
    .option('-m, --model <name>', 'model to use', 'typesafe/jev-1.13')
    .option('-s, --system-prompt <file>', 'text file whose contents become the question guidance')
    .option('-o, --output <dir>', 'results directory; the CSV lands in <dir>/steps/', 'results')
    .option('-r, --resume <file>', 'resume an interrupted run: skip chains already in this CSV')
    .addHelpText('after', `
Known models:
  ${KNOWN_MODELS.join('\n  ')}

Writes one row per step to <output>/steps/, leaving <output>/*.csv (the scoring runs,
read by results.ipynb) untouched.

Examples:
  node rank-jev.js -n 1 -p olympics
  node rank-jev.js -n 61 -s prompts/default-prompt.txt
  node rank-jev.js -n 61 -s prompts/default-prompt.txt -r results/steps/<file>.csv`);

  if (process.argv.length <= 2) { program.help(); }

  program.parse();
  const opts = program.opts();

  if (!apiKey) {
    console.error('No OpenRouter API key found.\n');
    console.error('Add this line to config.js (gitignored):');
    console.error("  export const OPENROUTER_API_KEY = 'your-key-here';");
    console.error('\nor set the OPENROUTER_API_KEY environment variable.');
    process.exit(1);
  }

  const systemPrompt = opts.systemPrompt ? readFileSync(opts.systemPrompt, 'utf8') : null;
  const promptLabel = opts.systemPrompt
    ? basename(opts.systemPrompt, extname(opts.systemPrompt))
    : 'no-prompt';

  log.trace('Setting up providers...');
  const entities = await getGlobals(createAllProviders());
  log.trace('Providers ready.\n');

  const providerFilter = opts.provider?.toLowerCase() ?? null;
  const testSnippets = loadSnippets(parseInt(opts.count, 10) || 3, providerFilter);

  // ── output file, resuming if asked ──
  const doneChains = new Set();
  let csvPath;

  if (opts.resume) {
    csvPath = opts.resume;
    for (const line of readFileSync(csvPath, 'utf8').trim().split('\n').slice(1)) {
      if (!line.trim()) continue;
      const m = line.match(/^(\d+),(\d+),/);
      if (m) doneChains.add(`${m[1]}:${m[2]}`);
    }
    log.trace(`Resuming ${csvPath} — skipping ${doneChains.size} already-ranked chain(s)\n`);
  } else {
    const ts = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 15);
    const slug = opts.model.replace(/^~/, '').replace(/[\\/]/g, '-');
    const dir = join(opts.output, 'steps');
    mkdirSync(dir, { recursive: true });
    csvPath = join(dir, `${slug}__${promptLabel}__${providerFilter ?? 'all'}__${ts}.csv`);
    writeFileSync(csvPath, CSV_HEADER);
    log.trace(`Model: ${opts.model}   Prompt: ${promptLabel}`);
    log.trace(`Writing rankings to ${csvPath}\n`);
  }
  if (!existsSync(csvPath)) writeFileSync(csvPath, CSV_HEADER);

  const ask = createAsk(opts.model, systemPrompt);
  let rows = 0, ranked = 0, top1 = 0, top5 = 0, reciprocal = 0;

  for (const snippet of testSnippets) {
    log.header(`#${snippet.id}: ${snippet.title}`);

    for (const [chainIdx, chain] of snippet.chains.entries()) {
      if (doneChains.has(`${snippet.id}:${chainIdx}`)) {
        log.trace(`  [${chain.provider}] skipped (already ranked)`);
        continue;
      }
      log.trace(`  [${chain.provider}] ${chain.steps.length - 1} steps`);

      const ctx = { snippetId: snippet.id, chainIdx, provider: chain.provider };
      let stepIndex = 0;

      for await (const ev of scoreChain(entities, snippet, chain, ask, MAX_OPTIONS)) {
        if (ev.pending) {
          log.write(clr.trace(`    "${ev.step}" (${ev.memberCount} options)... `));
          continue;
        }

        await appendRow(csvPath, stepRow(ctx, ev, stepIndex) + '\n');
        rows++;

        const d = ev.detail ?? {};
        if (d.apiCalled && d.probs) {
          const r = rankStats(d.probs, ev.truthIdx);
          ranked++;
          // top-1 follows the actual choice, not the rank: on an exact tie the truth can
          // rank 1 while the argmax lands on the option it is tied with.
          if (ev.correct) top1++;
          if (r.truthRank <= 5) top5++;
          reciprocal += 1 / r.truthRank;
          const mark = ev.correct ? clr.success('✓') : clr.fail('✗');
          log.write(`${mark}${clr.trace(`  rank ${r.truthRank}/${ev.nOptions}  p=${r.truthProb.toFixed(3)}  conf=${(d.confidence ?? 0).toFixed(2)}`)}\n`);
        } else {
          log.write(clr.trace('— forced move\n'));
        }
        stepIndex++;
      }
    }
    log.info('');
  }

  if (ranked) {
    log.summary(`${rows} steps logged (${ranked} ranked)`);
    log.info(`  top-1 ${(100 * top1 / ranked).toFixed(1)}%   top-5 ${(100 * top5 / ranked).toFixed(1)}%   MRR ${(reciprocal / ranked).toFixed(3)}`);
    log.trace('\n  Headline only — ranking.ipynb excludes ties-at-zero and splits by provider.');
  } else {
    log.summary(`${rows} steps logged, none with a distribution`);
  }
  log.trace(`\nWritten to ${csvPath}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e); process.exit(1); });
}
