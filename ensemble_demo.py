"""multillm CLI.

The installed console-script entry point (`multillm`). Subcommands:

  multillm [query] "Your question here"   Offline ensemble demo (default,
                                           no API keys/network required)
  multillm chat                           Interactive chat using real
                                           provider keys (set OPENAI_API_KEY
                                           etc. first)
  multillm train [--epochs N ...]         Train the local generator/scorer
                                           models from scratch
  multillm corpus                         Rebuild the synthetic training
                                           corpus used by `train`
  multillm eval                           Evaluate the trained generator on
                                           held-out questions
  multillm --version                      Show the installed version
  multillm --help                         Show this message

"query" is implied when the first argument isn't one of the other command
names (or --version/--help), so `multillm "question"` and
`multillm --sources "question"` both still work without typing `query`.
"""

from __future__ import annotations

import argparse
import runpy
import sys
import time
from pathlib import Path

from ai_client import (
    GenerationConfig,
    SourceIndex,
    bias_score,
    clarity_score,
    detect_sensitive_hits,
    format_sources_for_prompt,
    format_sources_for_user,
    generate_candidate,
    source_support_score,
)
from local_models import LocalTransformerProvider

BASE_DIR = Path(__file__).resolve().parent
SOURCES_DIR = BASE_DIR / "knowledge_sources"


def run_ensemble(query: str, top_k: int, show_sources: bool) -> None:
    start = time.time()

    index = SourceIndex(SOURCES_DIR)
    index.refresh()
    sources = index.retrieve(query, top_k=top_k)
    source_context = format_sources_for_prompt(sources)

    print(f"Question: {query}")
    print("Local model: LocalTransformerProvider (TinyGPT, from scratch)")
    print(f"Sources: {len(sources)} retrieved from knowledge_sources/")
    print("-" * 64)

    # Two personas act as the parallel "bots", both offline.
    provider = LocalTransformerProvider()
    personas = [
        ("Factual Analyst", "Prioritize precise facts and explicit assumptions."),
        ("Neutral Teacher", "Explain clearly for non-experts with minimal jargon."),
    ]

    candidates = []
    for bot_name, instruction in personas:
        text = generate_candidate(
            provider,
            history=[],
            user_input=query,
            source_context=source_context,
            bot_name=bot_name,
            bot_instruction=instruction,
            privacy_redaction=True,
            gen_p=GenerationConfig(temperature=0.8),
        )
        s = source_support_score(text, sources)
        b = bias_score(text)
        c = clarity_score(text)
        try:
            from local_models import blend_score

            s, b, c = blend_score(text, sources, s, b, c)
        except Exception:
            pass
        total = 0.50 * s + 0.25 * b + 0.25 * c
        candidates.append((bot_name, text, s, b, c, total))

    candidates.sort(key=lambda x: x[5], reverse=True)
    for bot_name, text, s, b, c, total in candidates:
        print(f"\n[{bot_name}] score={total:.2f} (support={s:.2f}, bias={b:.2f}, clarity={c:.2f})")
        print(text[:500])
        print("-" * 64)

    winner = candidates[0]
    print(f"\nSelected answer ({winner[0]}):")
    print(winner[1])
    if detect_sensitive_hits(winner[1]):
        print("\n(leakage scan: sensitive patterns REDACTED)")
    else:
        print("\n(leakage scan: OK)")

    if show_sources:
        print("\nSource checks:")
        print(format_sources_for_user(sources))

    print(f"\nElapsed: {time.time() - start:.2f}s (fully offline)")


DELEGATED_COMMANDS = {
    "chat": "ai_client",
    "train": "train.train",
    "corpus": "train.dataset",
    "eval": "train.eval_generator",
}


def _get_version() -> str:
    try:
        from importlib.metadata import version

        return version("multillm-ensemble")
    except Exception:
        return "development"


def _delegate(module_name: str, argv: list[str]) -> None:
    """Runs another module's own `if __name__ == "__main__":` block, as if
    invoked via `python -m <module_name> <argv...>` -- reuses each module's
    existing CLI (train.py's many flags, ai_client.py's REPL) without
    duplicating or re-declaring their argument parsers here."""
    old_argv = sys.argv
    sys.argv = [module_name, *argv]
    try:
        runpy.run_module(module_name, run_name="__main__")
    finally:
        sys.argv = old_argv


def _run_query(argv: list[str]) -> None:
    parser = argparse.ArgumentParser(prog="multillm query", description="Offline Multi-LLM ensemble demo")
    parser.add_argument("question", nargs="?", default="How does a multi-LLM ensemble improve answer quality?")
    parser.add_argument("--top-k", type=int, default=3)
    parser.add_argument("--sources", action="store_true", help="Show retrieved sources")
    args = parser.parse_args(argv)
    run_ensemble(args.question, args.top_k, args.sources)


def main() -> None:
    argv = sys.argv[1:]

    if argv and argv[0] in ("-h", "--help"):
        print(__doc__)
        return
    if argv and argv[0] == "--version":
        print(f"multillm {_get_version()}")
        return
    if argv and argv[0] in DELEGATED_COMMANDS:
        _delegate(DELEGATED_COMMANDS[argv[0]], argv[1:])
        return

    # No recognized subcommand -- treat the whole thing as `query` args, so
    # the historical bare-string and --sources/--top-k forms keep working
    # without requiring the word "query".
    query_argv = argv[1:] if argv and argv[0] == "query" else argv
    _run_query(query_argv)


if __name__ == "__main__":
    main()
