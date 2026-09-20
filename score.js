import { readFileSync } from 'fs';
import { basename, extname } from 'path';
import { pathToFileURL } from 'url';
import { Command } from 'commander';
import Anthropic from '@anthropic-ai/sdk';
import { ANTHROPIC_API_KEY } from './config.js';
import { runEval, withRetry, MAX_OPTIONS } from './runner.js';

// ── constants ─────────────────────────────────────────────────────────────────

const KNOWN_MODELS = [
  'claude-haiku-4-5',
  'claude-sonnet-5',
  'claude-opus-5',
  'claude-sonnet-4-6',
  'claude-opus-4-7',
];

// Sonnet 5 and Opus 5 run adaptive thinking when `thinking` is omitted, which would
// burn the whole max_tokens budget before any answer text appears — every step would
// then parse as NaN and score wrong. Picking a menu item is a single-shot decision,
// so thinking is switched off explicitly. Older models do not think unless asked.
const THINKS_BY_DEFAULT = /^claude-(sonnet|opus)-5/;

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ── LLM ───────────────────────────────────────────────────────────────────────

function classifyError(e) {
  const isRateLimit = e instanceof Anthropic.RateLimitError || e?.status === 429;
  const isTransient = e instanceof Anthropic.APIConnectionError || (e?.status ?? 0) >= 500;
  return {
    retryable: isRateLimit || isTransient,
    retryAfterMs: e?.headers?.['retry-after'] ? parseInt(e.headers['retry-after']) * 1000 : null,
    label: isRateLimit ? 'rate limited' : 'API error',
  };
}

// Exported so estimate-cost.js prices the exact prompt this scorer sends.
export function buildPrompt({ title, description, hint, chainHint, path, members }) {
  const pathStr = path.length > 1
    ? path.slice(1).map(s => `"${s}"`).join(' > ')
    : '(just started)';
  const options = members.map((m, i) => `${i + 1}. ${m.Name ?? m}`).join('\n');

  return `Goal: ${title}
${description ? `Description: ${description}\n` : ''}${chainHint ? `Context: ${chainHint}\n` : ''}${hint ? `Hint: ${hint}\n` : ''}
Steps chosen so far: ${pathStr}

Choose the next step from these options:
${options}

Reply with just the number of the best option.`;
}

function createAsk(model, systemPrompt) {
  return async (step) => {
    const response = await withRetry(() => client.messages.create({
      model,
      max_tokens: 16,
      ...(THINKS_BY_DEFAULT.test(model) ? { thinking: { type: 'disabled' } } : {}),
      ...(systemPrompt ? { system: systemPrompt } : {}),
      messages: [{ role: 'user', content: buildPrompt(step) }],
    }), classifyError);

    const num = parseInt(response.content[0].text.trim(), 10);
    return {
      index: isNaN(num) ? null : num - 1, // 0-based
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  };
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const program = new Command();
  program
    .name('score')
    .description('Score LLM accuracy at navigating The Gamma type providers')
    .option('-n, --count <n>', 'number of snippets to test', '3')
    .option('-p, --provider <name>', 'filter to a specific provider (olympics, worldbank, expenditure, drwho, shared)')
    .option('-m, --model <name>', 'LLM model to use', 'claude-haiku-4-5')
    .option('-s, --system-prompt <file>', 'path to a text file containing the system prompt')
    .option('-o, --output <dir>', 'directory to write CSV results to (created if absent)')
    .option('-r, --resume <file>', 'resume an interrupted run: skip already-scored chains and append to this CSV')
    .option('--dry-run', 'walk the chains and report option-list sizes without calling the API')
    .addHelpText('after', `
Known models:
  ${KNOWN_MODELS.join('\n  ')}

Examples:
  node score.js -n 5
  node score.js -n 5 -p olympics
  node score.js -n 10 -p worldbank -m claude-sonnet-5
  node score.js -n 5 -p olympics -s prompts/default-prompt.txt
  node score.js -n 20 -s prompts/default-prompt.txt --output results
  node score.js -n 20 -s prompts/default-prompt.txt --resume results/run.csv
  node score.js -n 61 --dry-run`);

  if (process.argv.length <= 2) { program.help(); }

  program.parse();
  const opts = program.opts();

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

// Only run when invoked directly; estimate-cost.js imports buildPrompt from here.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e); process.exit(1); });
}
