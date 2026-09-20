# Per-step ranking log for Jev runs

> Supersedes the earlier "Add Jev as a model" plan, which is complete: `score-jev.js`,
> `runner.js`, the shared 255 cap, token columns, `pricing.json` and `estimate-cost.js` are
> all in and verified.

## Context

The Jev arm records one row per chain — `total_steps`, `correct_steps`, `input_tokens`,
`output_tokens`. That is enough for accuracy and cost, but it throws away the most interesting
thing Jev returns.

Every Choice answer carries a **full probability distribution over all options** plus a derived
`confidence`. Today only the argmax survives, which collapses two very different outcomes into
the same `0`: the correct member ranked second at p=0.45, versus never considered at all. It
also makes four analyses impossible — top-k accuracy, calibration, confidence-gated
auto-advance, and which member names get confused with which.

None of it is recoverable after the fact: the distribution exists only in the response, so it
must be written at run time. This change logs it to a **second, per-step CSV**, written only
for runs whose model returns probabilities — i.e. Jev, since the Anthropic Messages API exposes
no logprobs.

**Timing:** a sweep is in flight. `run-eval.sh` spawns a fresh `node` per config and this change
touches the shared `runner.js`, so a mistake would land in configs that cost real money. Apply
only once the sweep has finished, then re-run the two Jev configs (~$0.06) to populate the file.

## Design

### A separate command: `rank-jev.js`

This is its own entry point rather than a flag on `score-jev.js`, which keeps the scorers and
their resume logic completely untouched. It takes the same options (`-n -p -m -s -o -r`), walks
the chains with `scoreChain`, sends the identical Jev request via `buildBody` + `postDecision`
(exported from `score-jev.js`), and writes **only** the per-step ranking CSV — no chain-level
file. `estimate-cost.js` is the precedent: it already drives `loadSnippets` + `scoreChain`
directly instead of going through `runEval`.

The trade is that it repeats the Jev calls, so a ranking run costs about what a Jev scoring run
costs (~$0.03 per config). At that price, independence is worth more than the saving.

### runner.js: additive only

`scoreChain`'s non-pending `yield` gains `truthIdx`, `nOptions` and `nMembers`, and passes
through whatever extra fields `ask` returned. `runEval` and the chain CSV are **not** touched,
so no existing run changes behaviour. `score.js` and `score-jev.js` need no changes beyond
exporting `postDecision`.

`ask` must not see the ground truth, and won't: it returns the raw distribution, and
`rank-jev.js` — which now receives `truthIdx` from the yield — computes the rank.

### Columns

Two naming rules, applied consistently: `truth_*` for the ground-truth member, `topN_*` for the
ranked options.

```
snippet_id, chain_index, step_index, provider, step,
n_options, n_members, api_called, correct,
truth_rank, truth_tied, truth_prob,
top1_name, top1_prob, top2_name, top2_prob,
confidence, entropy_bits,
input_tokens, output_tokens
```

- `step` is the ground-truth member name. There is no separate `pick` column: the choice is
  always the argmax, so `top1_name` is the pick.
- `top2_name` / `top2_prob` are what it nearly chose — this is what turns "wrong" into
  "confused `then` with `preview`", a finding about The Gamma's member names rather than about
  the model.
- `n_members` vs `n_options` shows whether the menu was sampled down (15 of 665 steps);
  a `truncated` flag is dropped as derivable from the two.
- `entropy_bits` is the cheap summary of spread, since the full distribution is not stored.
- `correct` is `top1_name === step`, kept for convenience when joining or filtering.

### Rank and tie rule

`truth_rank = 1 + count(p > p_truth)`, `truth_tied = count(p == p_truth)`.

This matters more than it looks, because the distributions are **sparse** — in the smoke test 4
of 8 options came back at exactly `0`. If the correct member is one of 200 zeros, a rank of 87
is an artefact of sort order, not a measurement. `truth_tied` is what lets the notebook spot
those rows and drop them from MRR instead of quietly averaging noise.

### File location and resume

`results/steps/<slug>__<prompt>__<provider>__<timestamp>.csv` — a subdirectory, so
`results.ipynb`'s glob of `results/*.csv` is completely unaffected, and the two notebooks read
disjoint sets of files.

`--resume <file>` reads back the `(snippet_id, chain_index)` pairs already present and skips
those chains, mirroring `runEval`'s pattern. Worth having: a full ranking run is ~665 calls and
interruptions have already happened once this session.

### CSV escaping

Member names are free text and can contain commas and quotes, and three columns now hold them
(`step`, `top1_name`, `top2_name`). `runner.js` hand-rolls quoting for `snippet_title` alone
today — the same shortcut on the *read* side is what caused the duplicate-row resume bug
earlier this session. Add one exported `csvCell()` helper, use it for every text field here,
and route the existing `snippet_title` through it too.

## New notebook: `ranking.ipynb`

Separate from `results.ipynb`, reading `results/steps/*.csv`. Every cell guards for no data so
it opens cleanly before the first run exists.

- **Top-k table** — top-1 / top-3 / top-5 and MRR by provider and prompt, excluding forced moves
  (`api_called = 0`) and flagging tied-at-zero rows.
- **Reliability diagram** — bucket by `top1_prob`, plot predicted vs observed accuracy. This is
  the test of TypeSafe's calibration claim on a domain they never trained for, and it decides
  whether the thresholds below can be trusted. → `results/calibration.png`
- **Auto-advance curve** — sweep a `confidence` threshold; plot the fraction of steps that would
  auto-advance and the accuracy among them. The directly actionable result for the editor.
  → `results/auto_advance.png`
- **Confusability** — most frequent `(step, top2_name)` pairs, and mean `entropy_bits` grouped by
  ground-truth member name, to surface menus that are ambiguous by construction.

## Files

- `rank-jev.js` — **new**, the ranking command
- `ranking.ipynb` — **new**, its analysis
- `runner.js` — extra fields on the `scoreChain` yield, exported `csvCell()`
- `score-jev.js` — export `postDecision` for reuse
- `README.md` — document the command, the step CSV columns and the new notebook
- `PLAN.md` — refresh the in-repo copy

## Verification

1. **Confirm the sweep is done** before touching anything — `results/*.csv` at 75 rows each and
   no `node` processes left.
2. **Existing scorers unaffected:** `node score.js -n 1 -p olympics` and
   `node score-jev.js -n 1 -p olympics` still behave exactly as now. The runner change is
   additive, but it is the shared file, so this is the check that matters most.
3. `node rank-jev.js -n 1 -p olympics -o results` → `results/steps/…csv` has 13 rows, and
   `truth_rank == 1` on exactly the rows where `top1_name == step`.
4. **Cross-check against a scoring run:** step counts must match exactly (665 over the full
   set). Accuracy should be *close but not identical* — the 15 steps with menus over 255 draw a
   fresh random sample each run, so those rows legitimately differ. Reconcile on the
   `n_members == n_options` rows only.
5. **Forced move:** `-n 1 -p shared` (snippet #32 has a one-option menu) → `api_called = 0` and
   empty probability fields, with the row still present.
6. **Truncated menu:** `-n 3 -p worldbank` → at least one row with `n_members > n_options`.
7. **Ties:** confirm rows exist with `truth_prob = 0` and `truth_tied > 1`, and that
   `ranking.ipynb` excludes them from MRR rather than averaging them in.
8. **Resume:** interrupt a 3-snippet run, re-run with `--resume`, confirm no duplicate rows.
9. Run `ranking.ipynb` top to bottom; confirm both PNGs render.
10. Full ranking run for both prompt settings (`-n 61`, with and without, ~$0.06).
