import Anthropic from '@anthropic-ai/sdk';
import { ANTHROPIC_API_KEY } from './config.js';
import { createInterface } from 'readline/promises';
import { createAllProviders, resolveType, getGlobals } from './providers.js';

const SOURCES = [
  { name: 'olympics',    label: 'Olympics — medal data (athlete, discipline, sport, medal, year)' },
  { name: 'worldbank',   label: 'World Bank — economic indicators (country, topic, indicator, year)' },
  { name: 'drWho',       label: 'Doctor Who — character and episode graph data' },
  { name: 'expenditure', label: 'UK Government expenditure — by service, sub-service, year, account' },
  { name: 'shared',      label: 'Shared datasets — uploaded CSVs browsable by date and title' },
];

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const rl = createInterface({ input: process.stdin, output: process.stdout });

// Type tags: 0=Delayed, 1=Object, 2=Primitive, 3=List, 4=Method, 5=Any
// PrimitiveType tags: 0=Number, 1=Date, 2=String, 3=Bool, 4=Unit
function typeName(typ) {
  if (!typ) return 'unknown';
  switch (typ.tag) {
    case 1: return `object (${typ.fields[0].Members.length} members)`;
    case 2: return ['number','date','string','bool','unit'][typ.fields[0]] ?? 'primitive';
    case 3: return 'list';
    case 4: return 'method';
    case 5: return 'any';
    default: return `type(${typ.tag})`;
  }
}

async function askLLM(query, path, members) {
  const pathStr = path.length ? path.map(s => `"${s}"`).join('.') : '(not started)';
  const options = members.map((m, i) => `${i + 1}. ${m.Name}`).join('\n');

  const prompt =
`You are helping user to complete a task in an interactive programming environment. The user's query is: "${query}"

The query built so far is: ${pathStr}.

The environment offers the user possible options. Choose an option that should be applied to the current dataset:

${options}

You should answer with the number of the option and no further explanation.`;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 16,
    messages: [{ role: 'user', content: prompt }],
  });

  const num = parseInt(response.content[0].text.trim(), 10);
  return isNaN(num) ? null : num - 1; // 0-based
}

async function pickStep(query, path, members, header) {
  process.stdout.write('Asking LLM...');
  const suggestion = await askLLM(query, path, members);
  process.stdout.write('\r             \r');

  if (header) console.log(header);
  members.forEach((m, i) => {
    const hint = i === suggestion ? '  <-- LLM' : '';
    console.log(`  ${i + 1}. ${m.Name}${hint}`);
  });

  while (true) {
    const answer = await rl.question('\nSelect option (or q to quit): ');
    if (answer.trim().toLowerCase() === 'q') return null;
    const idx = parseInt(answer.trim(), 10) - 1;
    if (!isNaN(idx) && idx >= 0 && idx < members.length) return idx;
    console.log('Invalid choice, try again');
  }
}

function printSeries(series) {
  return new Promise(resolve => {
    series.data.Then(pairs => {
      // Fable 4 tuples compile as [k, v] arrays
      const limit = Math.min(pairs.length, 20);
      console.log(`\nSeries "${series.seriesName}": ${series.keyName} → ${series.valueName}`);
      for (let i = 0; i < limit; i++) {
        console.log(`  ${pairs[i][0]}: ${pairs[i][1]}`);
      }
      if (pairs.length > limit) console.log(`  ... (${pairs.length - limit} more)`);
      resolve();
    });
  });
}

async function main() {
  const query = await rl.question('Enter your query: ');
  console.log();

  // Step 1: pick data source
  const srcIdx = await pickStep(
    query, [],
    SOURCES.map(s => ({ Name: s.label })),
    'Choose a data source:'
  );
  if (srcIdx === null) { rl.close(); return; }
  const source = SOURCES[srcIdx];
  console.log();

  const p = createAllProviders();

  const entities = await getGlobals(p);
  let entity = null;
  for (const e of entities) {
    if (e.Kind.fields[0].Name === source.name) { entity = e; break; }
  }
  if (!entity) {
    console.error(`Provider '${source.name}' not found in globals`);
    rl.close();
    return;
  }

  let typ = await resolveType(entity.Type);
  const path = [source.name];

  // Step 2+: navigate type tree
  while (typ && typ.tag === 1) {
    if (typ.fields[0].seriesName !== undefined) {
      await printSeries(typ.fields[0]);
      break;
    }
    const members = typ.fields[0].Members;
    if (!members.length) break;

    const header = `Path: ${path.join(' > ')}  [${typeName(typ)}]\nOptions:`;
    const idx = await pickStep(query, path, members, header);
    if (idx === null) break;

    path.push(members[idx].Name);
    typ = await resolveType(members[idx].Type);
    console.log();
  }

  console.log(`\nFinal query: ${path.join(' > ')}`);
  rl.close();
}

main().catch(e => { console.error(e); rl.close(); process.exit(1); });
