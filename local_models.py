"""Integration layer: trained Multi-LLM models inside the ensemble.

Adds two capabilities to the ai_client.py architecture:
  1. LocalTransformerProvider  — an offline ensemble candidate. It generates
     answers in the multi-bot style (citations [S#], tradeoffs, uncertainty)
     without any API key or network call, so it can always participate.
  2. model_score_answer        — replaces the heuristic scoring functions with
     the trained TinyScorer. It returns (source_support, bias, clarity).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List, Optional, Sequence

from ai_client import GenerationConfig

BASE_DIR = Path(__file__).resolve().parent
MODELS_DIR = BASE_DIR / "models"
GENERATOR_DIR = MODELS_DIR / "ensemble-generator"
SCORER_DIR = MODELS_DIR / "ensemble-scorer"
REFINER_DIR = MODELS_DIR / "prompt-refiner"
TOKENIZER_PATH = MODELS_DIR / "tokenizer.json"
SCORER_TOKENIZER_PATH = MODELS_DIR / "scorer-tokenizer.json"
REFINER_TOKENIZER_PATH = MODELS_DIR / "refiner-tokenizer.json"


class LocalModels:
    """Lazy loader that keeps the tiny models resident once loaded."""

    def __init__(self, device: str = "auto") -> None:
        self.device = device
        self._tokenizer = None
        self._scorer_tokenizer = None
        self._generator = None
        self._scorer = None
        self._refiner_tokenizer = None
        self._refiner = None

    def available(self) -> bool:
        return (
            GENERATOR_DIR.exists()
            and SCORER_DIR.exists()
            and TOKENIZER_PATH.exists()
            and SCORER_TOKENIZER_PATH.exists()
        )

    def refiner_available(self) -> bool:
        return REFINER_DIR.exists() and REFINER_TOKENIZER_PATH.exists()

    def _pick_device(self) -> str:
        if self.device != "auto":
            return self.device
        try:
            import torch

            if torch.backends.mps.is_available():
                return "mps"
            if torch.cuda.is_available():
                return "cuda"
        except Exception:
            pass
        return "cpu"

    def tokenizer(self):
        if self._tokenizer is None:
            from train.model import WordTokenizer

            self._tokenizer = WordTokenizer.load(TOKENIZER_PATH)
        return self._tokenizer

    def scorer_tokenizer(self):
        if self._scorer_tokenizer is None:
            from train.model import WordTokenizer

            self._scorer_tokenizer = WordTokenizer.load(SCORER_TOKENIZER_PATH)
        return self._scorer_tokenizer

    def generator(self):
        if self._generator is None:
            from train.model import TinyGPT

            self._generator = TinyGPT.load(GENERATOR_DIR, device=self._pick_device())
        return self._generator

    def scorer(self):
        if self._scorer is None:
            from train.model import TinyScorer

            self._scorer = TinyScorer.load(SCORER_DIR, device=self._pick_device())
        return self._scorer

    def generator_info(self) -> Dict:
        cfg = json.loads((GENERATOR_DIR / "config.json").read_text(encoding="utf-8"))
        return cfg

    def refiner_tokenizer(self):
        if self._refiner_tokenizer is None:
            from train.model import WordTokenizer

            self._refiner_tokenizer = WordTokenizer.load(REFINER_TOKENIZER_PATH)
        return self._refiner_tokenizer

    def refiner(self):
        if self._refiner is None:
            from train.model import TinyGPT

            self._refiner = TinyGPT.load(REFINER_DIR, device=self._pick_device())
        return self._refiner


def _build_local_prompt(messages: Sequence[Dict[str, str]]) -> str:
    """Reconstruct the exact chat format the model was trained on.

    Training docs look like:

        <|user|>
        User request:\n...
        Local sources:\n...
        Answer rules:\n...
        <|assistant|>
        Persona: <name>. <instruction>
        Keep final answer practical and concise.
        Bot answer:\n...

    The system message carries the persona and the last user message carries
    the task (User request / Local sources / Answer rules), so we map them
    directly instead of flattening with "SYSTEM:/USER:" prefixes the model has
    never seen.
    """
    from ai_client import SYSTEM_PROMPT_BASE

    persona_lines: List[str] = []
    task_lines: List[str] = []
    for msg in messages:
        role = (msg.get("role") or "").lower()
        content = (msg.get("content") or "").strip()
        if not content:
            continue
        if role == "system":
            body = content
            if body.startswith(SYSTEM_PROMPT_BASE.strip()):
                body = body[len(SYSTEM_PROMPT_BASE.strip()) :].strip()
            persona_lines.append(body)
        elif role == "user":
            task_lines.append(content)

    persona = " ".join(line.strip() for line in persona_lines if line.strip()) or "Neutral Teacher. Explain clearly."
    task = "\n\n".join(line.strip() for line in task_lines if line.strip())

    if task.startswith("User request:"):
        user_block = task
    else:
        user_block = f"User request:\n{task}"

    prompt = (
        f"<|user|>\n{user_block}\n<|assistant|>\n{persona}\nKeep final answer practical and concise.\nBot answer:\n"
    )
    return prompt


_LOCAL = LocalModels()


class LocalTransformerProvider:
    """A ChatProvider backed by the locally trained TinyGPT model.

    Produces offline candidate answers using the ensemble answering style.
    Falls back gracefully when the trained model is missing.
    """

    def __init__(self, temperature: float = 0.7, max_tokens: int = 450) -> None:
        self.name = "Local TinyGPT (from scratch)"
        self.model = "ensemble-generator (6-layer TinyGPT)"
        self.temperature = temperature
        self.max_tokens = max_tokens

    def size(self) -> int:
        return 1 if _LOCAL.available() else 0

    def chat(
        self,
        messages: Sequence[Dict[str, str]],
        temperature: float,
        gen_p: "GenerationConfig | None" = None,
    ) -> str:
        from ai_client import redact_sensitive

        if not _LOCAL.available():
            raise RuntimeError("Trained model not found. Run: python -m train.train")

        prompt = _build_local_prompt(messages)
        prompt = redact_sensitive(prompt)

        tokenizer = _LOCAL.tokenizer()
        model = _LOCAL.generator()
        temp = gen_p.temperature if gen_p is not None else temperature

        seed_ids = tokenizer.encode(prompt)
        import torch

        device = next(model.parameters()).device
        seed = torch.tensor([seed_ids], dtype=torch.long, device=device)
        max_tokens = gen_p.max_tokens if gen_p is not None and gen_p.max_tokens else self.max_tokens
        with torch.no_grad():
            out = model.generate(seed, max_new_tokens=max_tokens, temperature=temp, top_k=40, repetition_penalty=1.3)
        text = tokenizer.decode(out[0].tolist()[len(seed_ids) :])
        # Trim trailing special tokens or repeated block markers. generate()
        # never stops early (see model.py), so an undertrained/out-of-domain
        # continuation commonly wanders into a hallucinated next training
        # example -- "<|assistant|>" marks that example's own turn boundary,
        # same as "<|user|>" marks its start, so both must be trimmed.
        for marker in ("<|end|>", "<|endoftext|>", "<|user|>", "<|assistant|>"):
            idx = text.find(marker)
            if idx != -1:
                text = text[:idx]
        return text.strip() or "(local model produced an empty candidate)"


def refine_prompt(raw_prompt: str, max_new_tokens: int = 40) -> str:
    """Rewrite a rough user prompt into a clearer one with the trained refiner.

    "AI helping the prompt": a small TinyGPT trained on (rough -> clear)
    question pairs runs before the ensemble, so retrieval and the bot
    personas see a better-phrased question. Falls back to the original
    prompt unchanged whenever the trained model is missing or generation
    fails -- this step must never block a query.
    """
    raw_prompt = (raw_prompt or "").strip()
    if not raw_prompt or not _LOCAL.refiner_available():
        return raw_prompt

    try:
        from ai_client import redact_sensitive

        tokenizer = _LOCAL.refiner_tokenizer()
        model = _LOCAL.refiner()

        seed_prompt = f"<|user|>\nRaw prompt:\n{redact_sensitive(raw_prompt)}\n<|assistant|>\nRefined prompt:\n"
        seed_ids = tokenizer.encode(seed_prompt)

        import torch

        device = next(model.parameters()).device
        seed = torch.tensor([seed_ids], dtype=torch.long, device=device)
        with torch.no_grad():
            out = model.generate(seed, max_new_tokens=max_new_tokens, temperature=0.3, top_k=20, repetition_penalty=1.2)
        text = tokenizer.decode(out[0].tolist()[len(seed_ids) :])
        for marker in ("<|end|>", "<|endoftext|>", "<|user|>", "<|assistant|>"):
            idx = text.find(marker)
            if idx != -1:
                text = text[:idx]
        text = text.strip()
        return text or raw_prompt
    except Exception:
        return raw_prompt


def model_score_answer(
    answer: str,
    sources: Sequence = (),
    fallback: bool = True,
) -> Optional[List[float]]:
    """Score an answer with the trained TinyScorer.

    Returns [source_support, bias_score, clarity_score] in 0..1, or None when
    the trained model is unavailable.
    """
    if not _LOCAL.available():
        return None

    try:
        from ai_client import redact_sensitive

        tokenizer = _LOCAL.scorer_tokenizer()
        scorer = _LOCAL.scorer()
        import torch

        block = 192
        encoded = tokenizer.encode(redact_sensitive(answer))[:block]
        padded = encoded + [tokenizer.stoi["<|endoftext|>"]] * (block - len(encoded))
        device = next(scorer.parameters()).device
        idx = torch.tensor([padded], dtype=torch.long, device=device)
        with torch.no_grad():
            pred = scorer(idx)[0].tolist()
        return [float(p) for p in pred]
    except Exception:
        return None


def blend_score(
    answer: str,
    sources: Sequence,
    source_score: float,
    bias_score: float,
    clarity_score: float,
) -> List[float]:
    """Blend heuristic and learned scores when both are available."""
    learned = model_score_answer(answer, sources=sources)
    if learned is None:
        return [source_score, bias_score, clarity_score]
    return [
        0.5 * source_score + 0.5 * learned[0],
        0.5 * bias_score + 0.5 * learned[1],
        0.5 * clarity_score + 0.5 * learned[2],
    ]
