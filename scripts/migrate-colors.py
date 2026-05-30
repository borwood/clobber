#!/usr/bin/env python3
"""One-shot migration (#368): rewrite raw Tailwind palette utilities in
packages/web/src to the semantic token utilities defined in index.css. Token
values equal today's literals, so the rewrite is visually identity. The two
status-seed files (state-tones.ts, whiteboard-cards.tsx) are hand-edited
separately because their classes must take STATUS token names, not the
value-equal accent/provenance names this prop-based mapping would pick."""
import re
import sys
from pathlib import Path

SRC = Path("packages/web/src")
SKIP = {"components/state-tones.ts"}

BG = "bg"

# (family, shade) -> default token, with per-prop overrides. Default applies
# when a prop isn't in the override dict. Tokens are the @theme role names.
MAP = {
    ("zinc", "950"): {"_": "bg"},
    ("zinc", "900"): {"_": "surface"},
    ("zinc", "800"): {BG: "elevated", "_": "border"},
    ("zinc", "700"): {BG: "raised", "_": "border-strong"},
    ("zinc", "600"): {BG: "raised", "text": "text-faint",
                      "placeholder": "text-faint", "_": "border-strong"},
    ("zinc", "500"): {BG: "done", "_": "text-subtle"},
    ("zinc", "400"): {"_": "text-muted"},
    ("zinc", "300"): {"_": "text-soft"},
    ("zinc", "200"): {"_": "text-dim"},
    ("zinc", "100"): {"_": "text"},
    ("zinc", "50"): {"_": "text"},

    ("emerald", "700"): {"_": "accent-strong"},
    ("emerald", "600"): {"_": "accent"},
    ("emerald", "500"): {BG: "working", "_": "accent-hover"},
    ("emerald", "400"): {"_": "accent-text"},
    ("emerald", "300"): {"_": "accent-text"},
    ("emerald", "200"): {"_": "accent-text"},
    ("emerald", "900"): {"_": "accent-muted"},
    ("emerald", "950"): {"_": "accent-deep"},

    ("amber", "500"): {BG: "blocked", "_": "provenance"},
    ("amber", "50"): {"_": "provenance-fg"},
    ("amber", "300"): {"_": "provenance-text"},
    ("amber", "200"): {"_": "provenance-text"},
    ("amber", "100"): {"_": "provenance-text"},
    ("amber", "400"): {"_": "provenance-text"},
    ("amber", "600"): {"_": "provenance"},
    ("amber", "700"): {"_": "provenance-strong"},
    ("amber", "800"): {"_": "provenance-strong"},
    ("amber", "900"): {"_": "provenance-muted"},
    ("amber", "950"): {"_": "provenance-deep"},

    ("red", "500"): {"_": "danger"},
    ("red", "600"): {"_": "danger-strong"},
    ("red", "700"): {"_": "danger-strong"},
    ("red", "400"): {"_": "danger-text"},
    ("red", "200"): {"_": "danger-text"},
    ("red", "900"): {"_": "danger-muted"},
    ("red", "950"): {"_": "danger-muted"},

    ("sky", "500"): {"_": "info"},
    ("sky", "600"): {"_": "info-strong"},
    ("sky", "400"): {"_": "info-text"},
    ("sky", "800"): {"_": "info-surface"},
    ("sky", "100"): {"_": "info-fg"},
}

PROP = ("border-l|border-r|border-t|border-b|border-x|border-y|border-s|border-e|"
        "border|divide|outline|ring-offset|ring|from|to|via|accent|"
        "placeholder|caret|decoration|fill|stroke|bg|text")
FAMILY = ("red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|"
          "violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone")
# Shade alternation lists 3-digit forms first and guards with (?!\d) so that
# `bg-red-500` matches shade 500, never shade 50 with a dangling `0`.
PAT = re.compile(
    rf"((?:[a-z][a-z-]*:)*)({PROP})-({FAMILY})-([1-9]00|950|50)(?!\d)(/\d{{1,3}})?")


def resolve(prop, family, shade):
    key = (family, shade)
    if key not in MAP:
        raise SystemExit(f"unmapped: {prop}-{family}-{shade}")
    rules = MAP[key]
    return rules.get(prop, rules["_"])


def repl(m):
    variants, prop, family, shade, alpha = m.groups()
    token = resolve(prop, family, shade)
    alpha = alpha or ""
    return f"{variants}{prop}-{token}{alpha}"


total = 0
for path in sorted(SRC.rglob("*")):
    if path.suffix not in {".ts", ".tsx"}:
        continue
    rel = str(path.relative_to(SRC))
    if rel in SKIP:
        continue
    text = path.read_text()
    new, n = PAT.subn(repl, text)
    if n:
        path.write_text(new)
        total += n
        print(f"  {rel}: {n}")
print(f"total rewritten: {total}")
