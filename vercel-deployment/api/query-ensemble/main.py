"""Vercel Python Function: Multi-LLM Ensemble Query Endpoint

Deployed as a Vercel Service (see vercel-deployment/vercel.json's `services`
block) rather than a plain /api function -- Next.js's App Router claims the
whole /api/* namespace for itself, so a sibling Python function placed
directly under /api is unreachable in production regardless of vercel.json
`functions` config (confirmed empirically: it silently returns Next's own
404 page instead of ever invoking this file). Its dependencies
(ai_client.py, local_models.py, token_optimizer.py, knowledge_sources/) are
vendored copies in this same directory rather than imported from the
repo root, since this project's Vercel Root Directory is vercel-deployment/
and a deployed function can't reach files above that.
"""

from __future__ import annotations

import json
import logging
import os
import time
import uuid

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel
from typing import Optional, List, Dict, Any

from ai_client import (
    build_provider_stack,
    SourceIndex,
    build_ensemble_answer,
    build_ensemble_answer_stream,
    maybe_refine_prompt,
    format_provider_status,
    SOURCES_DIR,
    MAX_PARALLEL_BOTS,
    parse_int_env,
    parse_bool_env,
    NoRemoteProviderAnsweredError,
)
from token_optimizer import estimate_tokens

# Rough, published-order-of-magnitude estimate (not a measured value) used to
# turn real token counts into an illustrative gCO2 figure. There is no actual
# per-provider energy metering in this stack; presenting this as more precise
# than "estimate" would just be a fancier fabrication.
CARBON_G_PER_1K_TOKENS = 0.5

logger = logging.getLogger("query_ensemble")
if not logger.handlers:
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")

app = FastAPI(title="MultiLLM Ensemble API")

# This function is a Vercel serverless function meant to be called ONLY by
# this project's own Next.js API routes (server-side), never directly by a
# browser. It carries no user-facing auth of its own, so it must reject any
# request that doesn't present the shared secret the Next.js side attaches.
INTERNAL_API_SECRET = os.environ.get("INTERNAL_API_SECRET", "")
APP_ORIGIN = os.environ.get("APP_ORIGIN", "")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[APP_ORIGIN] if APP_ORIGIN else [],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "x-internal-secret"],
)


@app.middleware("http")
async def require_internal_secret(request: Request, call_next):
    if request.url.path == "/api/health":
        return await call_next(request)
    provided = request.headers.get("x-internal-secret", "")
    if not INTERNAL_API_SECRET or provided != INTERNAL_API_SECRET:
        return JSONResponse(status_code=401, content={"detail": "Unauthorized"})
    return await call_next(request)


# Defense-in-depth backstop: the Next.js layer already enforces tier-aware
# per-user limits before it ever calls this function, so this only needs a
# coarse per-caller cap in case that layer is bypassed or misbehaves (e.g. a
# retry storm).
#
# Backed by Upstash Redis (REST API) when UPSTASH_REDIS_REST_URL/TOKEN (or
# the Vercel Marketplace "Upstash for Redis" product's KV_REST_API_URL/TOKEN)
# are set -- shared across every serverless instance -- and by an in-memory,
# per-process dict otherwise. Mirrors vercel-deployment/src/lib/rateLimiter.ts
# on the Next.js side; keep both in sync. Redis being unreachable fails OPEN
# (the request is allowed) rather than blocking every request on a
# rate-limiter outage.
_rate_buckets: Dict[str, Dict[str, float]] = {}
_RATE_WINDOW_SECONDS = 60.0
QUERY_RATE_LIMIT_PER_MINUTE = parse_int_env("QUERY_RATE_LIMIT_PER_MINUTE", default=1000, minimum=1, maximum=100000)

# The Vercel Marketplace "Upstash for Redis" product injects
# KV_REST_API_URL/TOKEN (a holdover from the sunset @vercel/kv naming), not
# the raw Upstash UPSTASH_REDIS_REST_* names -- check both.
UPSTASH_URL = (os.environ.get("UPSTASH_REDIS_REST_URL") or os.environ.get("KV_REST_API_URL") or "").rstrip("/")
UPSTASH_TOKEN = os.environ.get("UPSTASH_REDIS_REST_TOKEN") or os.environ.get("KV_REST_API_TOKEN") or ""
USE_REDIS_RATE_LIMIT = bool(UPSTASH_URL and UPSTASH_TOKEN)


def _client_key(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


async def _redis_rate_limit_exceeded(key: str) -> Optional[int]:
    """Returns retry_after_seconds if the caller is over budget, else None.
    Raises on a genuine Redis error so the caller can fail open."""
    import httpx as _httpx

    redis_key = f"ratelimit:query-ensemble:{key}"
    async with _httpx.AsyncClient(timeout=5.0) as client:
        headers = {"Authorization": f"Bearer {UPSTASH_TOKEN}"}
        incr_resp = await client.get(f"{UPSTASH_URL}/INCR/{redis_key}", headers=headers)
        incr_resp.raise_for_status()
        count = incr_resp.json()["result"]
        if count == 1:
            await client.get(f"{UPSTASH_URL}/EXPIRE/{redis_key}/{int(_RATE_WINDOW_SECONDS)}", headers=headers)
        if count > QUERY_RATE_LIMIT_PER_MINUTE:
            ttl_resp = await client.get(f"{UPSTASH_URL}/TTL/{redis_key}", headers=headers)
            ttl_resp.raise_for_status()
            ttl = ttl_resp.json()["result"]
            return ttl if ttl and ttl > 0 else int(_RATE_WINDOW_SECONDS)
        return None


def _memory_rate_limit_exceeded(key: str) -> Optional[int]:
    now = time.time()
    bucket = _rate_buckets.get(key)
    if bucket is None or now >= bucket["reset_at"]:
        _rate_buckets[key] = {"count": 1.0, "reset_at": now + _RATE_WINDOW_SECONDS}
        return None
    bucket["count"] += 1
    if bucket["count"] > QUERY_RATE_LIMIT_PER_MINUTE:
        return max(1, int(bucket["reset_at"] - now))
    return None


@app.middleware("http")
async def attach_request_id(request: Request, call_next):
    request.state.request_id = request.headers.get("x-request-id") or str(uuid.uuid4())
    response = await call_next(request)
    response.headers["x-request-id"] = request.state.request_id
    return response


@app.middleware("http")
async def rate_limit(request: Request, call_next):
    if request.url.path == "/api/health":
        return await call_next(request)

    key = _client_key(request)
    retry_after: Optional[int] = None
    if USE_REDIS_RATE_LIMIT:
        try:
            retry_after = await _redis_rate_limit_exceeded(key)
        except Exception as exc:
            logger.warning("Redis rate limiter unavailable, failing open: %s", exc)
            retry_after = None
    else:
        retry_after = _memory_rate_limit_exceeded(key)

    if retry_after is not None:
        return JSONResponse(
            status_code=429,
            content={"detail": "Rate limit exceeded"},
            headers={"Retry-After": str(retry_after)},
        )
    return await call_next(request)


providers = build_provider_stack()
source_index = SourceIndex(SOURCES_DIR)
source_index.refresh()

BOT_COUNT = parse_int_env("BOT_COUNT", default=4, minimum=2, maximum=MAX_PARALLEL_BOTS)
PRIVACY_REDACTION = parse_bool_env("PRIVACY_REDACTION", True)


class QueryRequest(BaseModel):
    prompt: str
    bot_count: Optional[int] = None
    top_k: Optional[int] = 6
    privacy_redaction: Optional[bool] = None
    save_history: Optional[bool] = False
    # Caller's own decrypted provider keys (BYO), grouped by provider name.
    # Only ever logged by key, never by value -- see build_provider_stack().
    provider_keys: Optional[Dict[str, List[str]]] = None
    # Tier-gated on the Next.js side before this is ever set to true.
    deep_review: Optional[bool] = False
    # Feature 4: force the local TinyGPT provider only, zero remote calls.
    local_only: Optional[bool] = False


class CandidateResponse(BaseModel):
    bot_name: str
    provider_name: str
    source_score: float
    bias_score: float
    clarity_score: float
    total_score: float
    text: str


class QueryResponse(BaseModel):
    answer: str
    candidates: List[CandidateResponse]
    sources: List[Dict[str, Any]]
    metrics: Dict[str, float]
    provider_status: str
    providers_used: List[str] = []
    refined_prompt: Optional[str] = None
    token_savings: Optional[Dict[str, float]] = None
    request_id: Optional[str] = None
    confidence_score: Optional[float] = None
    # Feature 1: which category/providers this prompt was routed to, surfaced
    # so routing can be verified/tuned from the response, not just server logs.
    routing: Optional[Dict[str, Any]] = None
    # Which bots failed and why (timeout / error / rate_limited), sanitized --
    # never a raw exception body or a key. Empty when every bot succeeded.
    provider_failures: List[Dict[str, str]] = []


def _resolve_request_providers(request: "QueryRequest"):
    """Shared by both /api/query and /api/query/stream: resolve the actual
    provider stack for this one request, honoring BYO keys and local-only
    mode. Never built once at module scope -- it must never be shared across
    requests/users. request.provider_keys itself is never logged (only which
    providers ended up in use, by name)."""
    request_providers = providers
    if request.provider_keys:
        request_providers = build_provider_stack(user_keys=request.provider_keys) or providers

    if request.local_only:
        request_providers = [p for p in request_providers if getattr(p, "name", "") == "Local TinyGPT (from scratch)"]
        if not request_providers:
            raise HTTPException(
                status_code=503,
                detail="Local-only mode requested, but no local model is available. Run `python -m train.train` first.",
            )
        return request_providers

    if not request_providers:
        raise HTTPException(status_code=503, detail="No providers configured. Set API keys.")
    return request_providers


@app.post("/api/query", response_model=QueryResponse)
async def query_ensemble(request: QueryRequest, http_request: Request):
    request_id = getattr(http_request.state, "request_id", None) or str(uuid.uuid4())
    request_providers = _resolve_request_providers(request)

    bot_count = request.bot_count or BOT_COUNT
    bot_count = max(2, min(MAX_PARALLEL_BOTS, bot_count))

    privacy_redaction = request.privacy_redaction if request.privacy_redaction is not None else PRIVACY_REDACTION

    try:
        start = time.perf_counter()
        refined_prompt = maybe_refine_prompt(request.prompt)
        sources = source_index.retrieve(refined_prompt, top_k=request.top_k or 6)
        provider_failures: List[Dict[str, str]] = []
        answer, candidates, token_savings, confidence_score = build_ensemble_answer(
            providers=request_providers,
            history=[],
            user_input=refined_prompt,
            sources=sources,
            bot_count=bot_count,
            privacy_redaction=privacy_redaction,
            deep_review=bool(request.deep_review),
            failures_out=provider_failures,
        )
        latency_ms = (time.perf_counter() - start) * 1000

        # Real per-query token accounting (not a guess): the optimized
        # context each bot actually received, times how many bots ran, plus
        # every candidate's output and the final synthesized answer.
        context_tokens = token_savings.get("tokens_after", 0) * bot_count
        output_tokens = sum(estimate_tokens(c.text) for c in candidates) + estimate_tokens(answer)
        total_tokens = context_tokens + output_tokens
        emissions_g = round(total_tokens / 1000 * CARBON_G_PER_1K_TOKENS, 4)
        carbon_saved_g = round(token_savings.get("tokens_saved", 0) / 1000 * CARBON_G_PER_1K_TOKENS, 4)
        providers_used = sorted({c.provider_name for c in candidates})

        # Cheap, side-effect-free re-classification purely for display -- the
        # actual routing decision (which already ran, and logged, inside
        # build_ensemble_answer) isn't threaded back through its return value
        # since that would change a signature other callers (ai_client_ui.py,
        # ai_client_app.py, ai_client_test_ui.py, tests/) depend on.
        from prompt_router import classify_prompt

        classification = classify_prompt(refined_prompt)

        return QueryResponse(
            answer=answer,
            candidates=[
                CandidateResponse(
                    bot_name=c.bot_name,
                    provider_name=c.provider_name,
                    source_score=c.source_score,
                    bias_score=c.bias_score,
                    clarity_score=c.clarity_score,
                    total_score=c.total_score,
                    text=c.text,
                )
                for c in candidates
            ],
            sources=[{"source_id": s.source_id, "path": str(s.path), "text": s.text[:200]} for s in sources],
            metrics={
                "source_support": (
                    round(sum(c.source_score for c in candidates) / len(candidates), 3) if candidates else 0
                ),
                "bias": round(sum(c.bias_score for c in candidates) / len(candidates), 3) if candidates else 0,
                "clarity": round(sum(c.clarity_score for c in candidates) / len(candidates), 3) if candidates else 0,
                "top_score": round(candidates[0].total_score, 3) if candidates else 0,
                "latency_ms": round(latency_ms, 1),
                "carbon_saved_g": carbon_saved_g,
                "emissions_g": emissions_g,
            },
            provider_status=format_provider_status(request_providers),
            providers_used=providers_used,
            refined_prompt=refined_prompt if refined_prompt != request.prompt else None,
            token_savings=token_savings,
            confidence_score=confidence_score,
            request_id=request_id,
            routing={"category": classification.category, "confidence": classification.confidence},
            provider_failures=provider_failures,
        )
    except NoRemoteProviderAnsweredError as e:
        logger.warning("request %s: %s", request_id, e)
        raise HTTPException(status_code=503, detail=f"{e} (request_id={request_id})")
    except Exception as e:
        logger.error("request %s failed: %s", request_id, e)
        raise HTTPException(status_code=500, detail=f"{e} (request_id={request_id})")


def _candidate_to_dict(c: Any) -> Dict[str, Any]:
    return {
        "bot_name": c.bot_name,
        "provider_name": c.provider_name,
        "source_score": c.source_score,
        "bias_score": c.bias_score,
        "clarity_score": c.clarity_score,
        "total_score": c.total_score,
        "text": c.text,
    }


@app.post("/api/query/stream")
async def query_ensemble_stream(request: QueryRequest, http_request: Request):
    """SSE variant of /api/query (Feature 2): streams the synthesis step's
    tokens as they arrive instead of waiting for the full pipeline. Every
    event is a `data: {...}\\n\\n` line; the final "done" event carries the
    same shape /api/query returns in one shot (metrics, candidates, sources,
    routing), so a caller that only wants the end state can ignore every
    event until that one."""
    request_id = getattr(http_request.state, "request_id", None) or str(uuid.uuid4())
    request_providers = _resolve_request_providers(request)

    bot_count = request.bot_count or BOT_COUNT
    bot_count = max(2, min(MAX_PARALLEL_BOTS, bot_count))
    privacy_redaction = request.privacy_redaction if request.privacy_redaction is not None else PRIVACY_REDACTION

    async def event_source():
        start = time.perf_counter()
        try:
            refined_prompt = maybe_refine_prompt(request.prompt)
            sources = source_index.retrieve(refined_prompt, top_k=request.top_k or 6)

            for event in build_ensemble_answer_stream(
                providers=request_providers,
                history=[],
                user_input=refined_prompt,
                sources=sources,
                bot_count=bot_count,
                privacy_redaction=privacy_redaction,
                deep_review=bool(request.deep_review),
            ):
                if event["event"] != "done":
                    yield f"data: {json.dumps(event)}\n\n"
                    continue

                latency_ms = (time.perf_counter() - start) * 1000
                candidates = event["candidates"]
                answer = event["answer"]
                token_savings = event["token_savings"]
                context_tokens = token_savings.get("tokens_after", 0) * bot_count
                output_tokens = sum(estimate_tokens(c.text) for c in candidates) + estimate_tokens(answer)
                total_tokens = context_tokens + output_tokens
                emissions_g = round(total_tokens / 1000 * CARBON_G_PER_1K_TOKENS, 4)
                carbon_saved_g = round(token_savings.get("tokens_saved", 0) / 1000 * CARBON_G_PER_1K_TOKENS, 4)
                providers_used = sorted({c.provider_name for c in candidates})

                payload = {
                    "event": "done",
                    "answer": answer,
                    "candidates": [_candidate_to_dict(c) for c in candidates],
                    "sources": [{"source_id": s.source_id, "path": str(s.path), "text": s.text[:200]} for s in sources],
                    "metrics": {
                        "source_support": (
                            round(sum(c.source_score for c in candidates) / len(candidates), 3) if candidates else 0
                        ),
                        "bias": (
                            round(sum(c.bias_score for c in candidates) / len(candidates), 3) if candidates else 0
                        ),
                        "clarity": (
                            round(sum(c.clarity_score for c in candidates) / len(candidates), 3) if candidates else 0
                        ),
                        "top_score": round(candidates[0].total_score, 3) if candidates else 0,
                        "latency_ms": round(latency_ms, 1),
                        "carbon_saved_g": carbon_saved_g,
                        "emissions_g": emissions_g,
                    },
                    "provider_status": format_provider_status(request_providers),
                    "providers_used": providers_used,
                    "refined_prompt": refined_prompt if refined_prompt != request.prompt else None,
                    "token_savings": token_savings,
                    "confidence_score": event.get("confidence_score"),
                    "routing": event.get("routing"),
                    "provider_failures": event.get("provider_failures", []),
                    "request_id": request_id,
                }
                yield f"data: {json.dumps(payload)}\n\n"
        except NoRemoteProviderAnsweredError as e:
            # Mirror /api/query's own handling of this case (a clean, specific
            # refusal) instead of falling into the generic except below --
            # otherwise this one failure mode reads identically to any other
            # internal error on the streaming path, even though the
            # non-streaming endpoint treats it as its own distinct case.
            logger.warning("stream request %s: %s", request_id, e)
            yield f"data: {json.dumps({'event': 'error', 'code': 'no_remote_provider_answered', 'detail': str(e), 'request_id': request_id})}\n\n"
        except Exception as e:
            logger.error("stream request %s failed: %s", request_id, e)
            yield f"data: {json.dumps({'event': 'error', 'detail': str(e), 'request_id': request_id})}\n\n"

    return StreamingResponse(
        event_source(),
        media_type="text/event-stream",
        headers={"x-request-id": request_id, "Cache-Control": "no-cache, no-transform"},
    )


@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "providers": len(providers),
        "sources": len(source_index.loaded_files),
        "provider_status": format_provider_status(providers),
    }


@app.post("/api/reload-sources")
async def reload_sources():
    global source_index
    source_index = SourceIndex(SOURCES_DIR)
    source_index.refresh()
    return {"status": "ok", "files": len(source_index.loaded_files), "chunks": len(source_index.chunks)}
