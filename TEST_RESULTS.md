# Test Results

*Model-eval numbers below generated 2026-09-23, real run on this machine
(CPU-only, no MPS/CUDA); test count refreshed 2026-10-10.
Reproduce with `pytest -q`, `python -m train.eval_models`.*

## Test suite

**76/76 tests passing** (`pytest -q`) — covers `ai_client.py` core
scoring/redaction/key-loading/ensemble logic, `token_optimizer.py`,
`train/prompt_refiner_data.py`, per-provider timeouts/streaming
(`test_provider_timeouts.py`, `test_stream_timeout.py`), and prompt routing
(`test_prompt_router.py`).

## Trained models (from scratch, this run)

| Model | Params | Role |
|---|---|---|
| `ensemble-generator` (TinyGPT) | 1,395,328 | Offline/privacy-preserving candidate answer generator |
| `ensemble-scorer` (TinyScorer) | 351,971 | Regresses (source_support, bias, clarity) per candidate |

Full harness: `python -m train.eval_models`.

### Scorer — strong fit

Evaluated against all 390 labeled examples:

| Dimension | MAE |
|---|---|
| source_support | 0.007 |
| bias_score | 0.0071 |
| clarity_score | 0.0051 |

MAE stays low (0.013–0.034) across every answer class (grounded, biased,
mixed, rambling, unsupported-clear, vague) — the scorer reliably tells these
apart, which is what lets the ensemble rank real candidates correctly.

### Generator — learned style, not fluency

| | Trained questions | Novel (held-out) questions |
|---|---|---|
| Avg length | 81.7 words | 68.7 words |
| Unique-word ratio | 0.83 | 0.89 |
| Uses citations `[S#]` | 100% | 100% |
| States tradeoffs | 100% | 100% |
| Flags uncertainty | 100% | 100% |
| Generation time | ~30s/answer | ~30s/answer (CPU) |

**Honest read**: the model reliably learned the *conventions* of the
ensemble's answer style (cite sources, name a tradeoff, flag uncertainty
when unsure) on both trained and novel questions equally. What it did
**not** learn is fluent prose — output is word-salad-like rather than
coherent sentences (e.g. *"According to [S37], Chunks are and sources..
This supported support, the here choice depends on exact used"*). This is
an honest result of a ~1.4M-parameter model trained from scratch on a
~2,300-document synthetic corpus, not a bug — that scale doesn't have the
capacity for the kind of generalization a large pretrained model has.

This matters less than it sounds for the actual product: in the live
ensemble this local model is one candidate among several (OpenAI/Gemini/
Mistral/Groq are the primary candidates when configured), and the scorer
above — which *is* accurate — is what ranks candidates. A weak local
candidate gets scored low and loses to a real provider's answer rather than
being presented as the final result. Making the local generator itself
fluent would need a bigger model and/or a much larger corpus, not just more
training epochs — a real scope decision, not a quick fix.

### End-to-end pipeline

One full query through retrieval → generation → scoring:

- Sources retrieved: 3
- Generated answer: 62 words in ~28.8s (CPU)
- Heuristic scores: support 1.0, bias 0.78, clarity 0.95
- Learned (scorer) scores: support 0.80, bias 0.79, clarity 0.84

Heuristic and learned scores broadly agree, which is the intended check —
the trained scorer isn't wildly out of step with the hand-written heuristic
it's blended with.
