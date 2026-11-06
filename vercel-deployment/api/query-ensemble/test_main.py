"""Regression tests for main.py's local-only mode handling.

Local-only mode's only provider is the CPU-bound trained TinyGPT model --
these guard against the two ways it previously broke silently in production
(see local_models.py and the bot_count-capping comments in main.py):
  1. `_resolve_request_providers` not finding/using the local model at all.
  2. Local-only requests running enough parallel CPU generations, at a high
     enough token budget, to blow past this function's wall-clock budget.

Requires INTERNAL_API_SECRET to be set before `main` is first imported (it's
read into a module-level constant at import time), so it's set here, at
module scope, before the `import main` below.

Import isolation: `main.py`, `local_models.py`, `ai_client.py`,
`token_optimizer.py`, and `prompt_router.py` all exist as a second,
vendored copy here (see local_models.py's "VENDORED COPY" docstring for
why) under the *same* module names as the repo-root originals that
tests/test_prompt_refiner.py etc. import. When the whole suite runs from
the repo root, whichever copy gets imported first wins the shared
`sys.modules` cache for every later bare `import local_models` -- so this
pops any root-cached entries, forces a fresh import from this directory,
then restores whatever was cached before. Without the restore, this file's
vendored `local_models` (whose trained-model files now really exist, see
the commit that added vercel-deployment/api/query-ensemble/models/) would
leak into tests/test_prompt_refiner.py's own inline `from local_models
import ...` calls, silently making its "model unavailable" fallback tests
exercise real generation instead.
"""

import os
import sys
from pathlib import Path

os.environ.setdefault("INTERNAL_API_SECRET", "test-secret")

_VENDORED_DIR = str(Path(__file__).resolve().parent)
_SHARED_MODULE_NAMES = ("main", "local_models", "ai_client", "token_optimizer", "prompt_router")
_saved_modules = {name: sys.modules.pop(name) for name in _SHARED_MODULE_NAMES if name in sys.modules}
if _VENDORED_DIR in sys.path:
    sys.path.remove(_VENDORED_DIR)
sys.path.insert(0, _VENDORED_DIR)

try:
    import main
    from local_models import LocalTransformerProvider
finally:
    for _name in _SHARED_MODULE_NAMES:
        sys.modules.pop(_name, None)
    sys.modules.update(_saved_modules)

from fastapi.testclient import TestClient

AUTH_HEADERS = {"x-internal-secret": os.environ["INTERNAL_API_SECRET"]}


def test_local_transformer_provider_default_token_budget_fits_timeout():
    """450 tokens (~68s measured) blows past both PROVIDER_TIMEOUT_SECONDS'
    max (55s) and this function's own maxDuration (60s, vercel.json) once
    candidate generation and synthesis both have to run. Don't silently
    raise this back up without re-reading the comment on this default."""
    assert LocalTransformerProvider().max_tokens <= 150


def test_build_provider_stack_excludes_local_model_by_default():
    """The local model only ever scored ~0.006 avg error on its own trained
    TinyScorer and is far rougher than a real provider's answer (see
    train/data/corpus.json) -- it must never round-robin into the default
    ensemble's bot/provider assignment and compete for "Best Answer" against
    genuine OpenAI/Gemini/Mistral/Groq responses. Only local_only=True may
    return it (see the next test)."""
    default_stack = main.build_provider_stack()
    assert "Local TinyGPT (from scratch)" not in {p.name for p in default_stack}


def test_resolve_request_providers_uses_local_model_when_available():
    request = main.QueryRequest(prompt="hello", local_only=True)
    providers = main._resolve_request_providers(request)
    assert len(providers) == 1
    assert providers[0].name == "Local TinyGPT (from scratch)"


def test_query_endpoint_caps_bot_count_for_local_only(monkeypatch):
    captured = {}

    def fake_build_ensemble_answer(**kwargs):
        captured["bot_count"] = kwargs["bot_count"]
        return "answer", [], {}, None

    monkeypatch.setattr(main, "build_ensemble_answer", fake_build_ensemble_answer)
    client = TestClient(main.app)

    resp = client.post(
        "/api/query",
        json={"prompt": "hello", "local_only": True, "bot_count": 8},
        headers=AUTH_HEADERS,
    )

    assert resp.status_code == 200
    # Requested 8, but local-only mode caps CPU-bound local generations to 2
    # regardless of what the caller asks for.
    assert captured["bot_count"] == 2


def test_query_endpoint_does_not_cap_bot_count_for_remote_providers(monkeypatch):
    captured = {}

    def fake_build_ensemble_answer(**kwargs):
        captured["bot_count"] = kwargs["bot_count"]
        return "answer", [], {}, None

    monkeypatch.setattr(main, "build_ensemble_answer", fake_build_ensemble_answer)
    monkeypatch.setattr(
        main,
        "providers",
        [type("FakeProvider", (), {"name": "Fake", "model": "fake-model", "size": lambda self: 1})()],
    )
    client = TestClient(main.app)

    resp = client.post(
        "/api/query",
        json={"prompt": "hello", "bot_count": 5},
        headers=AUTH_HEADERS,
    )

    assert resp.status_code == 200
    assert captured["bot_count"] == 5


def test_query_endpoint_raises_bot_count_for_deep_mode(monkeypatch):
    """Phase 1 of the adaptive-hierarchy roadmap: deep mode's only lever
    today is a bigger ensemble, applied only when the caller didn't pin an
    explicit bot_count (see the matching comment in main.py)."""
    captured = {}

    def fake_build_ensemble_answer(**kwargs):
        captured["bot_count"] = kwargs["bot_count"]
        return "answer", [], {}, None

    monkeypatch.setattr(main, "build_ensemble_answer", fake_build_ensemble_answer)
    monkeypatch.setattr(
        main,
        "providers",
        [type("FakeProvider", (), {"name": "Fake", "model": "fake-model", "size": lambda self: 1})()],
    )
    client = TestClient(main.app)

    resp = client.post(
        "/api/query",
        json={"prompt": "hello", "mode": "deep"},
        headers=AUTH_HEADERS,
    )

    assert resp.status_code == 200
    assert captured["bot_count"] == main.MAX_PARALLEL_BOTS


def test_query_endpoint_deep_mode_does_not_override_explicit_bot_count(monkeypatch):
    captured = {}

    def fake_build_ensemble_answer(**kwargs):
        captured["bot_count"] = kwargs["bot_count"]
        return "answer", [], {}, None

    monkeypatch.setattr(main, "build_ensemble_answer", fake_build_ensemble_answer)
    monkeypatch.setattr(
        main,
        "providers",
        [type("FakeProvider", (), {"name": "Fake", "model": "fake-model", "size": lambda self: 1})()],
    )
    client = TestClient(main.app)

    resp = client.post(
        "/api/query",
        json={"prompt": "hello", "mode": "deep", "bot_count": 3},
        headers=AUTH_HEADERS,
    )

    assert resp.status_code == 200
    # An explicit bot_count is a deliberate choice -- deep mode must not
    # silently override it.
    assert captured["bot_count"] == 3


def test_query_endpoint_fast_mode_is_default_and_unaffected(monkeypatch):
    """No "mode" field at all must behave exactly as before this field
    existed: default bot_count, no forced deep_review, routing reports
    "fast"."""
    captured = {}

    def fake_build_ensemble_answer(**kwargs):
        captured["bot_count"] = kwargs["bot_count"]
        captured["deep_review"] = kwargs["deep_review"]
        return "answer", [], {}, None

    monkeypatch.setattr(main, "build_ensemble_answer", fake_build_ensemble_answer)
    monkeypatch.setattr(
        main,
        "providers",
        [type("FakeProvider", (), {"name": "Fake", "model": "fake-model", "size": lambda self: 1})()],
    )
    client = TestClient(main.app)

    resp = client.post(
        "/api/query",
        json={"prompt": "hello", "bot_count": 5},
        headers=AUTH_HEADERS,
    )

    assert resp.status_code == 200
    assert captured["bot_count"] == 5
    assert captured["deep_review"] is False
    assert resp.json()["routing"]["mode"] == "fast"


def test_query_endpoint_deep_mode_alone_does_not_grant_deep_review(monkeypatch):
    """Regression test for a real bug found live in production: Deep Review
    is tier-gated entirely on the Next.js side (DEEP_REVIEW_PLANS) *before*
    request.deep_review is ever set to true, but route.ts forwards `mode` to
    every caller unconditionally regardless of plan (only the bot_count bump
    is meant to be ungated -- see route.ts's own comment). A previous version
    of this endpoint derived deep_review from `mode == "deep"` as "defense in
    depth," which actually meant any free-tier/anonymous caller could get the
    paid Deep Review feature for free just by setting mode="deep" -- there is
    no other enforcement point, so that was the actual security boundary, not
    a backstop for one. deep_review must depend solely on request.deep_review."""
    captured = {}

    def fake_build_ensemble_answer(**kwargs):
        captured["deep_review"] = kwargs["deep_review"]
        return "answer", [], {}, None

    monkeypatch.setattr(main, "build_ensemble_answer", fake_build_ensemble_answer)
    monkeypatch.setattr(
        main,
        "providers",
        [type("FakeProvider", (), {"name": "Fake", "model": "fake-model", "size": lambda self: 1})()],
    )
    client = TestClient(main.app)

    resp = client.post(
        "/api/query",
        json={"prompt": "hello", "mode": "deep"},
        headers=AUTH_HEADERS,
    )

    assert resp.status_code == 200
    assert captured["deep_review"] is False
    assert resp.json()["routing"]["mode"] == "deep"


def test_query_endpoint_deep_mode_with_explicit_deep_review_still_works(monkeypatch):
    """A caller that's actually entitled (route.ts already set deep_review=true
    server-side after its own DEEP_REVIEW_PLANS check) must still get it
    alongside Deep mode's bot_count bump -- this isn't mode-gated, just
    confirming the two features compose correctly."""
    captured = {}

    def fake_build_ensemble_answer(**kwargs):
        captured["deep_review"] = kwargs["deep_review"]
        captured["bot_count"] = kwargs["bot_count"]
        return "answer", [], {}, None

    monkeypatch.setattr(main, "build_ensemble_answer", fake_build_ensemble_answer)
    monkeypatch.setattr(
        main,
        "providers",
        [type("FakeProvider", (), {"name": "Fake", "model": "fake-model", "size": lambda self: 1})()],
    )
    client = TestClient(main.app)

    resp = client.post(
        "/api/query",
        json={"prompt": "hello", "mode": "deep", "deep_review": True},
        headers=AUTH_HEADERS,
    )

    assert resp.status_code == 200
    assert captured["deep_review"] is True
    assert captured["bot_count"] == main.MAX_PARALLEL_BOTS
    assert resp.json()["routing"]["mode"] == "deep"
