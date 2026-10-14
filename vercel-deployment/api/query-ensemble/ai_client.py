# VENDORED COPY -- kept in sync manually with the repo-root ai_client.py.
# Vercel's Root Directory for this project is vercel-deployment/, so a
# deployed function can't reach files above it (e.g. the repo-root copy this
# was copied from) via a sys.path hack -- see query-ensemble/main.py's
# comment for why. If you change the repo-root ai_client.py, copy the change
# here too (or vice versa).
from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import queue
import re
import threading
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed, TimeoutError as _FutureTimeoutError
from dataclasses import dataclass, field
from pathlib import Path
from types import ModuleType
from typing import Any, Dict, List, Protocol, Sequence, Set, Tuple

"""
OPENAI API KEY used from OPENROUTER, and a GEMINI API KEY used from GOOGLE AI STUDIO
"""
try:
    from openai import OpenAI, APIError, APITimeoutError, RateLimitError
except Exception:
    print("Install/upgrade the OpenAI SDK first: pip install -U openai")
    raise

httpx: "ModuleType | None"
try:
    import httpx as _httpx

    httpx = _httpx
except Exception:
    httpx = None

# Library logging: attach a NullHandler so importing this module (e.g. from
# the FastAPI query-ensemble function) produces zero output by default --
# the host application configures real handlers/levels if it wants any.
# main() below turns on console output when run as the interactive CLI.
logger = logging.getLogger("ai_client")
if not logger.handlers:
    logger.addHandler(logging.NullHandler())


BASE_DIR = Path(__file__).resolve().parent
HISTORY_FILE = BASE_DIR / "chat_history.json"
SOURCES_DIR = BASE_DIR / "knowledge_sources"


# Optional local env file (gitignored) holding provider keys.
#   OPENAI_API_KEY / OPENAI_API_KEYS  (OpenRouter: sk-or-v1-...)
#   GEMINI_API_KEY / GEMINI_API_KEYS
#   MISTRAL_API_KEY / MISTRAL_API_KEYS
#   GROQ_API_KEY / GROQ_API_KEYS
def load_env_file(path: Path | None = None) -> None:
    source = path or (BASE_DIR / ".env")
    if not source.exists():
        return
    try:
        raw = source.read_text(encoding="utf-8")
    except OSError:
        return
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and value and key not in os.environ:
            os.environ[key] = value


load_env_file()

DEFAULT_OPENAI_MODEL = "gpt-4o-mini"
DEFAULT_OPENROUTER_MODEL = "openai/gpt-4o-mini"
DEFAULT_GEMINI_MODEL = "gemini-2.5-flash"
DEFAULT_MISTRAL_MODEL = "mistral-small-latest"
DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b"
GROQ_BASE_URL = "https://api.groq.com/openai/v1"

# Provider keys are loaded ONLY from environment variables or key files.
# No keys are hardcoded here. Set at least one of the env vars below:
#   OPENAI_API_KEYS / OPENAI_API_KEY / OPENAI_API_KEYS_FILE
#   GEMINI_API_KEYS / GEMINI_API_KEY / GEMINI_API_KEYS_FILE
#   MISTRAL_API_KEYS / MISTRAL_API_KEY / MISTRAL_API_KEYS_FILE
#   GROQ_API_KEYS / GROQ_API_KEY / GROQ_API_KEYS_FILE

MAX_RETRIES = 4
MAX_HISTORY_MESSAGES = 12
MAX_PARALLEL_BOTS = 8
TOP_K_SOURCES = 6

# How long a key that just got rate-limited/quota-exceeded is skipped for
# (RoundRobinKeys below), before being tried again. A guess at a reasonable
# default, not derived from any specific provider's actual reset window --
# tune via env if it's too short (keeps retrying a dead key) or too long
# (skips a key that already recovered).
KEY_DRAIN_COOLDOWN_SECONDS = int(os.environ.get("KEY_DRAIN_COOLDOWN_SECONDS", "300") or "300")

SAVE_HISTORY_DEFAULT = os.environ.get("SAVE_HISTORY", "1").strip() == "1"
PRIVACY_REDACTION_DEFAULT = os.environ.get("PRIVACY_REDACTION", "1").strip() == "1"

BOT_PERSONAS: List[Tuple[str, str]] = [
    ("Factual Analyst", "Prioritize precise facts and explicit assumptions."),
    ("Skeptical Reviewer", "Challenge weak claims and point out uncertainty."),
    ("Neutral Teacher", "Explain clearly for non-experts with minimal jargon."),
    ("Risk Auditor", "Look for safety, privacy, and compliance risks."),
    ("Counter-Bias Bot", "Actively detect one-sided framing and rebalance perspectives."),
]

ALLOWED_SOURCE_EXTENSIONS = {
    ".txt",
    ".md",
    ".rst",
    ".json",
    ".csv",
    ".tsv",
    ".html",
    ".htm",
    ".xml",
    ".log",
    ".py",
}

UPLOAD_GUIDE = {
    "science": [
        "textbook chapters (.txt/.md)",
        "peer-reviewed paper exports (.txt/.json)",
        "trusted encyclopedic summaries (.md)",
    ],
    "finance": [
        "regulatory filings (.txt/.html)",
        "earnings transcripts (.txt)",
        "local policy docs and models (.csv/.json)",
    ],
    "medicine": [
        "clinical guidelines (.txt/.md)",
        "drug reference tables (.csv/.json)",
        "de-identified case notes only (.txt)",
    ],
    "law": [
        "local statutes and regulations (.txt)",
        "court decision summaries (.md/.txt)",
        "internal policy memos (.txt/.json)",
    ],
    "engineering": [
        "API docs and design specs (.md/.txt)",
        "runbooks and postmortems (.md/.txt)",
        "structured config/data dictionaries (.json/.csv)",
    ],
    "general": [
        "notes, books, and docs in plain text formats",
        "trusted sources converted to .txt/.md for best retrieval quality",
    ],
}

SYSTEM_PROMPT_BASE = """
You are one bot inside a multi-bot answer ensemble.
Goals:
1) Be accurate and honest about uncertainty.
2) Reduce bias by presenting balanced alternatives.
3) Cite provided local source ids like [S1], [S2] whenever factual claims are made.
4) If source support is weak, say what is uncertain instead of guessing.
5) Never output secrets or private identifiers.
"""

SENSITIVE_PATTERNS = [
    ("OpenAI key", re.compile(r"sk-[A-Za-z0-9_-]{20,}")),
    ("Email", re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")),
    ("US SSN", re.compile(r"\b\d{3}-\d{2}-\d{4}\b")),
    ("Credit card", re.compile(r"\b(?:\d[ -]*?){13,16}\b")),
    ("Phone", re.compile(r"\b(?:\+?\d{1,3}[ -]?)?(?:\(?\d{2,4}\)?[ -]?)?\d{3,4}[ -]?\d{4}\b")),
]

ABSOLUTE_WORDS = {
    "always",
    "never",
    "everyone",
    "nobody",
    "guaranteed",
    "obviously",
    "undeniable",
    "proves",
    "must",
}

STOPWORDS = {
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "your",
    "have",
    "will",
    "would",
    "what",
    "when",
    "where",
    "which",
    "about",
    "there",
    "their",
    "them",
    "into",
    "than",
    "then",
    "because",
    "while",
    "after",
    "before",
    # Short, very common function words -- originally missing here, which let
    # BM25 retrieval treat any two prompts as "related" purely because they
    # both contain "is"/"of"/etc, since TOKEN_RE's 2-char minimum doesn't
    # filter them on its own. Without these, a query entirely outside this
    # app's own knowledge_sources/ corpus (e.g. "What is the capital of
    # France?") still matched chunks via "is"/"of" alone, so the ensemble
    # treated irrelevant local docs as real context and refused to answer.
    "is",
    "are",
    "was",
    "were",
    "been",
    "being",
    "be",
    "am",
    "do",
    "does",
    "did",
    "of",
    "in",
    "on",
    "at",
    "by",
    "to",
    "a",
    "an",
    "it",
    "its",
    "as",
    "or",
    "not",
    "no",
    "so",
    "if",
    "but",
    "up",
    "out",
    "we",
    "you",
    "i",
    "he",
    "she",
    "they",
    "my",
    "our",
    "us",
    "all",
    "any",
    "each",
    "how",
    "why",
    "who",
    "whom",
    "can",
    "could",
    "should",
}

TOKEN_RE = re.compile(r"[A-Za-z0-9_]{2,}")


@dataclass
class SourceChunk:
    source_id: str
    path: Path
    text: str
    tokens: Set[str]
    tf: Dict[str, int] = field(default_factory=dict)
    length: int = 0


@dataclass
class Candidate:
    bot_name: str
    provider_name: str
    provider_index: int
    text: str
    source_score: float
    bias_score: float
    clarity_score: float
    total_score: float


class ChatProvider(Protocol):
    name: str
    model: str

    def size(self) -> int: ...

    def chat(
        self,
        messages: Sequence[Dict[str, str]],
        temperature: float,
        gen_p: "GenerationConfig | None" = None,
    ) -> str: ...


@dataclass
class GenerationConfig:
    """Generation & sampling parameters for a single call."""

    temperature: float = 0.2
    top_p: float | None = None
    top_k: int | None = None
    max_tokens: int | None = None
    repetition_penalty: float | None = None


def _translate_rep_penalty(value: float) -> float:
    """Map a TinyGPT-style repetition penalty (1.0 = none) to an OpenAI/Mistral
    frequency/presence penalty (0.0 = none, positive = discourage repetition).
    """
    if value <= 1.0:
        return 0.0
    return round(value - 1.0, 3)


# ---- Key-health circuit breaker --------------------------------------
#
# When a provider call fails with a rate-limit/quota error, the key that
# made the call is marked "drained" for KEY_DRAIN_COOLDOWN_SECONDS so
# RoundRobinKeys.next() skips it rather than retrying the same dead key on
# every subsequent request. Backed by Upstash Redis's REST API (the same
# UPSTASH_REDIS_REST_URL/TOKEN the Next.js app's rateLimiter.ts uses) when
# configured, so the mark is visible across every serverless instance --
# otherwise an in-process dict, same fallback trade-off as that TS rate
# limiter (bounds the blast radius to one instance, never a hard failure).
# Keys are never stored or logged in the clear -- only a short, irreversible
# hash, scoped per-provider.
def _key_fingerprint(provider_name: str, api_key: str) -> str:
    digest = hashlib.sha256(f"{provider_name}:{api_key}".encode("utf-8")).hexdigest()
    return f"keyhealth:{digest[:40]}"


class _InMemoryKeyHealth:
    def __init__(self) -> None:
        self._drained_until: Dict[str, float] = {}
        self._lock = threading.Lock()

    def is_drained(self, fingerprint: str) -> bool:
        with self._lock:
            until = self._drained_until.get(fingerprint)
            if until is None:
                return False
            if time.time() >= until:
                del self._drained_until[fingerprint]
                return False
            return True

    def mark_drained(self, fingerprint: str, cooldown_seconds: int) -> None:
        with self._lock:
            self._drained_until[fingerprint] = time.time() + cooldown_seconds


class _RedisKeyHealth:
    def __init__(self, base_url: str, token: str) -> None:
        self._base_url = base_url.rstrip("/")
        self._token = token

    def _command(self, *parts: Any) -> Any:
        path = "/".join(urllib.parse.quote(str(p), safe="") for p in parts)
        response = httpx.get(  # type: ignore[union-attr]
            f"{self._base_url}/{path}",
            headers={"Authorization": f"Bearer {self._token}"},
            timeout=5.0,
        )
        response.raise_for_status()
        return response.json().get("result")

    def is_drained(self, fingerprint: str) -> bool:
        try:
            return bool(self._command("GET", fingerprint))
        except Exception as exc:
            # Fail open -- an unreachable Redis shouldn't block queries that
            # would otherwise succeed on a perfectly good key.
            logger.warning("Key-health Redis check failed, assuming not drained: %s", exc)
            return False

    def mark_drained(self, fingerprint: str, cooldown_seconds: int) -> None:
        try:
            self._command("SET", fingerprint, "1", "EX", cooldown_seconds)
        except Exception as exc:
            logger.warning("Key-health Redis write failed (drain mark lost): %s", exc)


def _build_key_health_backend() -> "_InMemoryKeyHealth | _RedisKeyHealth":
    # The Vercel Marketplace "Upstash for Redis" product injects
    # KV_REST_API_URL/TOKEN (a holdover from the sunset @vercel/kv naming),
    # not the raw Upstash UPSTASH_REDIS_REST_* names -- check both.
    url = (os.environ.get("UPSTASH_REDIS_REST_URL") or os.environ.get("KV_REST_API_URL") or "").strip()
    token = (os.environ.get("UPSTASH_REDIS_REST_TOKEN") or os.environ.get("KV_REST_API_TOKEN") or "").strip()
    if url and token and httpx is not None:
        return _RedisKeyHealth(url, token)
    return _InMemoryKeyHealth()


_KEY_HEALTH = _build_key_health_backend()


class RoundRobinKeys:
    """Rotates through API keys, skipping ones currently marked drained.

    `keys` is either a flat sequence of key strings (all equal priority), or
    a sequence of (key, tier) pairs where a lower tier number is tried
    first -- e.g. a user's own BYO key as tier 0 and the platform's own key
    as tier 1, so the platform key is only ever used once every one of the
    user's own keys is drained. `provider_name` scopes drained-state lookups
    (pass "" to disable drain-tracking entirely, e.g. for tests).
    """

    def __init__(self, keys: Sequence[Any], provider_name: str = "") -> None:
        normalized: List[Tuple[str, int]] = []
        for item in keys:
            if isinstance(item, tuple):
                normalized.append((item[0], item[1]))
            else:
                normalized.append((item, 0))
        self._keys = normalized
        self._provider_name = provider_name
        self._cursors: Dict[int, int] = {}
        self._lock = threading.Lock()

    def _is_drained(self, key: str) -> bool:
        if not self._provider_name:
            return False
        return _KEY_HEALTH.is_drained(_key_fingerprint(self._provider_name, key))

    def next(self) -> str:
        with self._lock:
            tiers = sorted(set(tier for _, tier in self._keys))
            for tier in tiers:
                live = [k for k, t in self._keys if t == tier and not self._is_drained(k)]
                if live:
                    cursor = self._cursors.get(tier, 0)
                    key = live[cursor % len(live)]
                    self._cursors[tier] = cursor + 1
                    return key
            # Every key in every tier is currently marked drained. Degrade
            # gracefully -- return the highest-priority key anyway rather
            # than raising; the caller's own retry/error handling takes over,
            # and a wrong cooldown (the provider actually recovered early)
            # shouldn't permanently wedge the whole provider.
            return self._keys[0][0]

    def mark_drained(self, key: str, cooldown_seconds: int = KEY_DRAIN_COOLDOWN_SECONDS) -> None:
        if self._provider_name:
            _KEY_HEALTH.mark_drained(_key_fingerprint(self._provider_name, key), cooldown_seconds)

    def size(self) -> int:
        return len(self._keys)

    def all_keys(self) -> List[str]:
        """Unique key strings across every tier, in tier order -- for a
        caller (OpenAIProvider) that needs to pre-build one client per key
        rather than calling next() per request."""
        seen: List[str] = []
        for key, _tier in self._keys:
            if key not in seen:
                seen.append(key)
        return seen


def normalize_whitespace(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def tokenize(text: str) -> List[str]:
    words = [w.lower() for w in TOKEN_RE.findall(text)]
    return [w for w in words if w not in STOPWORDS]


def redact_sensitive(text: str) -> str:
    sanitized = text
    for label, pattern in SENSITIVE_PATTERNS:
        sanitized = pattern.sub(f"[REDACTED:{label.upper().replace(' ', '_')}]", sanitized)
    return sanitized


def detect_sensitive_hits(text: str) -> List[str]:
    hits = []
    for label, pattern in SENSITIVE_PATTERNS:
        if pattern.search(text):
            hits.append(label)
    return hits


def parse_bool_env(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def parse_int_env(name: str, default: int, minimum: int, maximum: int) -> int:
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        parsed = int(value)
    except ValueError:
        return default
    return max(minimum, min(maximum, parsed))


# Per-provider-call wall-clock budget (generate_candidate below) and a
# smaller budget for the single blocking synthesis/deep-review call that
# follows the fan-out. Sized so the worst case (every bot call times out in
# parallel, then synthesis also times out) stays comfortably under the
# query-ensemble Vercel function's 60s maxDuration (api/query-ensemble/main.py),
# with headroom for routing/source-retrieval/refine-prompt overhead:
# PROVIDER_TIMEOUT_SECONDS (bot fan-out, runs in parallel so this is the
# whole fan-out's budget, not per-bot-summed) + JUDGE_TIMEOUT_SECONDS
# (synthesis) [+ JUDGE_TIMEOUT_SECONDS again if deep_review is requested].
PROVIDER_TIMEOUT_SECONDS = parse_int_env("PROVIDER_TIMEOUT_SECONDS", default=20, minimum=1, maximum=55)
JUDGE_TIMEOUT_SECONDS = parse_int_env("JUDGE_TIMEOUT_SECONDS", default=15, minimum=1, maximum=55)

# Provider name used for the free, always-available local fallback model --
# matches LocalTransformerProvider.name in local_models.py. A query answered
# using only this (no remote provider succeeded) is refused rather than
# silently returned -- see the NoRemoteProviderAnsweredError check in
# build_ensemble_answer/build_ensemble_answer_stream below -- UNLESS the
# caller's provider stack only ever contained the local model to begin with
# (Feature 4's local-only mode), which is intentional, not a failure.
LOCAL_PROVIDER_NAME = "Local TinyGPT (from scratch)"


class NoRemoteProviderAnsweredError(RuntimeError):
    """Raised when at least one remote provider was available for this query
    but none of them produced a usable answer -- every successful candidate
    came from the local fallback model. Distinct from "every provider
    failed" (RuntimeError above it) so callers (main.py) can return a more
    specific, honest error instead of a tiny local model's answer standing
    in for the real ensemble."""


def _call_with_timeout(fn: Any, timeout_seconds: float, *args: Any, **kwargs: Any) -> Any:
    """Runs fn(*args, **kwargs) with a hard wall-clock budget. Python can't
    forcibly kill a running thread, so a call that exceeds the timeout keeps
    running in the background -- this bounds how long THIS request waits on
    it, not the underlying network call itself. Raises plain TimeoutError
    (classify_failure below checks for exactly that) on expiry.

    Deliberately NOT `with ThreadPoolExecutor(...) as executor:` -- that
    context manager's __exit__ calls shutdown(wait=True) unconditionally,
    which blocks until the submitted call actually finishes even after
    future.result(timeout=...) has already raised. That silently defeats the
    whole point of this function: a provider whose retry loop takes 100s
    still makes the caller wait the full 100s, just relabeled as a timeout
    instead of a success. shutdown(wait=False) below returns immediately;
    the orphaned thread keeps running until the underlying call naturally
    finishes (or the process exits), it just no longer blocks anyone."""
    executor = ThreadPoolExecutor(max_workers=1)
    try:
        future = executor.submit(fn, *args, **kwargs)
        try:
            return future.result(timeout=timeout_seconds)
        except _FutureTimeoutError:
            raise TimeoutError(f"timed out after {timeout_seconds}s") from None
    finally:
        executor.shutdown(wait=False)


def _iter_stream_with_timeout(iterator: Any, timeout_seconds: float) -> Any:
    """Wraps a chat_stream() generator so a stalled connection raises
    TimeoutError instead of hanging indefinitely. chat_stream() has no bound
    of its own -- unlike chat(), which every call site wraps in
    _call_with_timeout, the real token-streaming loop in
    build_ensemble_answer_stream iterates the generator directly, and the
    OpenAI client here is never constructed with an explicit request
    timeout (so it falls back to the SDK's own long default).

    Bounds time BETWEEN chunks, not total stream duration -- a real answer
    that's slow because it's long must not be cut short, only a connection
    that's stopped producing anything at all. Runs the actual iteration on a
    background thread (daemon, so it can't block process exit) and relays
    chunks through a queue; if the provider hangs, this raises after
    timeout_seconds but the orphaned thread is simply abandoned, same
    trade-off as _call_with_timeout."""
    chunk_queue: "queue.Queue[Any]" = queue.Queue()
    _sentinel = object()

    def _produce() -> None:
        try:
            for chunk in iterator:
                chunk_queue.put(chunk)
        except Exception as exc:  # noqa: BLE001 - relayed to the consumer, not swallowed
            chunk_queue.put(exc)
        finally:
            chunk_queue.put(_sentinel)

    threading.Thread(target=_produce, daemon=True).start()

    while True:
        try:
            item = chunk_queue.get(timeout=timeout_seconds)
        except queue.Empty:
            raise TimeoutError(f"stream stalled for more than {timeout_seconds}s") from None
        if item is _sentinel:
            return
        if isinstance(item, Exception):
            raise item
        yield item


def classify_failure(exc: BaseException) -> str:
    """Classifies a provider-call failure into one of "timeout",
    "rate_limited", or "error" for safe, structured surfacing in the API
    response (QueryResponse.provider_failures) -- never the raw exception
    text, which can embed a truncated upstream HTTP error body (see
    http_post_json) or other internal detail, and never a key (keys are
    never part of these messages to begin with -- see RoundRobinKeys)."""
    if isinstance(exc, TimeoutError):
        return "timeout"
    if isinstance(exc, RateLimitError):
        return "rate_limited"
    if "HTTP 429" in str(exc):
        return "rate_limited"
    return "error"


def load_keys_from_env(
    multi_env: str,
    single_env: str,
    file_env: str | None = None,
) -> List[str]:
    keys: List[str] = []

    multi = os.environ.get(multi_env, "")
    if multi:
        keys.extend(k.strip() for k in multi.split(",") if k.strip())

    single = os.environ.get(single_env, "").strip()
    if single:
        keys.append(single)

    if file_env:
        from_file = os.environ.get(file_env, "").strip()
        if from_file:
            key_file = Path(from_file).expanduser()
            if key_file.exists():
                lines = [line.strip() for line in key_file.read_text(encoding="utf-8").splitlines()]
                keys.extend(line for line in lines if line and not line.startswith("#"))

    deduped: List[str] = []
    seen = set()
    for key in keys:
        if key not in seen:
            seen.add(key)
            deduped.append(key)
    return deduped


def dedupe_keys(keys: Sequence[str]) -> List[str]:
    deduped: List[str] = []
    seen = set()
    for key in keys:
        normalized = key.strip()
        if normalized and normalized not in seen:
            seen.add(normalized)
            deduped.append(normalized)
    return deduped


def infer_openai_base_url(keys: Sequence[str]) -> str:
    explicit = os.environ.get("OPENAI_BASE_URL", "").strip()
    if explicit:
        return explicit
    if keys and all(key.startswith("sk-or-v1-") for key in keys):
        return "https://openrouter.ai/api/v1"
    return ""


def flatten_messages(messages: Sequence[Dict[str, str]]) -> str:
    lines: List[str] = []
    for msg in messages:
        role = msg.get("role", "user").upper()
        content = msg.get("content", "").strip()
        if content:
            lines.append(f"{role}: {content}")
    return "\n\n".join(lines)


def http_post_json(
    url: str,
    payload: Dict,
    headers: Dict[str, str],
    timeout_seconds: float = 45.0,
) -> Dict:
    if httpx is None:
        raise RuntimeError("httpx is required for Gemini/Mistral calls. Install with: pip install -U httpx")

    try:
        with httpx.Client(timeout=timeout_seconds) as client:
            response = client.post(url=url, json=payload, headers=headers)
            response.raise_for_status()
            return response.json() if response.text.strip() else {}
    except httpx.HTTPStatusError as exc:
        detail = normalize_whitespace(exc.response.text)[:360]
        raise RuntimeError(f"HTTP {exc.response.status_code}: {detail}") from exc
    except httpx.RequestError as exc:
        raise RuntimeError(f"Network error: {exc}") from exc


def extract_text_from_openai_like(response) -> str:
    try:
        message = response.choices[0].message
        content = getattr(message, "content", "")
    except Exception:
        return ""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict):
                text = block.get("text", "")
                if text:
                    parts.append(text)
            else:
                text = getattr(block, "text", "")
                if text:
                    parts.append(text)
        return "\n".join(parts).strip()
    return str(content).strip()


def extract_gemini_text(payload: Dict) -> str:
    candidates = payload.get("candidates", [])
    if not candidates:
        return ""
    content = candidates[0].get("content", {})
    parts = content.get("parts", [])
    texts = [part.get("text", "") for part in parts if isinstance(part, dict) and part.get("text")]
    return "\n".join(texts).strip()


def extract_mistral_text(payload: Dict) -> str:
    choices = payload.get("choices", [])
    if not choices:
        return ""
    message = choices[0].get("message", {})
    content = message.get("content", "")
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        texts = []
        for item in content:
            if isinstance(item, dict) and item.get("text"):
                texts.append(item["text"])
        return "\n".join(texts).strip()
    return str(content).strip()


class OpenAIProvider:
    def __init__(self, api_keys: Sequence[Any], model: str, base_url: str = "") -> None:
        self.model = model
        self.base_url = base_url.strip()
        if "openrouter.ai" in self.base_url:
            self.name = "OpenRouter (OpenAI API)"
        elif "groq.com" in self.base_url:
            self.name = "Groq (OpenAI API)"
        else:
            self.name = "OpenAI-compatible"
        self._keys = RoundRobinKeys(api_keys, provider_name=self.name)
        self._clients: Dict[str, OpenAI] = {
            key: (OpenAI(api_key=key, base_url=self.base_url) if self.base_url else OpenAI(api_key=key))
            for key in self._keys.all_keys()
        }

    def size(self) -> int:
        return self._keys.size()

    def chat(
        self,
        messages: Sequence[Dict[str, str]],
        temperature: float,
        gen_p: "GenerationConfig | None" = None,
    ) -> str:
        kwargs: Dict[str, Any] = {"model": self.model, "messages": list(messages), "temperature": temperature}
        if gen_p is None:
            gen_p = GenerationConfig(temperature=temperature)
        if gen_p.max_tokens is not None:
            kwargs["max_tokens"] = gen_p.max_tokens
        if gen_p.top_p is not None:
            kwargs["top_p"] = gen_p.top_p
        if gen_p.repetition_penalty is not None:
            kwargs["frequency_penalty"] = _translate_rep_penalty(gen_p.repetition_penalty)
            kwargs["presence_penalty"] = 0.0
        last_error: Exception | None = None
        for attempt in range(MAX_RETRIES):
            key = self._keys.next()
            client = self._clients[key]
            try:
                response = client.chat.completions.create(**kwargs)
                text = extract_text_from_openai_like(response)
                if text:
                    return text
                last_error = RuntimeError("Empty response from OpenAI-compatible provider")
            except RateLimitError as exc:
                last_error = exc
                self._keys.mark_drained(key)
                logger.warning(
                    "%s attempt %d/%d failed (key marked drained): %s", self.name, attempt + 1, MAX_RETRIES, exc
                )
                time.sleep(2**attempt)
            except (APITimeoutError, APIError) as exc:
                last_error = exc
                logger.warning("%s attempt %d/%d failed: %s", self.name, attempt + 1, MAX_RETRIES, exc)
                time.sleep(2**attempt)
            except Exception as exc:
                last_error = exc
                logger.warning("%s attempt %d/%d failed: %s", self.name, attempt + 1, MAX_RETRIES, exc)
                time.sleep(2**attempt)
        logger.error("%s call failed after %d retries: %s", self.name, MAX_RETRIES, last_error)
        raise RuntimeError(f"{self.name} call failed after retries: {last_error}")

    def chat_stream(
        self,
        messages: Sequence[Dict[str, str]],
        temperature: float,
        gen_p: "GenerationConfig | None" = None,
    ):
        """Yields text chunks as they arrive. No retry-on-chunk here (unlike
        chat()) -- a stream that fails mid-flight can't be silently retried
        without either duplicating already-emitted text or discarding it;
        callers decide what to do with a partial result. Raises before
        yielding anything if the very first request fails, so a caller that
        hasn't emitted output yet can still fall back to chat()."""
        kwargs: Dict[str, Any] = {
            "model": self.model,
            "messages": list(messages),
            "temperature": temperature,
            "stream": True,
        }
        if gen_p is None:
            gen_p = GenerationConfig(temperature=temperature)
        if gen_p.max_tokens is not None:
            kwargs["max_tokens"] = gen_p.max_tokens
        if gen_p.top_p is not None:
            kwargs["top_p"] = gen_p.top_p
        if gen_p.repetition_penalty is not None:
            kwargs["frequency_penalty"] = _translate_rep_penalty(gen_p.repetition_penalty)
            kwargs["presence_penalty"] = 0.0

        key = self._keys.next()
        client = self._clients[key]
        stream = client.chat.completions.create(**kwargs)
        for chunk in stream:
            if not chunk.choices:
                continue
            delta = getattr(chunk.choices[0].delta, "content", None)
            if delta:
                yield delta


class GeminiProvider:
    def __init__(self, api_keys: Sequence[Any], model: str) -> None:
        self.name = "Google Gemini"
        self.model = model
        self._keys = RoundRobinKeys(api_keys, provider_name=self.name)
        self._model_candidates = self._build_model_candidates(model)
        self._model_lock = threading.Lock()

    def size(self) -> int:
        return self._keys.size()

    def _set_active_model(self, candidate_model: str) -> None:
        with self._model_lock:
            self.model = candidate_model

    @staticmethod
    def _build_model_candidates(primary_model: str) -> List[str]:
        candidates = [
            primary_model,
            "gemini-2.5-flash",
            "gemini-2.5-pro",
            "gemini-2.0-flash",
            "gemini-2.0-flash-lite",
            "gemini-1.5-flash",
            "gemini-1.5-pro",
        ]
        deduped: List[str] = []
        seen = set()
        for item in candidates:
            normalized = item.strip()
            if normalized and normalized not in seen:
                seen.add(normalized)
                deduped.append(normalized)
        return deduped

    def chat(
        self,
        messages: Sequence[Dict[str, str]],
        temperature: float,
        gen_p: "GenerationConfig | None" = None,
    ) -> str:
        prompt = flatten_messages(messages)
        if gen_p is None:
            gen_p = GenerationConfig(temperature=temperature)
        gen_config: Dict = {"temperature": temperature}
        if gen_p.top_p is not None:
            gen_config["topP"] = gen_p.top_p
        if gen_p.top_k is not None:
            gen_config["topK"] = gen_p.top_k
        if gen_p.max_tokens is not None:
            gen_config["maxOutputTokens"] = gen_p.max_tokens
        last_error: Exception | None = None
        for candidate_model in self._model_candidates:
            model_name = urllib.parse.quote(candidate_model, safe="")
            for attempt in range(MAX_RETRIES):
                key = self._keys.next()
                # Key goes in a header, not the URL query string, so it never
                # ends up in a server/proxy access log or an error message
                # that happens to echo the request URL.
                url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent"
                payload = {
                    "contents": [{"role": "user", "parts": [{"text": prompt}]}],
                    "generationConfig": gen_config,
                }
                try:
                    data = http_post_json(
                        url=url,
                        payload=payload,
                        headers={"Content-Type": "application/json", "x-goog-api-key": key},
                    )
                    text = extract_gemini_text(data)
                    if text:
                        self._set_active_model(candidate_model)
                        return text
                    last_error = RuntimeError("Empty response from Gemini provider")
                except Exception as exc:
                    last_error = exc
                    logger.warning(
                        "%s (%s) attempt %d/%d failed: %s", self.name, candidate_model, attempt + 1, MAX_RETRIES, exc
                    )
                    # If the model itself is unavailable, skip to the next model candidate.
                    if "HTTP 404" in str(exc) and "models/" in str(exc):
                        break
                    # Quota or auth errors can vary by model; try next model quickly.
                    if "HTTP 429" in str(exc) or "HTTP 401" in str(exc) or "HTTP 403" in str(exc):
                        if "HTTP 429" in str(exc):
                            self._keys.mark_drained(key)
                        break
                    time.sleep(2**attempt)
        logger.error("%s call failed after retries: %s", self.name, last_error)
        raise RuntimeError(f"{self.name} call failed after retries: {last_error}")


class MistralProvider:
    def __init__(self, api_keys: Sequence[Any], model: str) -> None:
        self.name = "Mistral"
        self.model = model
        self._keys = RoundRobinKeys(api_keys, provider_name=self.name)

    def size(self) -> int:
        return self._keys.size()

    def chat(
        self,
        messages: Sequence[Dict[str, str]],
        temperature: float,
        gen_p: "GenerationConfig | None" = None,
    ) -> str:
        if gen_p is None:
            gen_p = GenerationConfig(temperature=temperature)
        payload = {
            "model": self.model,
            "messages": list(messages),
            "temperature": temperature,
        }
        if gen_p.top_p is not None:
            payload["top_p"] = gen_p.top_p
        if gen_p.top_k is not None:
            payload["top_k"] = gen_p.top_k
        if gen_p.max_tokens is not None:
            payload["max_tokens"] = gen_p.max_tokens
        if gen_p.repetition_penalty is not None:
            payload["presence_penalty"] = _translate_rep_penalty(gen_p.repetition_penalty)
            payload["frequency_penalty"] = 0.0
        last_error: Exception | None = None
        for attempt in range(MAX_RETRIES):
            key = self._keys.next()
            try:
                data = http_post_json(
                    url="https://api.mistral.ai/v1/chat/completions",
                    payload=payload,
                    headers={
                        "Authorization": f"Bearer {key}",
                        "Content-Type": "application/json",
                    },
                )
                text = extract_mistral_text(data)
                if text:
                    return text
                last_error = RuntimeError("Empty response from Mistral provider")
            except Exception as exc:
                last_error = exc
                if "HTTP 429" in str(exc):
                    self._keys.mark_drained(key)
                logger.warning("%s attempt %d/%d failed: %s", self.name, attempt + 1, MAX_RETRIES, exc)
                time.sleep(2**attempt)
        logger.error("%s call failed after retries: %s", self.name, last_error)
        raise RuntimeError(f"{self.name} call failed after retries: {last_error}")

    def chat_stream(
        self,
        messages: Sequence[Dict[str, str]],
        temperature: float,
        gen_p: "GenerationConfig | None" = None,
    ):
        """Yields text chunks via Mistral's SSE streaming endpoint. Same
        no-mid-stream-retry trade-off as OpenAIProvider.chat_stream."""
        if httpx is None:
            raise RuntimeError("httpx is required for Mistral calls. Install with: pip install -U httpx")
        if gen_p is None:
            gen_p = GenerationConfig(temperature=temperature)
        payload: Dict[str, Any] = {
            "model": self.model,
            "messages": list(messages),
            "temperature": temperature,
            "stream": True,
        }
        if gen_p.top_p is not None:
            payload["top_p"] = gen_p.top_p
        if gen_p.max_tokens is not None:
            payload["max_tokens"] = gen_p.max_tokens
        if gen_p.repetition_penalty is not None:
            payload["presence_penalty"] = _translate_rep_penalty(gen_p.repetition_penalty)
            payload["frequency_penalty"] = 0.0

        key = self._keys.next()
        with httpx.Client(timeout=60.0) as client:
            with client.stream(
                "POST",
                "https://api.mistral.ai/v1/chat/completions",
                json=payload,
                headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            ) as response:
                response.raise_for_status()
                for line in response.iter_lines():
                    if not line or not line.startswith("data:"):
                        continue
                    data = line[len("data:") :].strip()
                    if not data or data == "[DONE]":
                        continue
                    try:
                        chunk = json.loads(data)
                    except ValueError:
                        continue
                    choices = chunk.get("choices") or []
                    if not choices:
                        continue
                    delta = (choices[0].get("delta") or {}).get("content")
                    if delta:
                        yield delta


def _tiered_keys(
    user_keys: "List[str] | None", platform_keys: "List[str] | None"
) -> "List[Tuple[str, int]] | List[str]":
    """User-supplied (BYO) keys are tier 0, tried first; the platform's own
    keys are appended as tier 1, a fallback RoundRobinKeys only reaches for
    once every tier-0 key is marked drained (rate-limited/quota-exceeded) --
    so a user's exhausted key doesn't fail their query outright when the
    platform has its own key for the same provider. If the caller supplied
    no keys of their own, platform keys are returned as a plain list (most
    requests are platform-only; this keeps that path's type unchanged).
    """
    if user_keys:
        return [(k, 0) for k in user_keys] + [(k, 1) for k in (platform_keys or [])]
    return platform_keys or []


def build_provider_stack(
    user_keys: "Dict[str, List[str]] | None" = None,
    local_only: bool = False,
) -> List[ChatProvider]:
    """Build the provider stack, preferring a caller's own keys per-provider.

    `user_keys` (e.g. {"openai": [...], "gemini": [...], "openrouter": [...]})
    lets a multi-tenant caller (the SaaS) run a query against a specific
    user's own BYO provider keys instead of this process's platform keys.
    Any provider the caller hasn't supplied a key for still falls back to the
    platform's env-configured keys, so the ensemble stays multi-provider even
    for a user who only connected one of their own keys. Never log the
    contents of `user_keys`.

    When a user DOES supply a key for a provider, the platform's own key for
    that same provider (if any) is still loaded and attached as a tier-1
    fallback (see _tiered_keys) -- so if the user's key gets rate-limited
    mid-request, the platform's key picks up the rest of that request and
    every subsequent one, rather than failing that provider for the user
    until they notice and fix their key.

    `local_only=True` (Feature 4) skips every remote provider entirely and
    returns only the local TinyGPT provider -- the single place this
    guarantee is enforced, so every caller (the FastAPI route, the CLI) gets
    it for free rather than each having to remember to filter remote
    providers out itself. Raises if no local model is trained/available,
    since silently falling back to remote providers would defeat the whole
    point of the mode.
    """
    user_keys = user_keys or {}
    providers: List[ChatProvider] = []
    local_provider: "ChatProvider | None" = None

    try:
        from local_models import LocalTransformerProvider

        candidate = LocalTransformerProvider()
        if candidate.size():
            local_provider = candidate
    except Exception as exc:
        logger.debug("Local model provider unavailable: %s", exc)

    if local_only:
        if local_provider is None:
            raise RuntimeError("Local-only mode requested, but no local model is available. Run: python -m train.train")
        return [local_provider]

    # local_provider is deliberately NOT added to `providers` here: it's a
    # tiny, undertrained model (see train/data/corpus.json) whose answers
    # are noticeably rougher than a real provider's. Mixing it into the
    # default ensemble let it round-robin into the bot/provider assignment
    # (generate_candidates' `idx % len(providers)`) and occasionally win
    # "Best Answer" over genuine OpenAI/Gemini/Mistral/Groq responses via
    # the scoring step -- surprising and bad for any query that wasn't
    # explicitly asking for local-only mode. It stays reserved for
    # local_only=True, its original documented purpose above.

    user_openai_keys = user_keys.get("openai") or user_keys.get("openrouter")
    platform_openai_keys = load_keys_from_env(
        multi_env="OPENAI_API_KEYS",
        single_env="OPENAI_API_KEY",
        file_env="OPENAI_API_KEYS_FILE",
    )
    # The "openai" slot is also where OpenRouter keys live (same OpenAI-
    # compatible client, different base_url inferred from the key's own
    # prefix -- see infer_openai_base_url). A user's OpenRouter key and the
    # platform's real OpenAI key need two different base_urls, and a single
    # OpenAIProvider instance only has one -- so tiering them together is
    # only safe when both resolve to the SAME base_url. Otherwise, keep the
    # pre-existing behavior: the user's key alone, no platform fallback for
    # this provider (same as before this feature existed, not worse).
    if (
        user_openai_keys
        and platform_openai_keys
        and infer_openai_base_url(user_openai_keys) == infer_openai_base_url(platform_openai_keys)
    ):
        openai_keys = _tiered_keys(user_openai_keys, platform_openai_keys)
    else:
        openai_keys = user_openai_keys or platform_openai_keys
    if openai_keys:
        base_url = infer_openai_base_url(user_openai_keys or platform_openai_keys or [])
        openai_model = os.environ.get("OPENAI_MODEL", "").strip()
        if not openai_model:
            openai_model = DEFAULT_OPENROUTER_MODEL if "openrouter.ai" in base_url else DEFAULT_OPENAI_MODEL
        providers.append(OpenAIProvider(api_keys=openai_keys, model=openai_model, base_url=base_url))

    platform_gemini_keys = load_keys_from_env(
        multi_env="GEMINI_API_KEYS",
        single_env="GEMINI_API_KEY",
        file_env="GEMINI_API_KEYS_FILE",
    )
    gemini_keys = _tiered_keys(user_keys.get("gemini"), platform_gemini_keys)
    if gemini_keys:
        gemini_model = os.environ.get("GEMINI_MODEL", DEFAULT_GEMINI_MODEL).strip() or DEFAULT_GEMINI_MODEL
        providers.append(GeminiProvider(api_keys=gemini_keys, model=gemini_model))

    platform_mistral_keys = load_keys_from_env(
        multi_env="MISTRAL_API_KEYS",
        single_env="MISTRAL_API_KEY",
        file_env="MISTRAL_API_KEYS_FILE",
    )
    mistral_keys = _tiered_keys(user_keys.get("mistral"), platform_mistral_keys)
    if mistral_keys:
        mistral_model = os.environ.get("MISTRAL_MODEL", DEFAULT_MISTRAL_MODEL).strip() or DEFAULT_MISTRAL_MODEL
        providers.append(MistralProvider(api_keys=mistral_keys, model=mistral_model))

    # Groq has one fixed base_url regardless of key source, so unlike the
    # "openai" slot above there's no base_url ambiguity -- always safe to tier.
    platform_groq_keys = load_keys_from_env(
        multi_env="GROQ_API_KEYS",
        single_env="GROQ_API_KEY",
        file_env="GROQ_API_KEYS_FILE",
    )
    groq_keys = _tiered_keys(user_keys.get("groq"), platform_groq_keys)
    if groq_keys:
        groq_model = os.environ.get("GROQ_MODEL", DEFAULT_GROQ_MODEL).strip() or DEFAULT_GROQ_MODEL
        providers.append(OpenAIProvider(api_keys=groq_keys, model=groq_model, base_url=GROQ_BASE_URL))

    return providers


def format_provider_status(providers: Sequence[ChatProvider]) -> str:
    lines = []
    for provider in providers:
        lines.append(f"- {provider.name}: model={provider.model}, keys={provider.size()}")
    return "\n".join(lines) if lines else "(no providers configured)"


def load_chat_history() -> List[Dict[str, str]]:
    if HISTORY_FILE.exists():
        try:
            with HISTORY_FILE.open("r", encoding="utf-8") as handle:
                data = json.load(handle)
            if isinstance(data, list):
                return [msg for msg in data if isinstance(msg, dict) and "role" in msg and "content" in msg]
        except Exception as exc:
            logger.warning("Failed to load chat history, starting clean: %s", exc)
    return []


def save_chat_history(history: Sequence[Dict[str, str]]) -> None:
    HISTORY_FILE.write_text(json.dumps(list(history), indent=2, ensure_ascii=False), encoding="utf-8")


def read_source_text(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix not in ALLOWED_SOURCE_EXTENSIONS:
        return ""

    try:
        raw = path.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return ""

    if suffix in {".html", ".htm", ".xml"}:
        raw = re.sub(r"<[^>]+>", " ", raw)
    return normalize_whitespace(raw)


def chunk_text(text: str, max_chars: int = 850) -> List[str]:
    if not text:
        return []
    paragraphs = [p.strip() for p in text.split("\n") if p.strip()]
    if not paragraphs:
        paragraphs = [text]
    chunks: List[str] = []
    current: List[str] = []
    current_len = 0
    for paragraph in paragraphs:
        piece = paragraph.strip()
        if not piece:
            continue
        if current_len + len(piece) + 1 > max_chars and current:
            chunks.append(" ".join(current))
            current = [piece]
            current_len = len(piece)
        else:
            current.append(piece)
            current_len += len(piece) + 1
    if current:
        chunks.append(" ".join(current))
    return chunks


def _term_frequencies(tokens: Sequence[str]) -> Dict[str, int]:
    tf: Dict[str, int] = {}
    for token in tokens:
        tf[token] = tf.get(token, 0) + 1
    return tf


def _compute_idf(chunks: Sequence[SourceChunk]) -> Dict[str, float]:
    doc_count = len(chunks)
    if doc_count == 0:
        return {}
    df: Dict[str, int] = {}
    for chunk in chunks:
        for token in chunk.tokens:
            df[token] = df.get(token, 0) + 1
    idf: Dict[str, float] = {}
    for token, freq in df.items():
        idf[token] = 1.0 + math.log(doc_count / (1.0 + freq))
    return idf


def _bm25_score(
    chunk: SourceChunk,
    q_tf: Dict[str, int],
    idf: Dict[str, float],
    avg_len: float,
    k1: float = 1.5,
    b: float = 0.75,
) -> float:
    if chunk.length == 0:
        return 0.0
    norm = 1.0 - b + b * (chunk.length / avg_len)
    score = 0.0
    for term, q_freq in q_tf.items():
        if term not in chunk.tf:
            continue
        df = chunk.tf[term] * (k1 + 1.0) / (chunk.tf[term] + k1 * norm)
        idf_term = idf.get(term, 1.5)
        score += q_freq * idf_term * df
    return score


class SourceIndex:
    def __init__(self, source_dir: Path) -> None:
        self.source_dir = source_dir
        self.chunks: List[SourceChunk] = []
        self.loaded_files: List[Path] = []
        self._idf: Dict[str, float] = {}
        self._avg_len = 0.0

    def refresh(self) -> None:
        self.source_dir.mkdir(parents=True, exist_ok=True)
        chunks: List[SourceChunk] = []
        loaded: List[Path] = []

        for path in sorted(self.source_dir.rglob("*")):
            if not path.is_file():
                continue
            if path.suffix.lower() not in ALLOWED_SOURCE_EXTENSIONS:
                continue
            if path.stat().st_size > 7 * 1024 * 1024:
                continue
            text = read_source_text(path)
            if not text:
                continue
            loaded.append(path)
            for piece in chunk_text(text):
                tokens = tokenize(piece)
                if not tokens:
                    continue
                source_id = f"S{len(chunks) + 1}"
                chunks.append(
                    SourceChunk(
                        source_id=source_id,
                        path=path,
                        text=piece,
                        tokens=set(tokens),
                        tf=_term_frequencies(tokens),
                        length=len(tokens),
                    )
                )

        self.chunks = chunks
        self.loaded_files = loaded
        self._idf = _compute_idf(chunks)
        if chunks:
            self._avg_len = sum(c.length for c in chunks) / len(chunks)

    def retrieve(self, query: str, top_k: int = TOP_K_SOURCES) -> List[SourceChunk]:
        if not self.chunks:
            return []
        q_tokens = tokenize(query)
        if not q_tokens:
            return []

        q_tf = _term_frequencies(q_tokens)
        scored: List[Tuple[float, SourceChunk]] = []
        avg_len = self._avg_len or 1.0
        for chunk in self.chunks:
            score = _bm25_score(chunk, q_tf, self._idf, avg_len)
            if score <= 0.0:
                continue
            scored.append((score, chunk))

        scored.sort(key=lambda item: item[0], reverse=True)
        return [chunk for _, chunk in scored[:top_k]]


def format_sources_for_prompt(sources: Sequence[SourceChunk]) -> str:
    if not sources:
        return (
            "No local sources are relevant to this question. Answer from your own general "
            "knowledge instead -- do not refuse just because there's no local document to cite, "
            "and don't claim local-source support you don't have."
        )
    lines = []
    for item in sources:
        lines.append(f"[{item.source_id}] {item.path.name}: {item.text[:700]}")
    return "\n".join(lines)


def format_sources_for_user(sources: Sequence[SourceChunk]) -> str:
    if not sources:
        return "(no source snippets matched this question)"
    lines = []
    for item in sources:
        lines.append(f"- [{item.source_id}] {item.path}")
    return "\n".join(lines)


def source_support_score(answer: str, sources: Sequence[SourceChunk]) -> float:
    if not answer:
        return 0.0
    if not sources:
        return 0.55

    source_token_sets = [chunk.tokens for chunk in sources]
    sentences = [s.strip() for s in re.split(r"[.!?]\s+", answer) if len(s.strip()) > 25]
    if not sentences:
        return 0.5

    supported = 0
    for sentence in sentences:
        sentence_tokens = set(tokenize(sentence))
        if not sentence_tokens:
            continue
        best_overlap = 0.0
        for token_set in source_token_sets:
            overlap = len(sentence_tokens & token_set) / max(1, len(sentence_tokens))
            if overlap > best_overlap:
                best_overlap = overlap
        has_citation = bool(re.search(r"\[S\d+\]", sentence))
        if best_overlap >= 0.18 or has_citation:
            supported += 1

    return supported / max(1, len(sentences))


def bias_score(answer: str) -> float:
    if not answer:
        return 0.0
    words = [w.lower() for w in TOKEN_RE.findall(answer)]
    if not words:
        return 0.5
    abs_hits = sum(1 for w in words if w in ABSOLUTE_WORDS)
    citation_hits = len(re.findall(r"\[S\d+\]", answer))
    penalty = 0.07 * abs_hits
    bonus = min(0.25, 0.03 * citation_hits)
    return max(0.0, min(1.0, 0.75 - penalty + bonus))


def clarity_score(answer: str) -> float:
    words = answer.split()
    word_count = len(words)
    if word_count < 35:
        length_score = 0.5
    elif word_count <= 280:
        length_score = 1.0
    elif word_count <= 500:
        length_score = 0.75
    else:
        length_score = 0.55
    structure_bonus = 1.0 if ("\n-" in answer or "\n1." in answer) else 0.85
    return max(0.0, min(1.0, 0.7 * length_score + 0.3 * structure_bonus))


def select_bot_configs(bot_count: int) -> List[Tuple[str, str]]:
    configs: List[Tuple[str, str]] = []
    idx = 0
    while len(configs) < bot_count:
        persona = BOT_PERSONAS[idx % len(BOT_PERSONAS)]
        suffix = "" if idx < len(BOT_PERSONAS) else f" #{idx + 1}"
        configs.append((persona[0] + suffix, persona[1]))
        idx += 1
    return configs


def generate_candidate(
    provider: ChatProvider,
    history: Sequence[Dict[str, str]],
    user_input: str,
    source_context: str,
    bot_name: str,
    bot_instruction: str,
    privacy_redaction: bool,
    gen_p: "GenerationConfig" = GenerationConfig(),
    timeout_seconds: float = PROVIDER_TIMEOUT_SECONDS,
) -> str:
    safe_user_input = redact_sensitive(user_input) if privacy_redaction else user_input
    recent_history = list(history[-MAX_HISTORY_MESSAGES:])
    if privacy_redaction:
        recent_history = [
            {"role": item["role"], "content": redact_sensitive(item["content"])} for item in recent_history
        ]

    system_prompt = (
        SYSTEM_PROMPT_BASE.strip()
        + "\nPersona: "
        + bot_name
        + ". "
        + bot_instruction
        + "\nKeep final answer practical and concise."
    )
    task_prompt = (
        "User request:\n"
        f"{safe_user_input}\n\n"
        "Local sources:\n"
        f"{source_context}\n\n"
        "Answer rules:\n"
        "- Use citations [S#] for factual statements when possible.\n"
        "- If a fact is unsupported, label it as uncertain.\n"
        "- Avoid one-sided framing. Present tradeoffs.\n"
        "- Do not reveal sensitive identifiers.\n"
    )

    messages = [{"role": "system", "content": system_prompt}]
    messages.extend(recent_history)
    messages.append({"role": "user", "content": task_prompt})
    return _call_with_timeout(
        provider.chat, timeout_seconds, messages=messages, temperature=gen_p.temperature, gen_p=gen_p
    )


def maybe_refine_prompt(user_input: str) -> str:
    """Best-effort "AI helping the prompt" pre-processing step.

    Runs the trained prompt-refiner TinyGPT (see train/prompt_refiner_data.py)
    on the raw user prompt before it reaches retrieval or the bot personas.
    Returns the input unchanged whenever the trained model isn't available or
    refinement fails -- this must never block a query.
    """
    try:
        from local_models import refine_prompt

        refined = refine_prompt(user_input)
        return refined or user_input
    except Exception:
        return user_input


def run_deep_review(
    answer: str,
    sources: Sequence[SourceChunk],
    providers: Sequence[ChatProvider],
    exclude_provider: "ChatProvider | None" = None,
    privacy_redaction: bool = True,
) -> float | None:
    """Optional second-pass verification: ask one more provider to rate
    confidence in the answer that already won synthesis.

    Deliberately a single extra call, not another full ensemble round --
    "Deep Review" cross-checks the answer, it doesn't re-run the pipeline.
    Falls back to the same heuristic scores used elsewhere in this file when
    the LLM doesn't return a clean number, and returns None (not 0.0) when no
    provider is available at all, so callers can tell "unavailable" apart
    from "scored zero".
    """
    if not providers:
        return None

    reviewer = next((p for p in providers if p is not exclude_provider), providers[0])

    source_context = format_sources_for_prompt(sources)
    safe_answer = redact_sensitive(answer) if privacy_redaction else answer
    prompt = (
        "You are a strict fact-checker. Rate your confidence, from 0 to 100, "
        "that the ANSWER below is accurate, well-supported by the SOURCES, and "
        "free of one-sided bias. Respond with ONLY the number, nothing else.\n\n"
        f"SOURCES:\n{source_context}\n\n"
        f"ANSWER:\n{safe_answer}\n\n"
        "Confidence (0-100):"
    )
    messages = [
        {"role": "system", "content": "Respond with a single integer 0-100 and nothing else."},
        {"role": "user", "content": prompt},
    ]

    try:
        reply = _call_with_timeout(
            reviewer.chat,
            JUDGE_TIMEOUT_SECONDS,
            messages=messages,
            temperature=0.0,
            gen_p=GenerationConfig(temperature=0.0, max_tokens=10),
        )
        match = re.search(r"\d{1,3}", reply)
        if match:
            score = max(0, min(100, int(match.group())))
            return round(score / 100, 3)
    except Exception as exc:
        logger.warning("Deep review call failed, falling back to heuristic confidence: %s", exc)

    # Fallback: heuristic re-score of the final answer, no extra call needed.
    return round(
        0.50 * source_support_score(answer, sources) + 0.25 * bias_score(answer) + 0.25 * clarity_score(answer),
        3,
    )


def _generate_candidates(
    providers: Sequence[ChatProvider],
    history: Sequence[Dict[str, str]],
    user_input: str,
    source_context: str,
    sources: Sequence[SourceChunk],
    bot_configs: Sequence[Tuple[str, str]],
    privacy_redaction: bool,
    gen_p: "GenerationConfig",
    timeout_seconds: float = PROVIDER_TIMEOUT_SECONDS,
) -> Tuple[List[Candidate], List[Dict[str, str]]]:
    """Fan out one call per (bot, provider) pair in parallel and score each
    reply. Shared by build_ensemble_answer and build_ensemble_answer_stream
    so the two code paths can't drift on how candidates are produced/scored.

    Returns (candidates, provider_failures). `candidates` includes a failed
    bot's entry too (text="(bot failed: <reason>)", total_score=0.0, same as
    before this function classified failures) so existing callers that filter
    on that marker keep working unchanged; `provider_failures` is the new,
    structured, sanitized list (provider_name/bot_name/reason only -- never
    the raw exception or a key) for surfacing to the API response.
    """
    candidates: List[Candidate] = []
    provider_failures: List[Dict[str, str]] = []
    with ThreadPoolExecutor(max_workers=max(1, len(bot_configs))) as executor:
        future_map = {}
        for idx, (bot_name, instruction) in enumerate(bot_configs):
            provider_index = idx % len(providers)
            provider = providers[provider_index]
            future = executor.submit(
                generate_candidate,
                provider,
                history,
                user_input,
                source_context,
                bot_name,
                instruction,
                privacy_redaction,
                gen_p,
                timeout_seconds,
            )
            future_map[future] = (bot_name, provider_index)

        for future in as_completed(future_map):
            bot_name, provider_index = future_map[future]
            provider_name = providers[provider_index].name
            try:
                text = future.result().strip()
                s_score = source_support_score(text, sources)
                b_score = bias_score(text)
                c_score = clarity_score(text)
                try:
                    from local_models import blend_score

                    s_score, b_score, c_score = blend_score(text, sources, s_score, b_score, c_score)
                except Exception:
                    pass
                total = (0.50 * s_score) + (0.25 * b_score) + (0.25 * c_score)
            except Exception as exc:
                reason = classify_failure(exc)
                text = f"(bot failed: {reason})"
                s_score = 0.0
                b_score = 0.0
                c_score = 0.0
                total = 0.0
                provider_failures.append({"provider_name": provider_name, "bot_name": bot_name, "reason": reason})
                # classify_failure() deliberately sanitizes `reason` before it
                # reaches the API response (never the raw exception -- see its
                # docstring), which also means operators have no way to see
                # *why* a bot failed from the response alone. Log the real
                # exception server-side only (Vercel function logs / Sentry
                # via ai_client's "ai_client" logger propagating to root --
                # see main.py's logging.basicConfig), not returned to callers.
                logger.error("bot %r (%s) failed: %s", bot_name, provider_name, exc, exc_info=exc)

            candidates.append(
                Candidate(
                    bot_name=bot_name,
                    provider_name=provider_name,
                    provider_index=provider_index,
                    text=text,
                    source_score=s_score,
                    bias_score=b_score,
                    clarity_score=c_score,
                    total_score=total,
                )
            )
    return candidates, provider_failures


def _route_for_query(
    providers: Sequence[ChatProvider],
    user_input: str,
    bot_count: int,
) -> Any:
    """Applies Feature 1 (per-query model routing): classify the prompt,
    narrow providers/personas when confident, otherwise fall back to the
    full ensemble. Logged to stdout (not persisted anywhere) so routing
    behavior can be verified/tuned by watching server logs."""
    from prompt_router import route_prompt

    decision = route_prompt(user_input, providers, BOT_PERSONAS, bot_count)
    if decision.routed:
        logger.info(
            "prompt routed: category=%s confidence=%.2f providers=%s personas=%s",
            decision.category,
            decision.confidence,
            [getattr(p, "name", "?") for p in decision.providers],
            [name for name, _ in decision.bot_configs],
        )
    else:
        logger.info(
            "prompt routing ambiguous/low-confidence (category=%s confidence=%.2f) -- using full ensemble",
            decision.category,
            decision.confidence,
        )
    return decision


def build_ensemble_answer(
    providers: Sequence[ChatProvider],
    history: Sequence[Dict[str, str]],
    user_input: str,
    sources: Sequence[SourceChunk],
    bot_count: int,
    privacy_redaction: bool,
    gen_p: "GenerationConfig" = GenerationConfig(),
    deep_review: bool = False,
    failures_out: "List[Dict[str, str]] | None" = None,
    provider_timeout_seconds: "float | None" = None,
) -> Tuple[str, List[Candidate], Dict[str, float], "float | None"]:
    """`failures_out`, if given a list, gets each failed bot's
    {provider_name, bot_name, reason} appended to it -- an additive,
    optional out-param rather than widening this function's long-depended-on
    4-tuple return (ai_client_app.py, ai_client_ui.py, ai_client_test_ui.py,
    this module's own CLI, and tests/ all unpack that 4-tuple positionally).

    `provider_timeout_seconds`, if given, overrides PROVIDER_TIMEOUT_SECONDS
    for just this call (e.g. a fast, deterministic test of the timeout path
    without waiting on the real default)."""
    timeout_seconds = provider_timeout_seconds if provider_timeout_seconds is not None else PROVIDER_TIMEOUT_SECONDS
    from token_optimizer import optimize_context

    # Trim once per query, reused by every parallel bot call below -- the
    # real saving is this trimmed context times bot_count, not just once.
    optimized = optimize_context(sources, history)
    sources = optimized.sources
    history = optimized.history
    token_savings = optimized.savings.as_dict()

    source_context = format_sources_for_prompt(sources)
    if not providers:
        raise RuntimeError("No providers configured. Set API keys before testing.")

    routing = _route_for_query(providers, user_input, bot_count)
    routed_providers = routing.providers
    bot_configs = routing.bot_configs

    candidates, provider_failures = _generate_candidates(
        routed_providers,
        history,
        user_input,
        source_context,
        sources,
        bot_configs,
        privacy_redaction,
        gen_p,
        timeout_seconds,
    )
    if failures_out is not None:
        failures_out.extend(provider_failures)

    successful = [item for item in candidates if not item.text.startswith("(bot failed:")]
    successful.sort(key=lambda item: item.total_score, reverse=True)
    if not successful:
        raise RuntimeError("All provider calls failed. Check API keys, models, and network access.")

    # A query answered using only the free local fallback model, when a real
    # remote provider was in play for this query but every one of them
    # failed, isn't the ensemble answer a caller is expecting -- refuse it
    # instead of quietly handing back the tiny local model's guess. Doesn't
    # fire for an intentionally local-only provider stack (Feature 4), since
    # then there was never a remote provider in routed_providers to begin with.
    remote_available = any(p.name != LOCAL_PROVIDER_NAME for p in routed_providers)
    remote_successes = [c for c in successful if c.provider_name != LOCAL_PROVIDER_NAME]
    if remote_available and not remote_successes:
        raise NoRemoteProviderAnsweredError(
            "No remote provider answered this query -- refusing to return an answer built only from the local "
            "fallback model."
        )

    top_candidates = successful[:3]
    synthesis_provider = routed_providers[top_candidates[0].provider_index]
    for candidate in top_candidates:
        provider = routed_providers[candidate.provider_index]
        if provider.name != "Local TinyGPT (from scratch)":
            synthesis_provider = provider
            break

    citation_rule = (
        "- Keep citations like [S1] when factual claims are retained.\n"
        if sources
        else "- No local sources were used for this answer -- do not invent or keep any [S#] citation.\n"
    )
    synthesis_prompt = (
        "You are the final judge. Merge the best parts of candidate answers into one superior response.\n"
        "Rules:\n"
        "- Keep only claims with source support or mark as uncertain.\n"
        "- Preserve balanced framing to reduce bias.\n"
        f"{citation_rule}"
        "- If candidates conflict, explain the conflict briefly.\n\n"
        f"User question:\n{redact_sensitive(user_input) if privacy_redaction else user_input}\n\n"
        "Candidate answers:\n"
    )
    for idx, item in enumerate(top_candidates, start=1):
        synthesis_prompt += (
            f"Candidate {idx} ({item.bot_name}, provider={item.provider_name}, score={item.total_score:.2f}):\n"
            f"{item.text}\n\n"
        )

    synthesis_messages = [
        {"role": "system", "content": "Produce one final, practical, unbiased answer."},
        {"role": "user", "content": synthesis_prompt},
    ]

    try:
        synthesis_gen = GenerationConfig(temperature=0.1, max_tokens=gen_p.max_tokens)
        final_answer = _call_with_timeout(
            synthesis_provider.chat,
            JUDGE_TIMEOUT_SECONDS,
            messages=synthesis_messages,
            temperature=0.1,
            gen_p=synthesis_gen,
        )
    except Exception:
        final_answer = successful[0].text

    if detect_sensitive_hits(final_answer):
        final_answer = redact_sensitive(final_answer)

    final_answer = final_answer.strip()

    confidence_score: float | None = None
    if deep_review:
        confidence_score = run_deep_review(
            answer=final_answer,
            sources=sources,
            providers=providers,
            exclude_provider=synthesis_provider,
            privacy_redaction=privacy_redaction,
        )

    return final_answer, successful, token_savings, confidence_score


def build_ensemble_answer_stream(
    providers: Sequence[ChatProvider],
    history: Sequence[Dict[str, str]],
    user_input: str,
    sources: Sequence[SourceChunk],
    bot_count: int,
    privacy_redaction: bool,
    gen_p: "GenerationConfig" = GenerationConfig(),
    deep_review: bool = False,
):
    """Generator twin of build_ensemble_answer (Feature 2: streaming
    synthesis). Candidate generation/scoring is identical (delegates to the
    same _generate_candidates helper, so the two paths can't silently
    diverge); only the final synthesis call is streamed, token by token, as
    it's the one the user is actually waiting on once bots have already run.

    Yields dicts, in order:
      {"event": "status", "stage": "querying_models" | "scoring_candidates" | "synthesizing" | "deep_review"}
      {"event": "token", "text": "..."}            (repeated, as text streams in)
      {"event": "done", "answer": ..., "candidates": [...], "token_savings": {...},
       "confidence_score": float | None, "routing": {...}}

    Falls back to a single "token" event carrying the whole answer when the
    chosen synthesis provider has no chat_stream (see ChatProvider's
    duck-typed `chat_stream`) -- the final "done" event is identical either
    way, so a caller that only cares about the final answer doesn't need to
    special-case either path.
    """
    from token_optimizer import optimize_context

    yield {"event": "status", "stage": "querying_models"}

    optimized = optimize_context(sources, history)
    sources = optimized.sources
    history = optimized.history
    token_savings = optimized.savings.as_dict()

    source_context = format_sources_for_prompt(sources)
    if not providers:
        raise RuntimeError("No providers configured. Set API keys before testing.")

    routing = _route_for_query(providers, user_input, bot_count)
    routed_providers = routing.providers
    bot_configs = routing.bot_configs

    candidates, provider_failures = _generate_candidates(
        routed_providers, history, user_input, source_context, sources, bot_configs, privacy_redaction, gen_p
    )

    yield {"event": "status", "stage": "scoring_candidates"}

    successful = [item for item in candidates if not item.text.startswith("(bot failed:")]
    successful.sort(key=lambda item: item.total_score, reverse=True)
    if not successful:
        raise RuntimeError("All provider calls failed. Check API keys, models, and network access.")

    remote_available = any(p.name != LOCAL_PROVIDER_NAME for p in routed_providers)
    remote_successes = [c for c in successful if c.provider_name != LOCAL_PROVIDER_NAME]
    if remote_available and not remote_successes:
        raise NoRemoteProviderAnsweredError(
            "No remote provider answered this query -- refusing to return an answer built only from the local "
            "fallback model."
        )

    top_candidates = successful[:3]
    synthesis_provider = routed_providers[top_candidates[0].provider_index]
    for candidate in top_candidates:
        provider = routed_providers[candidate.provider_index]
        if provider.name != "Local TinyGPT (from scratch)":
            synthesis_provider = provider
            break

    citation_rule = (
        "- Keep citations like [S1] when factual claims are retained.\n"
        if sources
        else "- No local sources were used for this answer -- do not invent or keep any [S#] citation.\n"
    )
    synthesis_prompt = (
        "You are the final judge. Merge the best parts of candidate answers into one superior response.\n"
        "Rules:\n"
        "- Keep only claims with source support or mark as uncertain.\n"
        "- Preserve balanced framing to reduce bias.\n"
        f"{citation_rule}"
        "- If candidates conflict, explain the conflict briefly.\n\n"
        f"User question:\n{redact_sensitive(user_input) if privacy_redaction else user_input}\n\n"
        "Candidate answers:\n"
    )
    for idx, item in enumerate(top_candidates, start=1):
        synthesis_prompt += (
            f"Candidate {idx} ({item.bot_name}, provider={item.provider_name}, score={item.total_score:.2f}):\n"
            f"{item.text}\n\n"
        )

    synthesis_messages = [
        {"role": "system", "content": "Produce one final, practical, unbiased answer."},
        {"role": "user", "content": synthesis_prompt},
    ]
    synthesis_gen = GenerationConfig(temperature=0.1, max_tokens=gen_p.max_tokens)

    yield {"event": "status", "stage": "synthesizing"}

    final_answer = ""
    stream_fn = getattr(synthesis_provider, "chat_stream", None)
    if stream_fn is not None:
        try:
            raw_stream = stream_fn(messages=synthesis_messages, temperature=0.1, gen_p=synthesis_gen)
            for chunk in _iter_stream_with_timeout(raw_stream, JUDGE_TIMEOUT_SECONDS):
                if not chunk:
                    continue
                final_answer += chunk
                yield {"event": "token", "text": chunk}
        except Exception as exc:
            if final_answer:
                # Partial text already reached the caller -- restarting via
                # the blocking call below would duplicate it client-side, so
                # the partial stream becomes the final answer instead of a
                # clean retry. Logged loudly since this is a real quality
                # degradation, not the ordinary "provider doesn't stream" case.
                logger.warning(
                    "%s streaming synthesis failed mid-stream, keeping partial answer: %s",
                    synthesis_provider.name,
                    exc,
                )
            else:
                logger.warning(
                    "%s streaming synthesis failed before any output, falling back to a blocking call: %s",
                    synthesis_provider.name,
                    exc,
                )
                stream_fn = None

    if stream_fn is None and not final_answer:
        try:
            final_answer = _call_with_timeout(
                synthesis_provider.chat,
                JUDGE_TIMEOUT_SECONDS,
                messages=synthesis_messages,
                temperature=0.1,
                gen_p=synthesis_gen,
            )
        except Exception:
            final_answer = successful[0].text
        yield {"event": "token", "text": final_answer}

    if detect_sensitive_hits(final_answer):
        final_answer = redact_sensitive(final_answer)
        yield {"event": "redacted", "text": final_answer}

    final_answer = final_answer.strip()

    confidence_score: float | None = None
    if deep_review:
        yield {"event": "status", "stage": "deep_review"}
        confidence_score = run_deep_review(
            answer=final_answer,
            sources=sources,
            providers=providers,
            exclude_provider=synthesis_provider,
            privacy_redaction=privacy_redaction,
        )

    yield {
        "event": "done",
        "answer": final_answer,
        "candidates": successful,
        "token_savings": token_savings,
        "confidence_score": confidence_score,
        "routing": {"category": routing.category, "confidence": routing.confidence, "routed": routing.routed},
        "provider_failures": provider_failures,
    }


def print_help() -> None:
    print("Commands:")
    print("  /help            Show commands")
    print("  /quit            Exit")
    print("  /providers       Show loaded providers/models/key counts")
    print("  /sources         List currently indexed local source files")
    print("  /reload          Rebuild source index from knowledge_sources/")
    print("  /upload-guide    Show what file types to upload by topic")
    print("  /privacy on|off  Toggle local redaction before API calls")
    print("  /history on|off  Toggle local chat history persistence")


def print_upload_guide() -> None:
    print("Upload guide (place files under knowledge_sources/):")
    print(f"Accepted file types: {', '.join(sorted(ALLOWED_SOURCE_EXTENSIONS))}")
    for topic, files in UPLOAD_GUIDE.items():
        print(f"- {topic}:")
        for item in files:
            print(f"    * {item}")
    print("Avoid uploading secrets. Redaction is best-effort, not perfect.")


def handle_command(
    command: str,
    source_index: SourceIndex,
    providers: Sequence[ChatProvider],
    runtime_flags: Dict[str, bool],
) -> bool:
    parts = command.strip().split()
    head = parts[0].lower()

    if head == "/help":
        print_help()
        return True
    if head == "/quit":
        raise KeyboardInterrupt
    if head == "/providers":
        print("Loaded providers:")
        print(format_provider_status(providers))
        return True
    if head == "/sources":
        if not source_index.loaded_files:
            print(f"No source files loaded yet. Put files in: {SOURCES_DIR}")
        else:
            print("Indexed source files:")
            for file_path in source_index.loaded_files:
                print(f"- {file_path}")
        return True
    if head == "/reload":
        source_index.refresh()
        print(f"Reloaded sources: {len(source_index.loaded_files)} files, {len(source_index.chunks)} chunks.")
        return True
    if head == "/upload-guide":
        print_upload_guide()
        return True
    if head == "/privacy" and len(parts) == 2:
        value = parts[1].lower()
        if value in {"on", "off"}:
            runtime_flags["privacy_redaction"] = value == "on"
            print(f"Privacy redaction set to: {runtime_flags['privacy_redaction']}")
            return True
    if head == "/history" and len(parts) == 2:
        value = parts[1].lower()
        if value in {"on", "off"}:
            runtime_flags["save_history"] = value == "on"
            print(f"Local history saving set to: {runtime_flags['save_history']}")
            return True
    return False


def main() -> None:
    # Only the interactive CLI configures a real handler -- as a library
    # (e.g. imported by the FastAPI query-ensemble function) this module
    # stays silent by default via the NullHandler set up above.
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")

    providers = build_provider_stack()
    if not providers:
        print("No provider API keys found.")
        print("Set at least one provider key set before starting:")
        print("  export OPENAI_API_KEYS='k1,k2' or OPENAI_API_KEY='k1'")
        print("  export GEMINI_API_KEYS='k1,k2' or GEMINI_API_KEY='k1'")
        print("  export MISTRAL_API_KEYS='k1,k2' or MISTRAL_API_KEY='k1'")
        print("  export GROQ_API_KEYS='k1,k2' or GROQ_API_KEY='k1'")
        return

    requested_bots = parse_int_env("BOT_COUNT", default=4, minimum=2, maximum=MAX_PARALLEL_BOTS)
    bot_count = max(requested_bots, len(providers))

    source_index = SourceIndex(SOURCES_DIR)
    source_index.refresh()

    runtime_flags = {
        "save_history": parse_bool_env("SAVE_HISTORY", SAVE_HISTORY_DEFAULT),
        "privacy_redaction": parse_bool_env("PRIVACY_REDACTION", PRIVACY_REDACTION_DEFAULT),
    }
    chat_history = load_chat_history() if runtime_flags["save_history"] else []

    print("Multi-bot AI client started.")
    print(f"Parallel bots: {bot_count}")
    print("Providers:")
    print(format_provider_status(providers))
    print(f"Local sources: {len(source_index.loaded_files)} files, {len(source_index.chunks)} chunks")
    print("Privacy mode: local redaction is", "ON" if runtime_flags["privacy_redaction"] else "OFF")
    print("Type /help for commands, /quit to exit.")
    print("-" * 64)

    while True:
        try:
            user_input = input("You: ").strip()
            if not user_input:
                continue

            if user_input.startswith("/"):
                handled = handle_command(user_input, source_index, providers, runtime_flags)
                if not handled:
                    print("Unknown command. Type /help for available commands.")
                continue

            if runtime_flags["privacy_redaction"]:
                redaction_hits = detect_sensitive_hits(user_input)
                if redaction_hits:
                    print("Privacy warning: sensitive patterns detected in your prompt -> " + ", ".join(redaction_hits))
                    print("The prompt will be redacted before it is sent to remote APIs.")

            refined_input = maybe_refine_prompt(user_input)
            if refined_input != user_input:
                print(f"(refined prompt: {refined_input})")

            retrieved_sources = source_index.retrieve(refined_input, top_k=TOP_K_SOURCES)
            answer, candidates, token_savings, confidence_score = build_ensemble_answer(
                providers=providers,
                history=chat_history,
                user_input=refined_input,
                sources=retrieved_sources,
                bot_count=bot_count,
                privacy_redaction=runtime_flags["privacy_redaction"],
            )

            print("\nAI:")
            print(answer)
            if token_savings["tokens_saved"] > 0:
                print(
                    f"(context optimizer: ~{token_savings['tokens_saved']} tokens saved "
                    f"per bot call, {token_savings['tokens_saved_pct']}%)"
                )
            print("\nSource checks:")
            print(format_sources_for_user(retrieved_sources))
            print("\nResponse checks:")
            print(
                f"- top candidate: {candidates[0].bot_name} via {candidates[0].provider_name}"
                f" (score={candidates[0].total_score:.2f})"
            )
            print(f"- source support score: {source_support_score(answer, retrieved_sources):.2f}")
            print(f"- bias score: {bias_score(answer):.2f}")
            print("- leakage scan:", "OK" if not detect_sensitive_hits(answer) else "REDACTED")
            print("-" * 64)

            if runtime_flags["save_history"]:
                chat_history.append({"role": "user", "content": user_input})
                chat_history.append({"role": "assistant", "content": answer})
                save_chat_history(chat_history)

        except KeyboardInterrupt:
            print("\nGoodbye!")
            break
        except Exception as exc:
            print(f"Error: {exc}")


if __name__ == "__main__":
    main()
