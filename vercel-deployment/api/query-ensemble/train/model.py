# VENDORED COPY -- kept in sync manually with the repo-root train/model.py.
# local_models.py's tokenizer()/generator()/scorer()/refiner() all do
# `from train.model import ...`; this function's Root Directory is
# vercel-deployment/ (see ai_client.py's comment), so that import needs this
# package to exist here too. Only model.py is vendored, not the rest of
# train/ (train.py, dataset.py, ...) -- local-only inference needs just the
# class definitions, none of the training/corpus-generation code.
"""TinyGPT — a small decoder-only transformer trained entirely from scratch.

No pretrained weights are downloaded: the tokenizer is built from the local
corpus and the model starts from random initialization. Designed to run on a
laptop (CPU or MPS).

Two artifacts are produced by this package:
  1. A causal language model (the offline "ensemble candidate" generator).
  2. A small regressor that scores answers for source support, bias, clarity.
"""

from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Dict, List, Sequence

import torch
import torch.nn as nn
import torch.nn.functional as F

SPECIAL_TOKENS = {"<|user|>", "<|assistant|>", "<|end|>", "<|unk|>", "<|endoftext|>"}
WORD_RE = re.compile(r"[A-Za-z0-9_]+|[^A-Za-z0-9_ \t\n]|[ \t]+")


class WordTokenizer:
    """Simple word-level tokenizer with a small set of special tokens."""

    def __init__(self, vocab: Sequence[str]) -> None:
        if "<|endoftext|>" not in vocab:
            vocab = list(vocab) + ["<|endoftext|>"]
        self.vocab = list(vocab)
        self.stoi = {tok: i for i, tok in enumerate(self.vocab)}
        self.itos = {i: tok for i, tok in enumerate(self.vocab)}
        self.unk_idx = self.stoi.get("<|unk|>", 0)

    @classmethod
    def train(cls, texts: Sequence[str], vocab_size: int = 2048) -> "WordTokenizer":
        counts: Dict[str, int] = {}
        for text in texts:
            for piece in WORD_RE.findall(text):
                counts[piece] = counts.get(piece, 0) + 1
        specials = sorted(SPECIAL_TOKENS)
        ranked = sorted(counts.items(), key=lambda kv: kv[1], reverse=True)
        vocab = specials + [tok for tok, _ in ranked[: vocab_size - len(specials)]]
        return cls(vocab)

    def encode(self, text: str) -> List[int]:
        ids: List[int] = []
        for piece in WORD_RE.findall(text):
            idx = self.stoi.get(piece)
            ids.append(self.unk_idx if idx is None else idx)
        return ids

    def decode(self, ids: Sequence[int]) -> str:
        return "".join(self.itos.get(i, "<|unk|>") for i in ids)

    @property
    def vocab_size(self) -> int:
        return len(self.vocab)

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.vocab), encoding="utf-8")

    @classmethod
    def load(cls, path: Path) -> "WordTokenizer":
        vocab = json.loads(path.read_text(encoding="utf-8"))
        return cls(vocab)


class CharacterTokenizer:
    """Simple character-level tokenizer with special tokens."""

    def __init__(self, vocab: Sequence[str]) -> None:
        if "<|endoftext|>" not in vocab:
            vocab = list(vocab) + ["<|endoftext|>"]
        self.vocab = list(vocab)
        self.stoi = {tok: i for i, tok in enumerate(self.vocab)}
        self.itos = {i: tok for i, tok in enumerate(self.vocab)}
        self.unk_idx = self.stoi.get("<|unk|>", 0)

    @classmethod
    def train(cls, texts: Sequence[str], vocab_size: int = 256) -> "CharacterTokenizer":
        chars = set()
        for text in texts:
            chars.update(list(text))
        specials = sorted(SPECIAL_TOKENS)
        vocab = specials + sorted(chars - set(specials))
        if len(vocab) > vocab_size:
            vocab = vocab[:vocab_size]
        return cls(vocab)

    def encode(self, text: str) -> List[int]:
        ids = []
        for char in text:
            idx = self.stoi.get(char)
            ids.append(self.unk_idx if idx is None else idx)
        return ids

    def decode(self, ids: Sequence[int]) -> str:
        return "".join(self.itos.get(i, "<|unk|>") for i in ids)

    @property
    def vocab_size(self) -> int:
        return len(self.vocab)

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.vocab), encoding="utf-8")

    @classmethod
    def load(cls, path: Path) -> "CharacterTokenizer":
        vocab = json.loads(path.read_text(encoding="utf-8"))
        return cls(vocab)


class LayerNorm(nn.Module):
    def __init__(self, dim: int, eps: float = 1e-5) -> None:
        super().__init__()
        self.eps = eps
        self.gamma = nn.Parameter(torch.ones(dim))
        self.beta = nn.Parameter(torch.zeros(dim))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        mean = x.mean(-1, keepdim=True)
        var = x.var(-1, keepdim=True, unbiased=False)
        return self.gamma * (x - mean) / torch.sqrt(var + self.eps) + self.beta


class SelfAttention(nn.Module):
    causal_mask: torch.Tensor

    def __init__(self, n_embd: int, n_head: int, block_size: int, dropout: float) -> None:
        super().__init__()
        assert n_embd % n_head == 0
        self.n_head = n_head
        self.head_dim = n_embd // n_head
        self.query = nn.Linear(n_embd, n_embd, bias=False)
        self.key = nn.Linear(n_embd, n_embd, bias=False)
        self.value = nn.Linear(n_embd, n_embd, bias=False)
        self.proj = nn.Linear(n_embd, n_embd, bias=False)
        self.dropout = nn.Dropout(dropout)
        self.register_buffer("causal_mask", torch.tril(torch.ones(block_size, block_size)).bool())

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        B, T, C = x.shape
        q = self.query(x).view(B, T, self.n_head, self.head_dim).transpose(1, 2)
        k = self.key(x).view(B, T, self.n_head, self.head_dim).transpose(1, 2)
        v = self.value(x).view(B, T, self.n_head, self.head_dim).transpose(1, 2)
        att = (q @ k.transpose(-2, -1)) / math.sqrt(self.head_dim)
        att = att.masked_fill(~self.causal_mask[:T, :T], float("-inf"))
        att = F.softmax(att, dim=-1)
        att = self.dropout(att)
        y = (att @ v).transpose(1, 2).contiguous().view(B, T, C)
        return self.dropout(self.proj(y))


class MLP(nn.Module):
    def __init__(self, n_embd: int, dropout: float) -> None:
        super().__init__()
        self.fc1 = nn.Linear(n_embd, 4 * n_embd)
        self.fc2 = nn.Linear(4 * n_embd, n_embd)
        self.dropout = nn.Dropout(dropout)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.dropout(self.fc2(F.gelu(self.fc1(x))))


class TransformerBlock(nn.Module):
    def __init__(self, n_embd: int, n_head: int, block_size: int, dropout: float) -> None:
        super().__init__()
        self.ln1 = LayerNorm(n_embd)
        self.attn = SelfAttention(n_embd, n_head, block_size, dropout)
        self.ln2 = LayerNorm(n_embd)
        self.mlp = MLP(n_embd, dropout)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = x + self.attn(self.ln1(x))
        x = x + self.mlp(self.ln2(x))
        return x


class TinyGPT(nn.Module):
    """Decoder-only transformer (nanoGPT-style)."""

    def __init__(
        self,
        vocab_size: int,
        block_size: int = 128,
        n_layer: int = 4,
        n_head: int = 4,
        n_embd: int = 96,
        dropout: float = 0.1,
    ) -> None:
        super().__init__()
        self.block_size = block_size
        self.n_embd = n_embd
        self.n_head = n_head
        self.token_embedding = nn.Embedding(vocab_size, n_embd)
        self.position_embedding = nn.Embedding(block_size, n_embd)
        self.blocks = nn.ModuleList([TransformerBlock(n_embd, n_head, block_size, dropout) for _ in range(n_layer)])
        self.ln_f = LayerNorm(n_embd)
        self.lm_head = nn.Linear(n_embd, vocab_size, bias=False)
        self.token_embedding.weight = self.lm_head.weight

    def forward(self, idx: torch.Tensor, targets: torch.Tensor | None = None):
        B, T = idx.shape
        assert T <= self.block_size
        tok = self.token_embedding(idx)
        pos = self.position_embedding(torch.arange(T, device=idx.device))
        x = tok + pos
        for block in self.blocks:
            x = block(x)
        x = self.ln_f(x)
        logits = self.lm_head(x)
        loss = None
        if targets is not None:
            loss = F.cross_entropy(logits.view(-1, logits.size(-1)), targets.view(-1))
        return logits, loss

    @torch.no_grad()
    def generate(
        self,
        idx: torch.Tensor,
        max_new_tokens: int,
        temperature: float = 0.8,
        top_k: int | None = 50,
        repetition_penalty: float = 1.15,
    ) -> torch.Tensor:
        device = self.token_embedding.weight.device
        if idx.device != device:
            idx = idx.to(device)
        generated: List[int] = []
        for _ in range(max_new_tokens):
            idx_cond = idx if idx.size(1) <= self.block_size else idx[:, -self.block_size :]
            logits, _ = self.forward(idx_cond)
            logits = logits[:, -1, :] / temperature
            if repetition_penalty != 1.0 and generated:
                prev = torch.tensor([generated], dtype=torch.long, device=logits.device)
                penalty = torch.full_like(logits, 1.0)
                for tok in prev[0]:
                    penalty[:, tok] = repetition_penalty
                logits = torch.where(logits > 0, logits / penalty, logits * penalty)
            if top_k is not None:
                v, _ = torch.topk(logits, min(top_k, logits.size(-1)))
                logits[logits < v[:, [-1]]] = -float("inf")
            probs = F.softmax(logits, dim=-1)
            next_id = torch.multinomial(probs, num_samples=1)
            idx = torch.cat([idx, next_id], dim=1)
            generated.append(int(next_id[0, 0].item()))
        return idx

    def save(self, dir_path: Path) -> None:
        dir_path.mkdir(parents=True, exist_ok=True)
        torch.save(self.state_dict(), dir_path / "model.pt")
        (dir_path / "config.json").write_text(
            json.dumps(
                {
                    "vocab_size": self.token_embedding.num_embeddings,
                    "block_size": self.block_size,
                    "n_layer": len(self.blocks),
                    "n_head": self.n_head,
                    "n_embd": self.n_embd,
                    "kind": "generator",
                },
                indent=1,
            ),
            encoding="utf-8",
        )

    @classmethod
    def load(cls, dir_path: Path, device: str = "cpu") -> "TinyGPT":
        cfg = json.loads((dir_path / "config.json").read_text(encoding="utf-8"))
        model = cls(
            vocab_size=cfg["vocab_size"],
            block_size=cfg["block_size"],
            n_layer=cfg["n_layer"],
            n_head=cfg["n_head"],
            n_embd=cfg["n_embd"],
        )
        # Load on CPU first: torch.load(map_location="mps") triggers the
        # "Placeholder storage has not been allocated on MPS device" bug for
        # checkpoints saved mid-training on MPS. Moving after loading avoids it.
        model.load_state_dict(torch.load(dir_path / "model.pt", map_location="cpu"))
        model.eval()
        if device != "cpu":
            model = model.to(device)
        return model


class TinyScorer(nn.Module):
    """Regresses 3 answer-quality scores from mean-pooled token embeddings."""

    def __init__(
        self,
        vocab_size: int,
        block_size: int = 192,
        n_embd: int = 96,
        n_layer: int = 2,
        n_head: int = 3,
        dropout: float = 0.1,
    ) -> None:
        super().__init__()
        self.block_size = block_size
        self.n_embd = n_embd
        self.n_layer = n_layer
        self.n_head = n_head
        self.token_embedding = nn.Embedding(vocab_size, n_embd)
        self.position_embedding = nn.Embedding(block_size, n_embd)
        self.blocks = nn.ModuleList([TransformerBlock(n_embd, n_head, block_size, dropout) for _ in range(n_layer)])
        self.ln_f = LayerNorm(n_embd)
        self.head = nn.Sequential(
            nn.Linear(n_embd, 32),
            nn.GELU(),
            nn.Linear(32, 3),
        )

    def forward(self, idx: torch.Tensor) -> torch.Tensor:
        B, T = idx.shape
        T = min(T, self.block_size)
        idx = idx[:, :T]
        tok = self.token_embedding(idx)
        pos = self.position_embedding(torch.arange(T, device=idx.device))
        x = tok + pos
        for block in self.blocks:
            x = block(x)
        x = self.ln_f(x)
        pooled = x.mean(dim=1)
        return torch.sigmoid(self.head(pooled))

    def save(self, dir_path: Path) -> None:
        dir_path.mkdir(parents=True, exist_ok=True)
        torch.save(self.state_dict(), dir_path / "model.pt")
        (dir_path / "config.json").write_text(
            json.dumps(
                {
                    "vocab_size": self.token_embedding.num_embeddings,
                    "block_size": self.block_size,
                    "n_embd": self.n_embd,
                    "n_layer": len(self.blocks),
                    "n_head": self.n_head,
                    "kind": "scorer",
                },
                indent=1,
            ),
            encoding="utf-8",
        )

    @classmethod
    def load(cls, dir_path: Path, device: str = "cpu") -> "TinyScorer":
        cfg = json.loads((dir_path / "config.json").read_text(encoding="utf-8"))
        model = cls(
            vocab_size=cfg["vocab_size"],
            block_size=cfg["block_size"],
            n_embd=cfg["n_embd"],
            n_layer=cfg["n_layer"],
            n_head=cfg["n_head"],
        )
        model.load_state_dict(torch.load(dir_path / "model.pt", map_location="cpu"))
        model.eval()
        if device != "cpu":
            model = model.to(device)
        return model
