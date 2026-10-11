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
"""

import os

os.environ.setdefault("INTERNAL_API_SECRET", "test-secret")

from fastapi.testclient import TestClient

import main
from local_models import LocalTransformerProvider

AUTH_HEADERS = {"x-internal-secret": os.environ["INTERNAL_API_SECRET"]}


def test_local_transformer_provider_default_token_budget_fits_timeout():
    """450 tokens (~68s measured) blows past both PROVIDER_TIMEOUT_SECONDS'
    max (55s) and this function's own maxDuration (60s, vercel.json) once
    candidate generation and synthesis both have to run. Don't silently
    raise this back up without re-reading the comment on this default."""
    assert LocalTransformerProvider().max_tokens <= 150


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
