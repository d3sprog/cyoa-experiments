# Legacy results (500-option cap)

These four runs predate the Jev comparison. They were scored with `MAX_OPTIONS = 500`,
whereas every current run caps menus at 255 — Jev's per-question limit — so that all
models see identical option lists.

They are kept for reference but are **not** directly comparable with the results in the
parent directory, and `results.ipynb` does not read them (it globs `results/*.csv`).

| Model | Prompt | Overall |
|-------|--------|---------|
| claude-haiku-4-5 | no-prompt | 54% |
| claude-haiku-4-5 | default-prompt | 65% |
| claude-opus-4-7 | no-prompt | 60% |
| claude-opus-4-7 | default-prompt | 79% |
