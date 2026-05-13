# Choose-your-own-adventure experiments

Experiments evaluating how well an LLM can navigate [The Gamma](https://thegamma.net) type
provider member trees — i.e., whether it can correctly recommend the next step when building
a data query interactively, one member pick at a time.

## Background

The Gamma exposes data through a type provider protocol: querying data means navigating a tree
of named members (filter, group, sort, pick a country, pick an indicator, …). The interactive
editor presents the available members at each step and the user picks one. This project asks:
*can an LLM make those picks correctly, given the query goal?*

There are five provider types, each with different navigation patterns:

| Provider | Data | Navigation style |
|----------|------|-----------------|
| `olympics` | Olympic medal data | Tabular: filter → group → sort → paging → get series |
| `worldbank` | World Bank indicators | Data cube: byCountry/byYear → value → topic → indicator |
| `expenditure` | UK government spending | Data cube: byService/byYear → sub-service → indicator |
| `shared` | Uploaded CSV datasets | Browse by date/tag → pick dataset → tabular ops |
| `drWho` | Doctor Who graph | Graph navigation → `explore` → tabular ops |

## Setup

Requires Node.js and a running instance of
[thegamma-unified](../thegamma-unified/) on `http://localhost:5000`.

```
npm install
cp config.js.example config.js   # add your Anthropic API key
```

`config.js` (gitignored) must export `ANTHROPIC_API_KEY`.

## Scripts

### `score.js` — LLM evaluation

Walks ground-truth navigation chains from `data/eval-snippets.json`, asks the LLM for the
next step at each point, and reports how often it picks correctly. The LLM always follows
the correct path regardless of its answer, so each step is scored independently.

```
node score.js [options]

Options:
  -n, --count <n>        number of snippets to test (default: 3)
  -p, --provider <name>  filter to a specific provider
  -m, --model <name>     LLM model to use (default: claude-haiku-4-5)
  --no-system-prompt     disable the system prompt (send bare queries)

Examples:
  node score.js -n 5
  node score.js -n 5 -p olympics
  node score.js -n 10 -p worldbank -m claude-sonnet-4-6
  node score.js -n 5 -p olympics --no-system-prompt
```

A system prompt with per-provider navigation rules is included by default.
Use `--no-system-prompt` to measure the baseline without it.

### `extract.js` — Ground-truth extraction

Parses `data/snippets-thegamma.json` (gallery snippet data) and extracts navigation chains
into `data/eval-snippets.json`. Run this if the source snippets change.

```
node extract.js
```

For `shared` provider chains, adds a `hint` field (e.g. `"Use data source from May 2017
named 'Turing People'"`) that is passed to the LLM to avoid impossible date-guessing.

### `verifier.js` — Chain integrity check

Verifies that every chain in `eval-snippets.json` can be fully traversed against the live
providers. Useful after changes to the server or the snippet data.

```
node verifier.js
```

Reports `OK` or `FAIL` per chain with details on where navigation breaks.

### `cyoa.js` — Interactive explorer

Interactive choose-your-own-adventure navigator: pick a data source, then step through the
member tree with LLM suggestions highlighted. Useful for manual exploration.

```
node cyoa.js
```

## Project structure

```
score.js          Main evaluation script
extract.js        Extracts chains from gallery snippets
verifier.js       Verifies chains against the live server
cyoa.js           Interactive member-tree explorer

providers.js      Shared provider setup, type resolution helpers
log.js            Coloured logging helpers (clr, log)
config.js         API key — gitignored, create manually

data/
  snippets-thegamma.json   Raw gallery snippet data (source)
  eval-snippets.json       Extracted chains used by score/verifier

paper/
  paper-vlhcc.tex          VLHcc paper describing The Gamma providers
  paper-cyoa.tex           Related paper; used to inform the system prompt
```

## Results

Approximate LLM accuracy (claude-haiku-4-5, with system prompt) on the first 20 snippets:

| Provider    | Accuracy |
|-------------|----------|
| olympics    | ~57%     |
| worldbank   | ~67%     |
| expenditure | ~61%     |
| shared      | ~69%     |
| drWho       | ~71%     |
| **overall** | **~59%** |

Without the system prompt the overall baseline is roughly 40–45%.
