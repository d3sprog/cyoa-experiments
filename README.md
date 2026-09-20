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
cp config.js.example config.js   # add your API keys
```

`config.js` (gitignored) must export `ANTHROPIC_API_KEY` (for `score.js`) and
`OPENROUTER_API_KEY` (for `score-jev.js`). Either may be omitted if you only run
the other scorer; both also fall back to the identically-named environment variable.

## Scripts

### `score.js` — LLM evaluation

Walks ground-truth navigation chains from `data/eval-snippets.json`, asks the LLM for the
next step at each point, and reports how often it picks correctly. The LLM always follows
the correct path regardless of its answer, so each step is scored independently.

```
node score.js [options]

Options:
  -n, --count <n>             number of snippets to test (default: 3)
  -p, --provider <name>       filter to a specific provider
  -m, --model <name>          LLM model to use (default: claude-haiku-4-5)
  -s, --system-prompt <file>  path to a text file containing the system prompt
  -o, --output <dir>          write CSV results to this directory
  -r, --resume <file>         resume an interrupted run: skip already-scored chains
                              and append new rows to the existing CSV

Examples:
  node score.js -n 5
  node score.js -n 5 -p olympics
  node score.js -n 10 -p worldbank -m claude-sonnet-5
  node score.js -n 5 -p olympics -s prompts/default-prompt.txt
  node score.js -n 61 -s prompts/default-prompt.txt --output results
  node score.js -n 61 -s prompts/default-prompt.txt --resume results/run.csv
```

Omitting `-s` sends bare queries with no system prompt (useful as a baseline).
The default system prompt lives in `prompts/default-prompt.txt` and can be
copied and modified to experiment with different phrasings.

Options are capped at **255** when a member list is very large (e.g. the full athlete
roster) — that is Jev's per-question limit, and both scorers use it so every model sees
an identical menu. The correct option is always included in the sample. Only 15 of the
665 steps are affected; `--dry-run` walks every chain without calling any API and
reports which ones.

CSV files are named `{model}__{prompt}__{provider}__{timestamp}.csv` (a vendor prefix's
`/` is flattened to `-`, so `typesafe/jev-1.13` becomes `typesafe-jev-1.13`). One row per
chain:

| Column | Meaning |
|--------|---------|
| `snippet_id`, `snippet_title` | which gallery snippet the chain came from |
| `chain_index` | which chain within that snippet |
| `provider` | olympics / worldbank / expenditure / shared / drWho |
| `total_steps`, `correct_steps` | the accuracy numerator and denominator |
| `input_tokens`, `output_tokens` | tokens actually spent on that chain |

The token columns are what `results.ipynb` prices a run from — see **Cost** below.

### `score-jev.js` — Jev evaluation

Same evaluation, same CSV, against TypeSafe's **Jev** — a *System One* model that does
not generate text. Instead of a numbered menu and an integer reply, each step is posed
as a typed `choice` question and the answer comes back as a member name:

```
node score-jev.js [options]      # same flags as score.js
```

Jev is reached through OpenRouter's decisions endpoint
(`POST https://openrouter.ai/api/alpha/decisions`), so it needs `OPENROUTER_API_KEY`
rather than an Anthropic key. TypeSafe's own API accepts the same request body at
`https://api.typesafe.ai/v1/systemone`; set `JEV_ENDPOINT` to switch hosts.

One difference from `score.js` is worth keeping in mind when reading the numbers:

- **Interface.** Jev picks from named options, so the integer-parse and off-by-one
  failure modes simply do not exist for it. A gap between the two families is partly
  interface, not only model capability. The option cap is shared (255), so menu size
  is not a confound.
Since Jev has no system-prompt concept, `-s` puts the prompt text into the question's
structured `instructions` as a `guidance` field instead.

### `estimate-cost.js` — What a run will cost

Walks the same chains the scorers do and builds the exact prompt for every step, then
prices it. Anthropic input tokens are counted with `messages.count_tokens`, which is
free and exact; Jev is measured by making a few real decisions calls and reading back
`usage.cost`, which OpenRouter reports per request. Nothing is scored.

```
node estimate-cost.js [-n 61] [-p provider] [--jev-sample 15]
```

This is the estimate *beforehand*. Once a run has happened, `results.ipynb` prices it
exactly from the `input_tokens` / `output_tokens` columns in the CSV — no estimation
involved. Both read their prices from `pricing.json`, so they cannot disagree.

Costs about a tenth of a cent to run (the Jev sampling; pass `--jev-sample 0` to skip
it entirely). Measured for the current 61-snippet / 665-step configuration:

| Model | no-prompt | with-prompt | both |
|-------|-----------|-------------|------|
| `claude-haiku-4-5` | $0.31 | $0.89 | $1.20 |
| `claude-sonnet-5` | $0.81 | $2.39 | $3.20 |
| `claude-opus-5` | $2.02 | $5.97 | $7.99 |
| `typesafe/jev-1.13` | $0.02 | $0.04 | $0.06 |

A full `run-eval.sh` (haiku + sonnet-5 + jev, both prompts) is about **$4.46**. The
system prompt dominates: it is ~870 tokens sent on every one of the 665 steps, so the
with-prompt runs cost roughly 3x the bare ones. Jev is ~50x cheaper than Sonnet 5 for
the same work, since it bills $0.042/Mtok input and nothing for output.

### `pricing.json` — Shared price list

USD per 1M tokens, keyed by the model slug that appears in result filenames. Read by
`estimate-cost.js` and by `results.ipynb`, so the estimate and the actual both come from
one place. Prices drift — check them against the
[Anthropic pricing page](https://docs.claude.com/en/docs/about-claude/pricing) and
[OpenRouter](https://openrouter.ai/typesafe/jev-1.13) if the numbers look off, and note
the `_updated` field.

### `run-eval.sh` — Full evaluation across all configurations

Runs the scorers across six configurations (haiku/sonnet/jev × no-prompt/with-prompt)
for all 61 snippets. Automatically detects partial CSVs in `results/` and resumes
them rather than starting over.

```
bash run-eval.sh
```

### `extract.js` — Ground-truth extraction

Parses `data/snippets-thegamma.json` (gallery snippet data) and extracts navigation chains
into `data/eval-snippets.json`. Run this if the source snippets change.

```
node extract.js
```

For `shared` provider chains, adds a `hint` field (e.g. `"Use data source from May 2017
named 'Turing People'"`) that is passed to the LLM to avoid impossible date-guessing.
For snippets with multiple chains, merges per-chain hints from `data/extra-hints.json`
to help the LLM distinguish between chains (e.g. "This chain gets data for China").

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
score.js          Evaluation entry point — Anthropic models
score-jev.js      Evaluation entry point — Jev, via OpenRouter
runner.js         Shared chain walk, CSV writing and console output
jev-test.js       Standalone Jev API check (no server needed)
estimate-cost.js  Prices a run before it happens, without scoring it
pricing.json      USD per 1M tokens, shared by the estimator and the notebook
extract.js        Extracts chains from gallery snippets
verifier.js       Verifies chains against the live server
cyoa.js           Interactive member-tree explorer
run-eval.sh       Runs all 6 configurations end-to-end

providers.js      Shared provider setup, type resolution helpers
log.js            Coloured logging helpers (clr, log)
config.js         API keys — gitignored, create manually

data/
  snippets-thegamma.json   Raw gallery snippet data (source)
  eval-snippets.json       Extracted chains used by score/verifier
  extra-hints.json         Handwritten per-chain hints for multi-chain snippets

prompts/
  default-prompt.txt       Default system prompt with per-provider navigation rules

results/
  *.csv                    Result CSVs from evaluation runs
  results.ipynb            Jupyter notebook with analysis and charts
  *.png                    Charts exported by the notebook

paper/
  paper-vlhcc.tex          VLHcc paper describing The Gamma providers
  paper-cyoa.tex           Related paper; used to inform the system prompt
```

## Results

All 61 snippets, 665 steps, every model capped at 255 options so the menus are identical.

| Provider    | Haiku | Haiku+P | Jev  | Jev+P | Sonnet | Sonnet+P |
|-------------|-------|---------|------|-------|--------|----------|
| olympics    | 45%   | 57%     | 46%  | 67%   | 51%    | 76%      |
| worldbank   | 65%   | 73%     | 76%  | 72%   | 77%    | 83%      |
| shared      | 56%   | 69%     | 52%  | 69%   | 52%    | 74%      |
| expenditure | 44%   | 50%     | 50%  | 83%   | 50%    | 72%      |
| drWho       | 41%   | 65%     | 41%  | 71%   | 47%    | 76%      |
| **overall** | **54%** | **66%** | **54%** | **69%** | **56%** | **76%** |

"+P" is with `prompts/default-prompt.txt`. `expenditure` and `drWho` have few chains, so their
per-provider figures are noisy; they are included in `overall`.

### Cost

| Config | Accuracy | Input tokens | Output tokens | Cost |
|--------|----------|--------------|---------------|------|
| `claude-sonnet-5` +P | 76.1% | 1,139,513 | 2,047 | $2.2995 |
| `typesafe-jev-1.13` +P | 69.5% | 1,030,484 | 249,076 | **$0.0433** |
| `claude-haiku-4-5` +P | 65.9% | 838,039 | 3,743 | $0.8568 |
| `claude-sonnet-5` | 55.6% | 350,566 | 2,008 | $0.7212 |
| `typesafe-jev-1.13` | 54.0% | 477,265 | 247,832 | $0.0200 |
| `claude-haiku-4-5` | 53.8% | 259,989 | 3,446 | $0.2772 |

Two things stand out. **The system prompt is worth more than the model**: every model sits at
54-56% without it, and gains 12-20 points with it. And **Jev lands between Haiku and Sonnet on
accuracy at 1/20th of Haiku's cost and 1/53rd of Sonnet's** — it bills $0.042/Mtok for input
and nothing for output, which is why its quarter-million output tokens are free.

Total spend for the whole sweep was $4.22, against a $4.46 prediction from `estimate-cost.js`.

Earlier numbers — `claude-haiku-4-5` and `claude-opus-4-7` at a 500-option cap — are kept in
`results/legacy-500-cap/` and are not comparable with these.

See `results.ipynb` for the full analysis: prompt lift by provider, accuracy vs chain length,
hardest snippets, cost per configuration, and a per-chain Haiku vs Sonnet comparison.
