import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Command } from 'commander';
import Anthropic from '@anthropic-ai/sdk';
import { ANTHROPIC_API_KEY } from './config.js';
import { createAllProviders, resolveType, resolveMethodReturn, getGlobals } from './providers.js';
import { log, clr } from './log.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── constants ─────────────────────────────────────────────────────────────────

const SERIES_OPS = new Set([
  'get series', 'get the data',
  'with key', 'and value',
  'take', 'skip', 'shuffle', 'reverse', 'sortKeys', 'sortValues',
  'setProperties', 'map', 'append',
]);

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
let MODEL = 'claude-haiku-4-5';

// ── retry wrapper ─────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function withRetry(fn, maxAttempts = 5) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const isRateLimit = e instanceof Anthropic.RateLimitError || e?.status === 429;
      const isTransient = e instanceof Anthropic.APIConnectionError || (e?.status ?? 0) >= 500;

      if (attempt === maxAttempts || (!isRateLimit && !isTransient)) throw e;

      // Honour the retry-after header when present, otherwise exponential backoff
      const retryAfterMs = e?.headers?.['retry-after']
        ? parseInt(e.headers['retry-after']) * 1000
        : Math.min(2 ** attempt * 1000, 60_000);
      const jitter = Math.random() * 1000;
      const delay = Math.round(retryAfterMs + jitter);

      log.trace(`  ${isRateLimit ? 'rate limited' : 'API error'} — waiting ${(delay / 1000).toFixed(1)}s then retry ${attempt}/${maxAttempts - 1}...`);
      await sleep(delay);
    }
  }
}

// ── LLM ───────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
`You are helping complete data queries in The Gamma, an interactive data exploration environment.
Queries are built step-by-step by picking members from a menu.

## Tabular providers (olympics, shared datasets)
Operations available: "filter data", "group data", "sort data", "drop columns", "paging", "windowing", "get series", "get the data".
- After you specify an operation and ALL its parameters, pick "then" to finish that operation and start the next one. NEVER pick "preview" — it does not exist as a valid continuation; "then" is what you want.
- "paging" must be selected BEFORE "take(n)" or "skip(n)". Pick "paging" first, then the specific limit.
- "get series" produces chart data: follow it with "with key FIELD" then "and value FIELD". Use it when the goal is a chart or line graph.
- "get the data" retrieves a flat table. Use it only when the goal is tabular output, NOT for charts.
- For multi-column sort, after "sort data" pick the primary column+direction, then optionally "and by X descending/ascending" for secondary columns, then "then".
- For "shared" datasets: browse via "by date" (most common) or "by tag", then pick the specific dataset by name.

## Data cube providers (worldbank, expenditure)
Navigation: choose a primary dimension first, then the specific value, then the category, then the indicator.
- worldbank dimensions: if the goal names a specific country and wants data over time → pick "byCountry"; if the goal names a specific year and wants a cross-country comparison → pick "byYear". Example: "CO2 emissions of USA" → byCountry; "top economies in 2012" → byYear.
- expenditure dimensions: "byService" = query is about a specific spending area; "byYear" = query is about all services in a specific year.
- expenditure sub-navigation: after a service pick "bySubService" (NOT "bySubServiceComponents") to drill into sub-categories.
- expenditure scaling: "inTermsOf" → then "GDP", "Adjusted", or "Cash" to normalise the values.
- After picking an indicator the result is a time series. "take(n)" = keep the first n data points (most recent years when data is chronological). "sortValues(false)" = sort by value highest-first, "sortValues(true)" = lowest-first. "sortKeys" = sort alphabetically by label — avoid it unless explicitly needed. Pick sort BEFORE take.

## Graph provider (drWho)
Navigation: start with a node type (Character, Species, Episode, …), pick a specific node (e.g., "Doctor"), then navigate outward via relationship labels (ENEMY_OF, COMPANION_OF, APPEARED_IN, …).
- "[any]" is a wildcard matching any connected node. Pick it whenever the goal doesn't require a specific named entity. It always appears as one of the options — look for it explicitly.
- "explore_properties" opens the properties of the currently-reached nodes (use it to access node attributes like name, actor, year).
- "explore" switches to full tabular mode where group/sort/filter apply. Column names have numeric prefixes (e.g., "1-name", "2-name") that reflect the graph path depth.
- Once in tabular mode, follow the tabular provider rules above (use "then" after operations, use "paging" before "take", etc.).
- Column names after "explore" have numeric depth prefixes: "1-name" = name of the first node in your path, "2-name" = name of the second node, etc. When grouping, use the column that matches the node you want to count or aggregate over.`;

async function askLLM(title, description, hint, path, members, useSystemPrompt) {
  const pathStr = path.length > 1
    ? path.slice(1).map(s => `"${s}"`).join(' > ')
    : '(just started)';
  const options = members.map((m, i) => `${i + 1}. ${m.Name}`).join('\n');

  const prompt =
`Goal: ${title}
${description ? `Description: ${description}\n` : ''}${hint ? `Hint: ${hint}\n` : ''}
Steps chosen so far: ${pathStr}

Choose the next step from these options:
${options}

Reply with just the number of the best option.`;

  const response = await withRetry(() => client.messages.create({
    model: MODEL,
    max_tokens: 16,
    ...(useSystemPrompt ? { system: SYSTEM_PROMPT } : {}),
    messages: [{ role: 'user', content: prompt }],
  }));

  const num = parseInt(response.content[0].text.trim(), 10);
  return isNaN(num) ? null : num - 1; // 0-based
}

// ── scoring (async generator — yields one result per scored step) ─────────────

async function* scoreChain(entities, snippet, chain, useSystemPrompt) {
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

    // Signal that we're about to ask, so the caller can show a spinner
    yield { pending: true, step, memberCount: members.length };

    const llmIdx = await askLLM(snippet.title, snippet.description, chain.hint ?? null, path, members, useSystemPrompt);
    const correct = llmIdx === truthIdx;
    const llmPick = llmIdx !== null ? members[llmIdx]?.Name ?? null : null;

    yield { pending: false, step, llmPick, correct };

    path.push(members[truthIdx].Name);
    typ = members[truthIdx].Type;
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

const KNOWN_MODELS = [
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-5',
  'claude-sonnet-4-6',
  'claude-opus-4-7',
];

async function main() {
  const program = new Command();
  program
    .name('score')
    .description('Score LLM accuracy at navigating The Gamma type providers')
    .option('-n, --count <n>', 'number of snippets to test', '3')
    .option('-p, --provider <name>', 'filter to a specific provider (olympics, worldbank, expenditure, drwho, shared)')
    .option('-m, --model <name>', 'LLM model to use', 'claude-haiku-4-5')
    .option('--no-system-prompt', 'disable the system prompt (send bare queries)')
    .addHelpText('after', `
Known models:
  ${KNOWN_MODELS.join('\n  ')}

Examples:
  node score.js -n 5
  node score.js -n 5 -p olympics
  node score.js -n 10 -p worldbank -m claude-sonnet-4-6
  node score.js -n 5 -p olympics --no-system-prompt`);

  if (process.argv.length <= 2) { program.help(); }

  program.parse();
  const opts = program.opts();

  MODEL = opts.model;
  const useSystemPrompt = opts.systemPrompt;

  log.trace('Setting up providers...');
  const p = createAllProviders();
  const entities = await getGlobals(p);
  log.trace('Providers ready.\n');

  const snippets = JSON.parse(
    readFileSync(join(__dirname, 'data', 'eval-snippets.json'), 'utf8')
  );

  const count = parseInt(opts.count, 10) || 3;
  const providerFilter = opts.provider?.toLowerCase() ?? null;

  const testSnippets = snippets
    .map(s => ({
      ...s,
      chains: providerFilter
        ? s.chains.filter(ch => ch.provider.toLowerCase() === providerFilter)
        : s.chains,
    }))
    .filter(s => s.chains.length > 0)
    .slice(0, count);

  log.trace(`Model: ${MODEL}   System prompt: ${useSystemPrompt ? 'on' : 'off'}${providerFilter ? `   Provider: ${providerFilter}   ${testSnippets.length} snippet(s) matched` : ''}\n`);

  let grandTotal = 0, grandCorrect = 0;

  for (const snippet of testSnippets) {
    log.header(`#${snippet.id}: ${snippet.title}`);

    for (const chain of snippet.chains) {
      log.trace(`  [${chain.provider}] ${chain.steps.length - 1} steps to score`);

      let chainTotal = 0, chainCorrect = 0;

      for await (const ev of scoreChain(entities, snippet, chain, useSystemPrompt)) {
        if (ev.pending) {
          log.write(clr.trace(`    "${ev.step}" (${ev.memberCount} options)... `));
          continue;
        }

        if (ev.correct) {
          log.write(clr.success('✓') + '\n');
        } else {
          log.write(clr.fail('✗') + clr.trace(`  ← LLM picked "${ev.llmPick}"`) + '\n');
        }

        chainTotal++;
        if (ev.correct) chainCorrect++;
      }

      const pct = chainTotal > 0 ? Math.round(100 * chainCorrect / chainTotal) : 0;
      const score = `  ${chainCorrect}/${chainTotal} (${pct}%)`;
      log.info(pct >= 70 ? clr.success(score) : pct >= 40 ? clr.warn(score) : clr.fail(score));

      grandTotal += chainTotal;
      grandCorrect += chainCorrect;
    }

    log.info('');
  }

  const grandPct = grandTotal > 0 ? Math.round(100 * grandCorrect / grandTotal) : 0;
  const summary = `${grandCorrect}/${grandTotal} steps correct (${grandPct}%)`;
  const colouredSummary = grandPct >= 70 ? clr.success(summary) : grandPct >= 40 ? clr.warn(summary) : clr.fail(summary);
  log.summary(`Overall: ${colouredSummary}`);
}

main().catch(e => { console.error(e); process.exit(1); });
