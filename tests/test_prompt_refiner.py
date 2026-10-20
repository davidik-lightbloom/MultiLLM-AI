"""Tests for the prompt-refiner dataset, model, and local_models integration.

Covers: the synthetic (raw -> refined) dataset generator, a from-scratch
forward-pass/training sanity check on TinyGPT (does the loss go down on a
tiny batch), and the local_models.refine_prompt() integration, including its
fallback behavior when no trained model is present.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from train.prompt_refiner_data import (
    build_prompt_refiner_corpus,
    build_prompt_refiner_pairs,
)
from train.model import TinyGPT, WordTokenizer


def test_pairs_are_nonempty_and_well_formed():
    pairs = build_prompt_refiner_pairs(seed=1, variants_per_question=4)
    assert len(pairs) > 50
    for raw, refined in pairs:
        assert isinstance(raw, str) and raw.strip()
        assert isinstance(refined, str) and refined.strip()
        # Refined targets are always one of the canonical questions, so they
        # should read as proper questions.
        assert refined.strip().endswith("?")


def test_pairs_are_actually_different_from_targets_most_of_the_time():
    """The whole point is raw != refined -- otherwise there's nothing to learn."""
    pairs = build_prompt_refiner_pairs(seed=1, variants_per_question=4)
    changed = sum(1 for raw, refined in pairs if raw.strip().lower() != refined.strip().lower())
    assert changed / len(pairs) > 0.8


def test_pairs_are_deterministic_given_a_seed():
    a = build_prompt_refiner_pairs(seed=5, variants_per_question=3)
    b = build_prompt_refiner_pairs(seed=5, variants_per_question=3)
    assert a == b


def test_corpus_docs_use_expected_chat_format():
    docs = build_prompt_refiner_corpus(seed=3, variants_per_question=2)
    assert len(docs) > 20
    for doc in docs[:20]:
        assert doc.startswith("<|user|>\n")
        assert "Raw prompt:\n" in doc
        assert "<|assistant|>\n" in doc
        assert "Refined prompt:\n" in doc
        assert doc.rstrip().endswith("<|end|>")


def test_tinygpt_overfits_a_tiny_batch():
    """Standard from-scratch-model sanity check: loss must go down.

    Trains a deliberately tiny TinyGPT for a handful of steps on a handful of
    refiner docs and asserts the loss decreases -- this catches a broken
    forward/backward pass or a wiring bug without needing a real multi-epoch
    training run.
    """
    docs = build_prompt_refiner_corpus(seed=7, variants_per_question=2)[:12]
    tokenizer = WordTokenizer.train(docs, vocab_size=512)

    block_size = 32
    ids: list[int] = []
    for doc in docs:
        ids += tokenizer.encode(doc)[:block_size] + [tokenizer.stoi["<|endoftext|>"]]

    xs, ys = [], []
    for i in range(0, len(ids) - block_size, block_size // 2):
        block = ids[i : i + block_size + 1]
        if len(block) < 2:
            continue
        xs.append(block[:-1] + [0] * (block_size - len(block[:-1])))
        ys.append(block[1:] + [0] * (block_size - len(block[1:])))
    assert xs, "expected at least one training block"

    xb = torch.tensor(xs, dtype=torch.long)
    yb = torch.tensor(ys, dtype=torch.long)

    torch.manual_seed(0)
    model = TinyGPT(vocab_size=tokenizer.vocab_size, block_size=block_size, n_layer=1, n_head=1, n_embd=16)
    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-2)

    losses = []
    for _ in range(30):
        _, loss = model(xb, yb)
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        optimizer.step()
        losses.append(loss.item())

    assert losses[-1] < losses[0] * 0.7, f"loss did not decrease enough: {losses[0]:.3f} -> {losses[-1]:.3f}"


def test_refine_prompt_falls_back_to_input_when_model_missing(monkeypatch):
    from local_models import _LOCAL, refine_prompt

    monkeypatch.setattr(_LOCAL, "refiner_available", lambda: False)
    assert refine_prompt("um so how does the ensemble thing work") == "um so how does the ensemble thing work"
    assert refine_prompt("") == ""


def test_refine_prompt_falls_back_on_generation_error(monkeypatch):
    from local_models import _LOCAL, refine_prompt

    monkeypatch.setattr(_LOCAL, "refiner_available", lambda: True)

    def _boom():
        raise RuntimeError("simulated failure")

    monkeypatch.setattr(_LOCAL, "refiner_tokenizer", _boom)
    assert refine_prompt("raw question here") == "raw question here"


class _FakeParam:
    device = "cpu"


class _FakeRefinerModel:
    def parameters(self):
        return iter([_FakeParam()])

    def generate(self, *args, **kwargs):
        return torch.tensor([[0]])


def _fake_tokenizer_returning(text: str):
    class FakeTokenizer:
        def encode(self, _text):
            return [0]

        def decode(self, _ids):
            return text

    return FakeTokenizer()


def test_refine_prompt_discards_a_hallucinated_unrelated_rewrite(monkeypatch):
    """Real production bug: the undertrained refiner once turned "What is
    2+2? Respond in one word." into "How do I keep provider costs
    predictable?" -- a completely unrelated hallucination that then silently
    became the real question sent to every provider. Zero word overlap with
    the raw prompt should be rejected in favor of the original."""
    from local_models import _LOCAL, refine_prompt

    monkeypatch.setattr(_LOCAL, "refiner_available", lambda: True)
    monkeypatch.setattr(
        _LOCAL, "refiner_tokenizer", lambda: _fake_tokenizer_returning("How do I keep provider costs predictable?")
    )
    monkeypatch.setattr(_LOCAL, "refiner", lambda: _FakeRefinerModel())

    assert refine_prompt("What is 2+2? Respond in one word.") == "What is 2+2? Respond in one word."


def test_refine_prompt_discards_a_hallucination_when_raw_prompt_has_no_content_words(monkeypatch):
    """The overlap check above tokenizes the raw prompt and only rejects the
    rewrite if that's nonempty AND disjoint from the rewrite's tokens -- a
    short/numeric-only prompt like the bare "What is 2+2?" (no "Respond in
    one word." tail) tokenizes to nothing at all, so that guard silently
    no-opped and let any hallucination through unchecked. Confirmed against
    production: this exact prompt was still getting hijacked after the fix
    above landed."""
    from local_models import _LOCAL, refine_prompt

    monkeypatch.setattr(_LOCAL, "refiner_available", lambda: True)
    monkeypatch.setattr(
        _LOCAL, "refiner_tokenizer", lambda: _fake_tokenizer_returning("does the system use renewable energy?")
    )
    monkeypatch.setattr(_LOCAL, "refiner", lambda: _FakeRefinerModel())

    assert refine_prompt("What is 2+2?") == "What is 2+2?"


def test_refine_prompt_keeps_a_genuine_rewrite_with_shared_content_words(monkeypatch):
    from local_models import _LOCAL, refine_prompt

    monkeypatch.setattr(_LOCAL, "refiner_available", lambda: True)
    monkeypatch.setattr(
        _LOCAL, "refiner_tokenizer", lambda: _fake_tokenizer_returning("How does the ensemble platform work?")
    )
    monkeypatch.setattr(_LOCAL, "refiner", lambda: _FakeRefinerModel())

    assert refine_prompt("um so how does the ensemble thing work") == "How does the ensemble platform work?"


@pytest.mark.skipif(
    not (Path(__file__).resolve().parent.parent / "models" / "prompt-refiner" / "model.pt").exists(),
    reason="prompt-refiner model not trained yet (run: python -m train.train --kind refiner)",
)
def test_refine_prompt_with_real_trained_model_returns_a_string():
    from local_models import refine_prompt

    out = refine_prompt("um so like how do i add my own files or whatever")
    assert isinstance(out, str) and out.strip()
