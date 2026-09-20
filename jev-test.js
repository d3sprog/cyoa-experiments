// Minimal standalone check of the Jev decisions API, called through OpenRouter.
// No Gamma providers and no local server — the option lists below are hand-copied
// approximations of real olympics member menus, enough to confirm that:
//   1. auth and the request shape work
//   2. awkward member names ("Rio (2016)", "take(8)") survive as criteria keys
//   3. the answer comes back as a name we can map to an index
//
// Usage: node jev-test.js

import * as config from './config.js';

// ── setup ─────────────────────────────────────────────────────────────────────

// OpenRouter exposes Jev on a separate "decisions" endpoint rather than through
// chat completions. TypeSafe's own API takes the same body at
// https://api.typesafe.ai/v1/systemone, so this is switchable if we get direct access.
const ENDPOINT = process.env.JEV_ENDPOINT ?? 'https://openrouter.ai/api/alpha/decisions';
const MODEL = process.env.JEV_MODEL ?? 'typesafe/jev-1.13';

const apiKey = config.OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY;

if (!apiKey) {
  console.error('No OpenRouter API key found.\n');
  console.error('Add this line to config.js (gitignored):');
  console.error("  export const OPENROUTER_API_KEY = 'your-key-here';");
  console.error('\nor set the OPENROUTER_API_KEY environment variable.');
  process.exit(1);
}

const TASK = 'Which of the available options should be picked next to build the query described in the state?';

// ── test cases ────────────────────────────────────────────────────────────────

const SNIPPET = {
  goal: 'Top medalists at Rio 2016',
  description: 'Top medalists from Rio 2016 based on the number of gold medals. The snippet uses the pivot type provider to aggregate the data and shows a simple bar chart with the results.',
};

const CASES = [
  {
    label: 'step 1 — pick an operation',
    steps_so_far: [],
    expect: 'filter data',
    options: [
      'filter data', 'group data', 'sort data', 'drop columns',
      'paging', 'windowing', 'get series', 'get the data',
    ],
  },
  {
    label: 'step 2 — pick a filter field',
    steps_so_far: ['filter data'],
    expect: 'Games is',
    options: [
      'Games is', 'Team is', 'Athlete is', 'Sport is', 'Discipline is',
      'Event is', 'Medal is', 'Gender is', 'then',
    ],
  },
  {
    label: 'step 3 — pick a value (awkward names)',
    steps_so_far: ['filter data', 'Games is'],
    expect: 'Rio (2016)',
    options: [
      'Rio (2016)', 'London (2012)', 'Beijing (2008)', 'Athens (2004)',
      'Sydney (2000)', 'Atlanta (1996)', 'Barcelona (1992)',
    ],
  },
  {
    label: 'step 13 — pick a paging limit',
    steps_so_far: ['filter data', 'Games is', 'Rio (2016)', 'then', 'group data',
                   'by Athlete', 'sum Gold', 'then', 'sort data',
                   'by Gold descending', 'then', 'paging'],
    expect: 'take(8)',
    options: ['take(8)', 'take(10)', 'take(100)', 'skip(1)', 'then'],
  },
];

// ── run ───────────────────────────────────────────────────────────────────────

async function ask(testCase) {
  const criteria = Object.fromEntries(testCase.options.map(name => [name, null]));

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      state: {
        goal: SNIPPET.goal,
        description: SNIPPET.description,
        steps_so_far: testCase.steps_so_far,
      },
      questions: {
        next_step: { type: 'choice', instructions: TASK, criteria },
      },
    }),
  });

  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body}`);
  return JSON.parse(body);
}

const fmt = n => (typeof n === 'number' ? n.toFixed(3) : 'n/a');

async function main() {
  console.log(`endpoint: ${ENDPOINT}`);
  console.log(`model:    ${MODEL}\n`);

  let correct = 0, inputTokens = 0, cost = 0;

  for (const [i, testCase] of CASES.entries()) {
    const res = await ask(testCase);
    const answer = res.answers.next_step;
    const idx = testCase.options.indexOf(answer.choice);
    const ok = answer.choice === testCase.expect;
    if (ok) correct++;
    inputTokens += res.usage?.input_tokens ?? 0;
    cost += res.usage?.cost ?? 0;

    console.log(`${ok ? '✓' : '✗'} ${testCase.label}`);
    console.log(`  expected  : ${testCase.expect}`);
    console.log(`  answered  : ${answer.choice}  (index ${idx} of ${testCase.options.length})`);
    console.log(`  confidence: ${fmt(answer.confidence)}   p(answered)=${fmt(answer.probabilities?.[answer.choice])}   p(expected)=${fmt(answer.probabilities?.[testCase.expect])}`);

    // Dump one full answer so we can see exactly what the shape is
    if (i === 0) {
      console.log(`  raw answer: ${JSON.stringify(answer)}`);
      console.log(`  raw usage : ${JSON.stringify(res.usage)}`);
    }
    console.log();
  }

  console.log(`${correct}/${CASES.length} correct, ${inputTokens} input tokens, cost $${cost.toFixed(6)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
