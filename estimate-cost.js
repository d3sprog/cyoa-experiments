// Estimate what an evaluation run will cost, before spending anything on it.
//
// Walks the same chains the scorers walk and builds each step's request with the very
// same builders they use, then counts the Anthropic prompts with count_tokens (free and
// exact). Jev is measured by making a handful of real decisions calls and reading back
// usage.cost, which OpenRouter reports per request. Nothing is scored.
//
// After a run has happened, results.ipynb prices it from the token columns in the CSV;
// this script is only for the estimate beforehand. Both read prices from pricing.json.
//
// Usage: node estimate-cost.js [-n 61] [-p provider] [--jev-sample 15]
//
// Requires thegamma-unified on http://localhost:5000, like the scorers.

import { readFileSync } from 'fs';
import { Command } from 'commander';
import Anthropic from '@anthropic-ai/sdk';
import { ANTHROPIC_API_KEY } from './config.js';
import * as config from './config.js';
import { createAllProviders, getGlobals } from './providers.js';
import { scoreChain, loadSnippets, MAX_OPTIONS } from './runner.js';
import { buildPrompt } from './score.js';
import { buildBody } from './score-jev.js';
import { log, clr } from './log.js';

// ── constants ─────────────────────────────────────────────────────────────────

const PRICING = JSON.parse(readFileSync('pricing.json', 'utf8')).models;

const JEV_MODEL = 'typesafe/jev-1.13';
const JEV_SLUG = 'typesafe-jev-1.13';
const JEV_ENDPOINT = process.env.JEV_ENDPOINT ?? 'https://openrouter.ai/api/alpha/decisions';

const ANTHROPIC_MODELS = ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5'];
const SWEEP_MODELS = ['claude-haiku-4-5', 'claude-sonnet-5']; // what run-eval.sh runs

const MAX_OUTPUT_TOKENS = 16; // score.js caps completions here
const CONCURRENCY = 8;

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ── helpers ───────────────────────────────────────────────────────────────────

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }));
  return results;
}

const usd = n => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const num = n => Math.round(n).toLocaleString('en-US');

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const program = new Command();
  program
    .name('estimate-cost')
    .description('Estimate the API cost of an evaluation run (spends ~$0.001 on Jev sampling)')
    .option('-n, --count <n>', 'number of snippets to walk', '61')
    .option('-p, --provider <name>', 'filter to a specific provider')
    .option('--jev-sample <n>', 'real Jev calls used to measure its per-step cost (0 to skip)', '15')
    .parse();
  const opts = program.opts();

  log.trace('Setting up providers...');
  const entities = await getGlobals(createAllProviders());
  const testSnippets = loadSnippets(parseInt(opts.count, 10) || 61, opts.provider?.toLowerCase() ?? null);

  // Walk every chain, capturing what each scorer would be asked. The walk always
  // follows the ground-truth path, so what the ask returns is irrelevant here.
  const steps = [];
  const ask = async (step) => {
    steps.push({ ...step, path: [...step.path] });
    return { index: null, inputTokens: 0, outputTokens: 0 };
  };

  log.trace('Walking chains...');
  for (const snippet of testSnippets) {
    for (const chain of snippet.chains) {
      for await (const _ of scoreChain(entities, snippet, chain, ask, MAX_OPTIONS)) { /* drained */ }
    }
  }
  log.info(`\n${steps.length} steps across ${testSnippets.length} snippets (cap ${MAX_OPTIONS} options)\n`);

  const systemPrompt = readFileSync('prompts/default-prompt.txt', 'utf8');
  const prompts = steps.map(buildPrompt);

  // ── Anthropic: exact token counts, free ──
  const perModel = {};
  for (const model of ANTHROPIC_MODELS) {
    log.write(clr.trace(`  counting tokens for ${model}... `));

    const counts = await mapPool(prompts, CONCURRENCY, p =>
      client.messages.countTokens({ model, messages: [{ role: 'user', content: p }] })
        .then(r => r.input_tokens));

    // The system prompt is a separate field, so with-prompt = no-prompt + its tokens
    const [withSys, withoutSys] = await Promise.all([
      client.messages.countTokens({ model, system: systemPrompt, messages: [{ role: 'user', content: 'x' }] }),
      client.messages.countTokens({ model, messages: [{ role: 'user', content: 'x' }] }),
    ]);
    const sysTokens = withSys.input_tokens - withoutSys.input_tokens;

    const bare = counts.reduce((a, b) => a + b, 0);
    perModel[model] = { bare, withPrompt: bare + sysTokens * steps.length };
    log.write(clr.success('done') + '\n');
  }

  // ── Jev: sample real calls and read back the billed cost ──
  let jev = null;
  const sampleN = parseInt(opts.jevSample, 10) || 0;
  const apiKey = config.OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY;

  if (sampleN > 0 && apiKey) {
    log.write(clr.trace(`  sampling ${sampleN} real Jev calls... `));
    const stride = Math.max(1, Math.floor(steps.length / sampleN));
    const sample = steps.filter((_, i) => i % stride === 0).slice(0, sampleN);

    const measure = async (withPrompt) => {
      const rows = await mapPool(sample, 4, s =>
        fetch(JEV_ENDPOINT, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(buildBody(JEV_MODEL, s, withPrompt ? systemPrompt : null)),
        }).then(r => r.json()).then(r => r.usage ?? { input_tokens: 0, cost: 0 }));
      const mean = k => rows.reduce((a, r) => a + (r[k] ?? 0), 0) / rows.length;
      return { cost: mean('cost') * steps.length, tokens: mean('input_tokens') * steps.length };
    };

    const bare = await measure(false);
    const withPrompt = await measure(true);
    jev = { ...bare, withPromptCost: withPrompt.cost, withPromptTokens: withPrompt.tokens, sampled: sample.length * 2 };
    log.write(clr.success('done') + '\n');
  }

  // ── report ──
  log.info(`\nInput tokens per configuration (${steps.length} steps):\n`);
  log.info('  model                  no-prompt    with-prompt');
  for (const model of ANTHROPIC_MODELS) {
    const m = perModel[model];
    log.info(`  ${model.padEnd(20)} ${num(m.bare).padStart(11)} ${num(m.withPrompt).padStart(14)}`);
  }
  if (jev) {
    log.info(`  ${JEV_MODEL.padEnd(20)} ${num(jev.tokens).padStart(11)} ${num(jev.withPromptTokens).padStart(14)}   (extrapolated from ${jev.sampled} calls)`);
  }

  log.info('\nEstimated cost per configuration:\n');
  log.info('  model                  no-prompt    with-prompt          both');
  let sweep = 0;
  for (const model of ANTHROPIC_MODELS) {
    const m = perModel[model];
    const p = PRICING[model];
    if (!p) { log.info(`  ${model.padEnd(20)}  (no price in pricing.json)`); continue; }
    const outCost = (MAX_OUTPUT_TOKENS * steps.length / 1e6) * p.output;
    const a = (m.bare / 1e6) * p.input + outCost;
    const b = (m.withPrompt / 1e6) * p.input + outCost;
    log.info(`  ${model.padEnd(20)} ${usd(a).padStart(11)} ${usd(b).padStart(14)} ${usd(a + b).padStart(13)}`);
    if (SWEEP_MODELS.includes(model)) sweep += a + b;
  }
  if (jev) {
    log.info(`  ${JEV_MODEL.padEnd(20)} ${usd(jev.cost).padStart(11)} ${usd(jev.withPromptCost).padStart(14)} ${usd(jev.cost + jev.withPromptCost).padStart(13)}`);
    sweep += jev.cost + jev.withPromptCost;
  }

  log.info(`\n  Anthropic output tokens assume the ${MAX_OUTPUT_TOKENS}-token cap is hit every step (an upper`);
  log.info(`  bound; measured replies run ~5 tokens). ${JEV_SLUG} bills nothing for output.`);
  log.summary(`\nrun-eval.sh as configured (${SWEEP_MODELS.join(' + ')} + jev, both prompts): ${usd(sweep)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
