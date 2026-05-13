import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROVIDERS = ['olympics', 'worldbank', 'drWho', 'expenditure', 'shared'];

// Collect all let-binding RHS lines from code.
// Returns array of flat chain strings (whitespace normalised, one per binding).
function extractBindings(code) {
  const lines = code.split('\n');
  const bindings = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/^let\s+\w+\s*=\s*(.*)/);
    if (m) {
      let text = m[1].trim();
      i++;
      while (i < lines.length) {
        const trimmed = lines[i].trim();
        if (trimmed === '') break;
        if (/^(let\s|chart\.|youguess\.|compost\.|table\.|youdraw\.|\/\/)/.test(trimmed)) break;
        if (lines[i].match(/^\s/) || trimmed.startsWith('.')) {
          text += ' ' + trimmed;
          i++;
        } else {
          break;
        }
      }
      bindings.push(text.trim());
    } else {
      i++;
    }
  }

  return bindings;
}

function getProvider(chain) {
  for (const p of PROVIDERS)
    if (chain.startsWith(p + '.') || chain.startsWith(p + ' ') || chain === p) return p;
  return null;
}

// Parse a normalised chain string into an array of member name steps.
// e.g. "olympics.'filter data'.'Games is'.then.paging.take(8)" ->
//   ["olympics", "filter data", "Games is", "then", "paging", "take(8)"]
function parseSteps(chain) {
  // Remove spaces around dots so "byCountry .'United States'" -> "byCountry.'United States'"
  const flat = chain.replace(/\s*\.\s*/g, '.');
  const steps = [];

  const firstDot = flat.indexOf('.');
  steps.push(firstDot < 0 ? flat : flat.slice(0, firstDot));

  const re = /\.(?:'([^']+)'(\([^)]*\))?|(\w+(?:\([^)]*\))?))/g;
  re.lastIndex = firstDot < 0 ? flat.length : firstDot;
  let m;
  while ((m = re.exec(flat)) !== null)
    steps.push(m[1] !== undefined ? m[1] + (m[2] ?? '') : m[3]);

  return steps;
}

const snippets = JSON.parse(
  readFileSync(join(__dirname, 'data', 'snippets-thegamma.json'), 'utf8')
);

const results = [];
let skippedNoProvider = 0, skippedHidden = 0;

for (const s of snippets) {
  if (s.hidden) { skippedHidden++; continue; }

  const providerChains = extractBindings(s.code).filter(c => getProvider(c));

  if (providerChains.length === 0) { skippedNoProvider++; continue; }

  results.push({
    id: s.id,
    title: s.title,
    description: s.description,
    chains: providerChains.map(c => {
      const provider = getProvider(c);
      const steps = parseSteps(c);
      const chain = { provider, steps };
      if (provider === 'shared' && steps.length >= 4 && (steps[1] === 'by date' || steps[1] === 'by tag')) {
        chain.hint = `Use data source from ${steps[2]} named '${steps[3]}'`;
      }
      return chain;
    }),
  });
}

console.log(`Extracted: ${results.length}  skipped: ${skippedNoProvider} no-provider, ${skippedHidden} hidden\n`);
for (const r of results) {
  console.log(`#${r.id} ${r.title}`);
  for (const c of r.chains)
    console.log(`  [${c.provider}] ${c.steps.join(' > ')}`);
  console.log();
}

writeFileSync(
  join(__dirname, 'data', 'eval-snippets.json'),
  JSON.stringify(results, null, 2)
);
console.log('Written to data/eval-snippets.json');
