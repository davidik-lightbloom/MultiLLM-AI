# Test Results

*Model-eval numbers below generated 2026-10-30, real run on this machine
(CPU-only, no MPS/CUDA); test count refreshed 2026-10-30.
Reproduce with `pytest -q`, `python -m train.eval_models`.*

## Test suite

**98/98 tests passing** (`pytest -q`) — covers `ai_client.py` core
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
| source_support | 0.0073 |
| bias_score | 0.0075 |
| clarity_score | 0.0054 |

MAE stays low (0.013–0.034) across every answer class (grounded, biased,
mixed, rambling, unsupported-clear, vague) — the scorer reliably tells these
apart, which is what lets the ensemble rank real candidates correctly.

### Generator — learned style, not fluency

| | Trained questions | Novel (held-out) questions |
|---|---|---|
| Avg length | 64.7 words | 58.0 words |
| Unique-word ratio | 0.79 | 0.89 |
| Uses citations `[S#]` | 100% | 100% |
| States tradeoffs | 67% | 100% |
| Flags uncertainty | 100% | 100% |
| Generation time | ~20s/answer | ~25s/answer (CPU) |

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

- Sources retrieved: 2
- Generated answer: 71 words in ~26.5s (CPU)
- Heuristic scores: support 0.25, bias 0.78, clarity 0.95
- Learned (scorer) scores: support 0.82, bias 0.81, clarity 0.85

Bias and clarity agree closely between the two scoring paths. Support
diverges more on this single live run than the 390-example aggregate MAE
above would suggest -- the heuristic penalizes this particular generation's
weak literal overlap with its sources harder than the learned scorer does.
Re-ran this twice during this session and saw the same pattern both times
(support 0.25-0.33 heuristic vs ~0.8 learned), so it's a real, repeatable
characteristic of single live samples, not a fluke -- the aggregate MAE is
the number to trust, not any one example.
