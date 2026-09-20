#!/usr/bin/env bash
# Run the scorers across 8 configurations and write CSV results to results/
# If a partial CSV already exists for a configuration, resume from it.
# Usage: bash run-eval.sh

set -e

PROMPT=prompts/default-prompt.txt
COUNT=61
OUT=results

run_config() {
  local label="$1"
  local script="$2"
  local model="$3"
  local prompt_flag="$4"  # either "-s prompts/default-prompt.txt" or ""

  # Result files flatten any vendor prefix, so "typesafe/jev-1.13" becomes
  # "typesafe-jev-1.13" — mirror that here when looking for a partial run.
  local slug="${model#\~}"
  slug="${slug//\//-}"

  # Look for an existing (partial) CSV matching this config
  local prompt_label="no-prompt"
  if [ -n "$prompt_flag" ]; then prompt_label="default-prompt"; fi
  local existing
  existing=$(ls "$OUT/${slug}__${prompt_label}__all__"*.csv 2>/dev/null | tail -1)

  if [ -n "$existing" ]; then
    echo "$label  →  resuming from $(basename "$existing")"
    node "$script" -n $COUNT -m "$model" $prompt_flag --resume "$existing"
  else
    echo "$label"
    node "$script" -n $COUNT -m "$model" $prompt_flag --output $OUT
  fi
}

# Same idea for rank-jev.js, which writes per-step rankings to $OUT/steps/ instead.
# It repeats the Jev calls rather than reusing the scoring run, which costs a few cents.
run_rank() {
  local label="$1"
  local model="$2"
  local prompt_flag="$3"

  local slug="${model#\~}"
  slug="${slug//\//-}"

  local prompt_label="no-prompt"
  if [ -n "$prompt_flag" ]; then prompt_label="default-prompt"; fi
  local existing
  existing=$(ls "$OUT/steps/${slug}__${prompt_label}__all__"*.csv 2>/dev/null | tail -1)

  if [ -n "$existing" ]; then
    echo "$label  →  resuming from $(basename "$existing")"
    node rank-jev.js -n $COUNT -m "$model" $prompt_flag --resume "$existing"
  else
    echo "$label"
    node rank-jev.js -n $COUNT -m "$model" $prompt_flag --output $OUT
  fi
}

mkdir -p "$OUT"

echo "Running evaluation: $COUNT snippets × 8 configurations"
echo

run_config "[1/8] jev, with prompt"    score-jev.js typesafe/jev-1.13  "-s $PROMPT"
echo
run_config "[2/8] sonnet, with prompt" score.js     claude-sonnet-5    "-s $PROMPT"
echo
run_config "[3/8] haiku, with prompt"  score.js     claude-haiku-4-5   "-s $PROMPT"
echo
run_config "[4/8] jev, no prompt"      score-jev.js typesafe/jev-1.13  ""
echo
run_config "[5/8] sonnet, no prompt"   score.js     claude-sonnet-5    ""
echo
run_config "[6/8] haiku, no prompt"    score.js     claude-haiku-4-5   ""
echo
run_rank   "[7/8] jev ranking, with prompt" typesafe/jev-1.13 "-s $PROMPT"
echo
run_rank   "[8/8] jev ranking, no prompt"   typesafe/jev-1.13 ""

echo
echo "Done. Chain results in $OUT/, per-step rankings in $OUT/steps/"
