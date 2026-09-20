import { readFileSync } from 'fs';
import { basename, extname } from 'path';
import { pathToFileURL } from 'url';
import { Command } from 'commander';
import * as config from './config.js';
import { runEval, withRetry, MAX_OPTIONS } from './runner.js';

// ── constants ─────────────────────────────────────────────────────────────────

// OpenRouter serves Jev from a dedicated "decisions" endpoint rather than through
// chat completions. TypeSafe's own API takes the same body at
// https://api.typesafe.ai/v1/systemone, so this is switchable if we get direct access.
export const ENDPOINT = process.env.JEV_ENDPOINT ?? 'https://openrouter.ai/api/alpha/decisions';

const KNOWN_MODELS = [
  'typesafe/jev-1.13',
  'typesafe/jev-1.13-20260917',
  '~typesafe/jev-latest',
];

const TASK = 'Which of the available options should be picked next to build the query described in the state?';

export const apiKey = config.OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY;

// ── decisions API ─────────────────────────────────────────────────────────────

// fetch only rejects on network failure, so non-2xx responses are turned into errors
// carrying the status for withRetry to classify.
export function classifyError(e) {
  const status = e?.status ?? 0;
  const isRateLimit = status === 429;
  const isTransient = status >= 500 || e?.name === 'TypeError'; // TypeError = network failure
  return {
    retryable: isRateLimit || isTransient,
    retryAfterMs: e?.retryAfter ? parseInt(e.retryAfter) * 1000 : null,
    label: isRateLimit ? 'rate limited' : 'API error',
  };
}

export async function postDecision(body) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    err.retryAfter = res.headers.get('retry-after');
    throw err;
  }
  return JSON.parse(text);
}

// criteria is a map keyed by option name, so duplicate or empty names would silently
// collapse into one option — drop them here rather than let the menu shrink unnoticed.
export function buildCriteria(members) {
  const seen = new Set();
  const criteria = {};
  for (const m of members) {
    const name = m.Name ?? m;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    criteria[name] = null;
  }
  return criteria;
}

// Exported so estimate-cost.js prices the exact request this scorer sends.
export function buildBody(model, { title, description, hint, chainHint, path, members }, systemPrompt) {
  return {
    model,
    state: {
      goal: title,
      ...(description ? { description } : {}),
      ...(chainHint ? { context: chainHint } : {}),
      ...(hint ? { hint } : {}),
      steps_so_far: path.slice(1),
    },
    questions: {
      next_step: {
        type: 'choice',
        // Jev has no system-prompt concept, so the navigation rules ride along in
        // the structured form of `instructions` instead.
        instructions: systemPrompt ? { task: TASK, guidance: systemPrompt } : TASK,
        criteria: buildCriteria(members),
      },
    },
  };
}

const NO_CALL = { index: null, inputTokens: 0, outputTokens: 0 };

function createAsk(model, systemPrompt) {
  return async (step) => {
    const { members } = step;
    const names = Object.keys(buildCriteria(members));

    // A Choice needs at least two options; a one-member menu is a forced move, so
    // answer it directly rather than spending a call or scoring it as a failure.
    if (names.length === 0) return NO_CALL;
    if (names.length === 1) {
      return { ...NO_CALL, index: members.findIndex(m => m.Name === names[0]) };
    }

    const res = await withRetry(
      () => postDecision(buildBody(model, step, systemPrompt)), classifyError);

    const usage = {
      inputTokens: res.usage?.input_tokens ?? 0,
      outputTokens: res.usage?.output_tokens ?? 0,
    };

    const name = res.answers?.next_step?.choice;
    if (!name) return { index: null, ...usage };

    const idx = members.findIndex(m => m.Name === name);
    return { index: idx === -1 ? null : idx, ...usage };
  };
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const program = new Command();
  program
    .name('score-jev')
    .description('Score Jev accuracy at navigating The Gamma type providers')
    .option('-n, --count <n>', 'number of snippets to test', '3')
    .option('-p, --provider <name>', 'filter to a specific provider (olympics, worldbank, expenditure, drwho, shared)')
    .option('-m, --model <name>', 'model to use', 'typesafe/jev-1.13')
    .option('-s, --system-prompt <file>', 'path to a text file whose contents become the question guidance')
    .option('-o, --output <dir>', 'directory to write CSV results to (created if absent)')
    .option('-r, --resume <file>', 'resume an interrupted run: skip already-scored chains and append to this CSV')
    .option('--dry-run', 'walk the chains and report option-list sizes without calling the API')
    .addHelpText('after', `
Known models:
  ${KNOWN_MODELS.join('\n  ')}

Jev is reached through OpenRouter's decisions endpoint; set OPENROUTER_API_KEY in
config.js or the environment. Override the host with JEV_ENDPOINT.

Examples:
  node score-jev.js -n 5
  node score-jev.js -n 5 -p olympics
  node score-jev.js -n 5 -p olympics -s prompts/default-prompt.txt
  node score-jev.js -n 61 -s prompts/default-prompt.txt --output results`);

  if (process.argv.length <= 2) { program.help(); }

  program.parse();
  const opts = program.opts();

  if (!apiKey && !opts.dryRun) {
    console.error('No OpenRouter API key found.\n');
    console.error('Add this line to config.js (gitignored):');
    console.error("  export const OPENROUTER_API_KEY = 'your-key-here';");
    console.error('\nor set the OPENROUTER_API_KEY environment variable.');
    process.exit(1);
  }

  const systemPrompt = opts.systemPrompt
    ? readFileSync(opts.systemPrompt, 'utf8')
    : null;
  const promptLabel = opts.systemPrompt
    ? basename(opts.systemPrompt, extname(opts.systemPrompt))
    : 'no-prompt';

  await runEval({
    model: opts.model,
    promptLabel,
    maxOptions: MAX_OPTIONS,
    ask: createAsk(opts.model, systemPrompt),
    opts,
  });
}

// Only run when invoked directly; estimate-cost.js imports buildBody from here.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e); process.exit(1); });
}
