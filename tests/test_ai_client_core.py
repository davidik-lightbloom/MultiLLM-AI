"""Offline unit tests for ai_client.py's core, provider-agnostic logic:
scoring heuristics, redaction, key rotation/loading, and the
build_ensemble_answer happy path against a fake in-process provider.

No real network calls or API keys are used anywhere in this file.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Dict, Sequence

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ai_client import (
    RoundRobinKeys,
    SourceChunk,
    SourceIndex,
    _compute_idf,
    _term_frequencies,
    _tiered_keys,
    bias_score,
    build_ensemble_answer,
    clarity_score,
    detect_sensitive_hits,
    load_keys_from_env,
    redact_sensitive,
    source_support_score,
    tokenize,
)

# ---------------------------------------------------------------------------
# source_support_score
# ---------------------------------------------------------------------------


def _make_source(source_id: str, text: str) -> SourceChunk:
    return SourceChunk(source_id=source_id, path=Path(f"{source_id}.md"), text=text, tokens=set(tokenize(text)))


def test_source_support_score_empty_answer_is_zero():
    assert source_support_score("", []) == 0.0


def test_source_support_score_no_sources_is_default_midpoint():
    answer = "This is a reasonably long sentence with no sources available at all."
    assert source_support_score(answer, []) == 0.55


def test_source_support_score_no_scoreable_sentences_is_half():
    # Every "sentence" is shorter than the 25-char minimum the scorer requires.
    sources = [_make_source("S1", "ensemble retrieval works well")]
    assert source_support_score("Yes. Ok. Sure.", sources) == 0.5


def test_source_support_score_citation_marker_counts_as_supported():
    sources = [_make_source("S1", "unrelated background text about something else entirely")]
    answer = "This claim has a citation marker right here [S1] to back it up completely."
    assert source_support_score(answer, sources) == 1.0


def test_source_support_score_token_overlap_counts_as_supported():
    sources = [_make_source("S1", "the ensemble retrieves relevant source chunks for grounding answers")]
    answer = "The ensemble retrieves relevant source chunks for grounding every answer it gives."
    assert source_support_score(answer, sources) == 1.0


def test_source_support_score_unsupported_sentence_scores_zero():
    sources = [_make_source("S1", "completely unrelated content about gardening and plants")]
    answer = "Quantum entanglement enables non-local correlations between particles far apart."
    assert source_support_score(answer, sources) == 0.0


# ---------------------------------------------------------------------------
# bias_score
# ---------------------------------------------------------------------------


def test_bias_score_empty_answer_is_zero():
    assert bias_score("") == 0.0


def test_bias_score_penalizes_absolute_language():
    neutral = "This approach works well for most cases, though results vary depending on setup."
    absolute = "This always works everyone should know it never fails and is obviously guaranteed."
    assert bias_score(absolute) < bias_score(neutral)


def test_bias_score_rewards_citations_up_to_a_cap():
    uncited = "This claim is supported by the available evidence and reasoning presented here."
    cited = "This claim [S1] is supported by the evidence [S2] and prior findings [S3] as well."
    assert bias_score(cited) > bias_score(uncited)
    assert bias_score(cited) <= 1.0


# ---------------------------------------------------------------------------
# clarity_score
# ---------------------------------------------------------------------------


def test_clarity_score_very_short_answer_is_penalized():
    short = "Yes."
    long_enough = " ".join(["word"] * 60)
    assert clarity_score(short) < clarity_score(long_enough)


def test_clarity_score_sweet_spot_beats_rambling():
    sweet_spot = " ".join(["word"] * 100)
    rambling = " ".join(["word"] * 600)
    assert clarity_score(sweet_spot) > clarity_score(rambling)


def test_clarity_score_structure_bonus_for_bullet_lists():
    plain = " ".join(["word"] * 60)
    structured = plain + "\n- point one\n- point two"
    assert clarity_score(structured) >= clarity_score(plain)


# ---------------------------------------------------------------------------
# redact_sensitive / detect_sensitive_hits
# ---------------------------------------------------------------------------


def test_redact_sensitive_masks_email():
    text = "Contact me at jane.doe@example.com for details."
    redacted = redact_sensitive(text)
    assert "jane.doe@example.com" not in redacted
    assert "[REDACTED:EMAIL]" in redacted


def test_redact_sensitive_masks_openai_style_key():
    text = "Here is my key: sk-abcdefghijklmnopqrstuvwxyz123456"
    redacted = redact_sensitive(text)
    assert "sk-abcdefghijklmnopqrstuvwxyz123456" not in redacted
    assert "[REDACTED:OPENAI_KEY]" in redacted


def test_redact_sensitive_leaves_clean_text_untouched():
    text = "This sentence has nothing sensitive in it at all."
    assert redact_sensitive(text) == text


def test_detect_sensitive_hits_lists_matched_labels():
    text = "Email me at a@b.com or call 555-1234-5678."
    hits = detect_sensitive_hits(text)
    assert "Email" in hits


def test_detect_sensitive_hits_empty_for_clean_text():
    assert detect_sensitive_hits("Nothing sensitive here.") == []


# ---------------------------------------------------------------------------
# RoundRobinKeys
# ---------------------------------------------------------------------------


def test_round_robin_keys_rotates_in_order():
    rr = RoundRobinKeys(["a", "b", "c"])
    assert [rr.next() for _ in range(3)] == ["a", "b", "c"]


def test_round_robin_keys_wraps_around():
    rr = RoundRobinKeys(["a", "b"])
    seen = [rr.next() for _ in range(5)]
    assert seen == ["a", "b", "a", "b", "a"]


def test_round_robin_keys_size():
    assert RoundRobinKeys(["a", "b", "c"]).size() == 3


# ---------------------------------------------------------------------------
# RoundRobinKeys -- drain tracking (the key-rotation-on-rate-limit feature)
# and tiering (a user's own BYO key tried before the platform's fallback key)
# ---------------------------------------------------------------------------


def test_round_robin_keys_prefers_tier_0_until_drained():
    rr = RoundRobinKeys([("user-key", 0), ("platform-key", 1)], provider_name="test-provider-tiering")
    assert rr.next() == "user-key"
    assert rr.next() == "user-key"
    rr.mark_drained("user-key", cooldown_seconds=60)
    assert rr.next() == "platform-key"
    assert rr.next() == "platform-key"


def test_round_robin_keys_drained_key_recovers_after_cooldown():
    rr = RoundRobinKeys(["a", "b"], provider_name="test-provider-recovery")
    rr.mark_drained("a", cooldown_seconds=0.05)
    assert rr.next() == "b"
    time.sleep(0.1)
    seen = {rr.next() for _ in range(4)}
    assert "a" in seen


def test_round_robin_keys_without_provider_name_ignores_drain():
    # provider_name="" (the default) disables drain-tracking entirely --
    # matters for every pre-existing call site/test that never opted in.
    rr = RoundRobinKeys(["a", "b"])
    rr.mark_drained("a", cooldown_seconds=9999)
    assert [rr.next() for _ in range(2)] == ["a", "b"]


def test_round_robin_keys_degrades_gracefully_when_everything_drained():
    rr = RoundRobinKeys([("only-key", 0)], provider_name="test-provider-all-drained")
    rr.mark_drained("only-key", cooldown_seconds=60)
    # No live key anywhere -- still returns something rather than raising;
    # the caller's own retry/error handling is what actually surfaces the
    # failure to the user.
    assert rr.next() == "only-key"


# ---------------------------------------------------------------------------
# _tiered_keys
# ---------------------------------------------------------------------------


def test_tiered_keys_tiers_user_keys_ahead_of_platform_keys():
    assert _tiered_keys(["u1", "u2"], ["p1"]) == [("u1", 0), ("u2", 0), ("p1", 1)]


def test_tiered_keys_plain_list_when_no_user_keys():
    # No BYO key supplied -- the common, platform-only path keeps its
    # original flat-list shape rather than always wrapping in tuples.
    assert _tiered_keys(None, ["p1", "p2"]) == ["p1", "p2"]


def test_tiered_keys_empty_when_nothing_configured():
    assert _tiered_keys(None, None) == []


# ---------------------------------------------------------------------------
# load_keys_from_env
# ---------------------------------------------------------------------------


def test_load_keys_from_env_multi_and_single_are_merged_and_deduped(monkeypatch):
    monkeypatch.setenv("TEST_KEYS", "k1, k2, k1")
    monkeypatch.setenv("TEST_KEY", "k2")
    keys = load_keys_from_env(multi_env="TEST_KEYS", single_env="TEST_KEY")
    assert keys == ["k1", "k2"]


def test_load_keys_from_env_returns_empty_when_unset(monkeypatch):
    monkeypatch.delenv("MISSING_KEYS", raising=False)
    monkeypatch.delenv("MISSING_KEY", raising=False)
    assert load_keys_from_env(multi_env="MISSING_KEYS", single_env="MISSING_KEY") == []


def test_load_keys_from_env_reads_from_file(monkeypatch, tmp_path):
    key_file = tmp_path / "keys.txt"
    key_file.write_text("file-key-1\n# a comment\nfile-key-2\n", encoding="utf-8")
    monkeypatch.delenv("TEST_KEYS2", raising=False)
    monkeypatch.delenv("TEST_KEY2", raising=False)
    monkeypatch.setenv("TEST_KEYS2_FILE", str(key_file))
    keys = load_keys_from_env(multi_env="TEST_KEYS2", single_env="TEST_KEY2", file_env="TEST_KEYS2_FILE")
    assert keys == ["file-key-1", "file-key-2"]


# ---------------------------------------------------------------------------
# build_ensemble_answer happy path (fake in-process provider, no network)
# ---------------------------------------------------------------------------


class FakeProvider:
    """Minimal ChatProvider: returns a canned, well-formed answer instantly."""

    def __init__(self, name: str = "Fake", reply: str = "") -> None:
        self.name = name
        self.model = "fake-model"
        self._reply = reply or (
            "This is a well-supported answer [S1] that stays balanced and avoids "
            "absolute claims, presented at a reasonable, readable length overall."
        )

    def size(self) -> int:
        return 1

    def chat(
        self,
        messages: Sequence[Dict[str, str]],
        temperature: float,
        gen_p=None,
    ) -> str:
        return self._reply


def test_build_ensemble_answer_happy_path_returns_answer_candidates_and_savings():
    providers = [FakeProvider("Fake-A"), FakeProvider("Fake-B")]
    sources = [_make_source("S1", "background information relevant to the well-supported answer")]

    answer, candidates, token_savings, confidence_score = build_ensemble_answer(
        providers=providers,
        history=[],
        user_input="What does the source say?",
        sources=sources,
        bot_count=2,
        privacy_redaction=False,
    )

    assert isinstance(answer, str) and answer.strip()
    assert len(candidates) == 2
    assert all(c.total_score >= 0.0 for c in candidates)
    assert "tokens_saved" in token_savings
    assert "tokens_saved_pct" in token_savings
    assert confidence_score is None  # not requested


def test_build_ensemble_answer_deep_review_returns_confidence_score():
    providers = [FakeProvider("Fake-A", reply="90"), FakeProvider("Fake-B")]
    sources = [_make_source("S1", "background information relevant to the well-supported answer")]

    _, _, _, confidence_score = build_ensemble_answer(
        providers=providers,
        history=[],
        user_input="What does the source say?",
        sources=sources,
        bot_count=2,
        privacy_redaction=False,
        deep_review=True,
    )

    assert confidence_score is not None
    assert 0.0 <= confidence_score <= 1.0


def test_build_ensemble_answer_raises_when_no_providers_configured():
    with pytest.raises(RuntimeError):
        build_ensemble_answer(
            providers=[],
            history=[],
            user_input="Anything?",
            sources=[],
            bot_count=2,
            privacy_redaction=False,
        )


def test_build_ensemble_answer_raises_when_every_provider_fails():
    class FailingProvider(FakeProvider):
        def chat(self, messages, temperature, gen_p=None) -> str:
            raise RuntimeError("simulated provider outage")

    with pytest.raises(RuntimeError, match="All provider calls failed"):
        build_ensemble_answer(
            providers=[FailingProvider("Failing")],
            history=[],
            user_input="Anything?",
            sources=[],
            bot_count=2,
            privacy_redaction=False,
        )


# ---------------------------------------------------------------------------
# SourceIndex.retrieve
# ---------------------------------------------------------------------------


def _build_index(doc_texts: Dict[str, str]) -> SourceIndex:
    index = SourceIndex(Path("unused"))
    chunks = [
        SourceChunk(
            source_id=source_id,
            path=Path(f"{source_id}.md"),
            text=text,
            tokens=set(tokenize(text)),
            tf=_term_frequencies(tokenize(text)),
            length=len(tokenize(text)),
        )
        for source_id, text in doc_texts.items()
    ]
    index.chunks = chunks
    index._idf = _compute_idf(chunks)
    index._avg_len = sum(c.length for c in chunks) / len(chunks) if chunks else 0.0
    return index


def test_retrieve_ignores_a_single_incidental_word_overlap():
    # Real production bug, reproduced against knowledge_sources/ensemble.md's
    # actual wording: "What is 2+2? Respond in one word." shares no topical
    # words with this doc at all, but it does share "one" ("...merges the
    # best parts into one final response.") -- a single generic word was
    # previously enough for _compute_idf's always-positive floor to make this
    # doc look "relevant" and get quoted at the model as grounding for a
    # completely unrelated question (see the comment above the min_matches
    # logic in retrieve()).
    index = _build_index(
        {
            "S1": (
                "The platform queries several independent large language models in parallel for a "
                "single user prompt, then merges the best parts into one final response."
            )
        }
    )
    assert index.retrieve("What is 2+2? Respond in one word.") == []


def test_retrieve_still_matches_genuine_multi_term_overlap():
    index = _build_index(
        {
            "S1": "The ensemble platform scores each candidate answer for source support, bias, and clarity.",
            "S2": "Completely unrelated content about gardening and houseplants.",
        }
    )
    results = index.retrieve("How does the ensemble platform score candidate answers?")
    assert [chunk.source_id for chunk in results] == ["S1"]


def test_retrieve_single_word_query_only_needs_one_match():
    index = _build_index({"S1": "Gardening tips for houseplants."})
    results = index.retrieve("gardening")
    assert [chunk.source_id for chunk in results] == ["S1"]


def test_retrieve_rejects_a_sentence_that_merely_reduces_to_one_word():
    # Real production bug, confirmed live: "What time is it?" tokenizes to
    # just ["time"] once stopwords ("what", "is", "it") are stripped, which
    # previously satisfied the one-word-query exception meant for someone
    # literally typing a single word like "ensemble" -- letting "time" (an
    # incidental word in this doc's prose, not its topic) pull the doc in as
    # a "source" for a question about the current time. The one-word
    # exception must key off the raw query actually being one word, not the
    # post-stopword-filtering token count.
    index = _build_index({"S1": "Adding relevant files improves grounding over time."})
    assert index.retrieve("What time is it?") == []
    # A genuinely single-word query for the same incidental term still
    # matches -- the exception itself isn't removed, just correctly scoped.
    assert [c.source_id for c in index.retrieve("time")] == ["S1"]
