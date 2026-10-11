# MultiLLM Deployment Guide (Supabase)

## Quick Start (Local Development)

### 1. Python Ensemble (Offline)
```bash
# Install dependencies
pip install openai httpx torch numpy

# Test offline ensemble (uses trained models if available)
python ensemble_demo.py "Your question here"

# Train local models (optional, ~5-10 min on MPS/CPU)
python -m train.train --epochs 20 --batch-size 8 --cpu

# Run desktop GUI
python ai_client_app.py
```

### 2. SaaS Frontend (Next.js + Vercel)
```bash
cd vercel-deployment

# Install dependencies
npm install

# Copy environment template
cp .env.example .env.local
# Edit .env.local with your keys

# Run development server
npm run dev
```

Visit `http://localhost:3000` - works in **demo mode** without Supabase.

---

## Production Deployment

### Prerequisites
- **Supabase** project
- **Vercel** account
- **GitHub** repository

### 1. Provision Supabase
```bash
# 1. Create project at https://supabase.com
# 2. Go to SQL Editor and run supabase/schema.sql
# 3. Go to Storage and create buckets:
#    - model-artifacts (private, 100MB limit)
#    - knowledge-sources (private, 50MB limit)
# 4. Get credentials from Settings > API:
#    - Project URL
#    - anon/public key
#    - service_role key (secret)
```

### 2. Deploy to Vercel
```bash
# Via Vercel CLI
vercel --prod

# Or connect GitHub repo in Vercel Dashboard
# Set environment variables in Vercel Project Settings
```

Required Vercel Environment Variables:
```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
ENCRYPTION_KEY
NEXT_PUBLIC_CONTACT_EMAIL
OPENAI_API_KEY (optional)
GEMINI_API_KEY (optional)
MISTRAL_API_KEY (optional)
```

### 3. Generate Encryption Key
```bash
python -c "import secrets, base64; print(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode())"
```
Add output as `ENCRYPTION_KEY` in Vercel.

---

## Architecture

```
┌─────────────────┐     ┌──────────────────┐
│   Next.js App   │────▶│  Supabase        │
│   (Vercel)      │     │  (Auth, DB,      │
│                 │     │   Storage,       │
└─────────────────┘     │   Realtime)      │
                        └────────┬─────────┘
                                 │
                    ┌────────────┴────────────┐
                    ▼                         ▼
            ┌───────────────┐         ┌───────────────┐
            │ Query Ensemble│         │ Training Job  │
            │ (Python Fn)   │         │ (Python Fn)   │
            └───────────────┘         └───────────────┘
                    │
                    ▼
         ┌────────────────────────┐
         │ Multi-LLM Ensemble     │
         │ - OpenAI/Gemini/Mistral│
         │ - Local TinyGPT        │
         │ - Scoring + Synthesis  │
         └────────────────────────┘
```

---

## Supabase Schema Overview

### Tables
- **profiles** - Extended user info (plan, credits, etc.)
- **api_keys** - Encrypted user API keys
- **queries** - Query history with full traceability
- **training_jobs** - Training job tracking
- **subscriptions** - Plan/subscription state (updated manually, not by a payment processor -- see billing note below)

### Row Level Security
All tables have RLS enabled with policies:
- Users can only access their own data
- Service role (backend) has full access

### Storage Buckets
- **model-artifacts** - Trained model files (.pt, .json)
- **knowledge-sources** - User uploaded documents

---

## API Endpoints

### Next.js (Frontend)
- `POST /api/query` / `GET /api/query` - Run ensemble query (proxies to Python function) / model+health status
- `GET /api/training` / `POST /api/training` - List / start training jobs (real Supabase-backed, user-scoped)
- `GET /api/api-keys` / `POST /api/api-keys` - List / create platform API keys
- `DELETE /api/api-keys/[id]` - Revoke a platform API key
- `GET /api/analytics` - Query history + usage analytics
- `GET /api/client-projects` / `POST /api/client-projects` - Multi-tenant client project CRUD
- `GET /api/account` / `DELETE /api/account` - Account info / delete account

**Billing:** there is no payment processor and no billing API route. Every
plan change (upgrade/downgrade/cancellation) and billing question is a
`mailto:` link to `NEXT_PUBLIC_CONTACT_EMAIL`, handled manually. The
`subscriptions` table's `plan`/`status`/`credits_included` columns are
updated by hand (e.g. via the Supabase dashboard or a script) when a
request is fulfilled.

### Python Functions (Vercel)
`query-ensemble` is deployed as a Vercel **Service** (`vercel-deployment/vercel.json`'s
`services` block), not a plain function under `api/` -- Next.js's App Router
claims the entire `/api/*` namespace for itself, so a sibling Python
function placed directly under `api/` is silently unreachable in
production (confirmed empirically: it returns Next's own 404 page, never
invokes the Python function). The Next.js app calls it privately via a
service binding (`PYTHON_ENSEMBLE_INTERNAL_URL`, injected automatically by
Vercel -- never set it as a project env var), not a public URL. Its
dependencies (`ai_client.py`, `local_models.py`, `token_optimizer.py`,
`knowledge_sources/`) are vendored copies inside
`vercel-deployment/api/query-ensemble/`, kept in sync manually with the
repo-root originals, since this project's Vercel Root Directory is
`vercel-deployment/` and a deployed function can't read files above it.
The trained model weights this function needs for local-only mode (Feature
4) are committed alongside it at `api/query-ensemble/models/` (~11MB) --
see the `.gitignore` carve-out and the comment on `MODELS_DIR` in
`local_models.py`; the repo-root `models/` directory stays gitignored and
is just this function's local build source.

**This function now bundles `torch` (CPU wheel, ~800MB) for local-only
mode** -- added 2026-10-11, after the repo's own earlier experience with
`training-job` hitting Vercel's old 500MB Python function limit (see
"Known gap" below). This session's Vercel platform guidance says Functions
now support bundles up to 5GB natively, which is why this was judged safe
to add here too -- but that claim hasn't been verified against an actual
deploy of *this* function yet. **Watch the first preview deploy after this
change closely** for the same `ENOENT`-at-packaging failure mode
`training-job` hit; if it recurs, local-only mode needs the same "move off
Vercel" treatment discussed below for `training-job`, not more retries of
the same approach.

- `POST /api/query` - Direct ensemble query
- `GET /api/health` - Health check
- `POST /api/reload-sources` - Reload knowledge sources
- `POST /api/training/start` - Start training
- `GET /api/training/status/{job_id}` - Check training status

**Known gap:** the `training-job` function is currently excluded from
production (`vercel-deployment/training-job-disabled/`, not under `api/`).
It needs `torch`, whose bundle exceeds the standard 500MB Python function
limit; enabling the large-functions beta hits what looks like a Vercel
platform bug (`ENOENT` on an installed package file, different file each
deploy attempt) at the final packaging step. Separately, real training runs
can exceed the Hobby plan's hard 300s function duration cap regardless. See
`vercel-deployment/training-job-disabled/DISABLED.md` for details and how to
restore it once resolved (or after upgrading to Pro). The dashboard's
Training page reflects this honestly (a "Coming soon" state, not a
silently-broken form) rather than pretending the feature works.

### API key rotation on rate limits / token optimization

Two related things live in `ai_client.py` (vendored into
`vercel-deployment/api/query-ensemble/`):

- **Prompt/context token optimization** (`token_optimizer.py`, wired into
  `build_ensemble_answer`): trims retrieved sources and chat history before
  they're sent to any provider, reported back to the caller as
  `token_savings` (shown on the dashboard as "Prompt Tokens Saved"). This
  already existed; not new.
- **Key-drain circuit breaker** (`RoundRobinKeys`, `build_provider_stack`):
  when a provider API key gets a rate-limit/quota response, it's marked
  "drained" for `KEY_DRAIN_COOLDOWN_SECONDS` (default 300s) and skipped on
  subsequent calls instead of being retried immediately. Shared across
  serverless instances via `UPSTASH_REDIS_REST_URL`/`TOKEN` when configured
  (falls back to in-memory per instance otherwise -- same trade-off as the
  Next.js rate limiter). When a user's own BYO key for a provider is
  supplied, the platform's own key for that same provider (if configured) is
  attached as a lower-priority fallback, so a drained BYO key doesn't fail
  that user's query outright -- except for the combined OpenAI/OpenRouter
  slot, where a user's OpenRouter key and the platform's real OpenAI key
  need different base URLs and can't safely share one `OpenAIProvider`
  instance; that combination keeps the original behavior (BYO key only, no
  platform fallback).

### Known limitations: where should training actually run?

Recommendation: **move `training-job` to a small dedicated host (Railway
or Fly.io) rather than keep chasing the Vercel large-functions bug.**
Vercel's serverless model fundamentally isn't a good fit for this specific
function -- it needs a large ML dependency (`torch`) and can run for
several minutes, both of which fight the platform's per-function size and
duration limits by design, not as an incidental bug to route around.
Railway and Fly.io both run a persistent container with no such
size/duration ceiling, at a similar hobby-tier price point, and Vercel
would still front the rest of the app (Next.js + query-ensemble) exactly
as it does today -- only `PYTHON_TRAINING_URL` would point elsewhere. Not
attempted this session; this is a recommendation, not a migration. Note
query-ensemble no longer fully dodges this either -- it now carries
`torch` too (see above), just not the duration problem, since inference is
seconds, not minutes.

---

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | Supabase anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase service role key |
| `NEXT_PUBLIC_CONTACT_EMAIL` | Yes | Sales/support inbox used in the footer and every billing mailto link (there is no payment processor) |
| `ENCRYPTION_KEY` | Yes | 32-byte base64 key for API encryption |
| `INTERNAL_API_SECRET` | Yes | Shared secret Next.js sends to the Python functions |
| `APP_ORIGIN` | Yes | Deployed app origin; CORS allow-list for the query-ensemble function |
| `PYTHON_TRAINING_URL` | No (currently unused) | URL of the deployed training-job Python function -- leave unset; `training-job` is disabled in production, see the Known Gap note above |
| `OPENAI_API_KEY` | No | OpenAI/OpenRouter API key |
| `GEMINI_API_KEY` | No | Google Gemini API key |
| `MISTRAL_API_KEY` | No | Mistral API key |
| `GROQ_API_KEY` | No | Groq API key |
| `ANON_DAILY_QUERY_CAP` | No | Global daily cap across all anonymous (no-account) queries combined, on top of the 3/min per-IP limit (default: 200) |
| `BOT_COUNT` | No | Parallel bots (default: 4) |
| `PRIVACY_REDACTION` | No | Enable PII redaction (default: 1) |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Strongly recommended in production | Shared, cross-instance rate limiting *and* the ensemble's key-drain circuit breaker (below); without these, both fall back to per-serverless-instance memory, far weaker under horizontal scaling |
| `KEY_DRAIN_COOLDOWN_SECONDS` | No | How long a provider API key that just got rate-limited is skipped before being retried (default: 300). Uses `UPSTASH_REDIS_REST_URL`/`TOKEN` above when set, so the drain mark is shared across instances; otherwise in-memory per instance. See "API key rotation on rate limits" below |

---

## Agency Demo Accounts

To let an agency try the product before signing up for real, provision them
a temporary account directly (no self-serve signup needed):

```bash
vercel env pull .env.local   # once, to get NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY locally
cd vercel-deployment
node --env-file=.env.local scripts/demo-account.mjs create --email agency@example.com --name "Acme Agency"
```

Prints a dashboard login (email + generated password) and a platform API
key, both shown once. Defaults to a `pro`-tier account, 200 credits, and a
14-day expiry (`--days`, `--credits`, `--tier` override these). Both the
credit cap and the expiry date are actually enforced in `/api/query` (see
`profiles.is_active` / `plan_expires_at` checks there) -- not just cosmetic.

To end access before it naturally expires:
```bash
node --env-file=.env.local scripts/demo-account.mjs revoke --email agency@example.com
```

This is a local admin script, not an API route -- nothing about it is
reachable from the deployed app. It uses only the existing `profiles` and
`platform_api_keys` tables; no schema changes.

---

## Local Development with Real Backend

1. Start Supabase locally:
```bash
npx supabase start
```

2. Run migrations:
```bash
npx supabase db reset
# or apply schema.sql manually in local dashboard
```

3. Start Next.js with local backend:
```bash
cd vercel-deployment
cp .env.example .env.local
# Edit .env.local with local Supabase credentials
npm run dev
```

---

## Testing

```bash
# Python tests
pytest

# Next.js tests (Vitest, Node environment -- no jsdom/RTL; these test API
# route handlers directly, not rendered components. Coverage prioritizes
# routes with real logic to regress: auth/tier gating and the
# ensemble-unreachable fallback in /api/query, ownership checks in
# /api/client-projects[/[id]], tier-bypass in /api/api-keys. Supabase/auth
# calls are mocked (vi.mock), never hitting a real database.)
cd vercel-deployment && npm test
# `npm run test:watch` for interactive/watch mode.
# Requires Node >=22.12 (vitest 5's minimum) -- CI's NODE_VERSION reflects
# this; matters for local runs too if your Node is older.

# Linting
ruff check .           # Python
cd vercel-deployment && npm run lint  # TypeScript

# Type checking
mypy ai_client.py      # Python
cd vercel-deployment && npm run typecheck  # TypeScript

# Generate Supabase types
cd vercel-deployment && npm run db:generate-types
```

---

## Monitoring & Logs

- **Vercel**: Function logs in Vercel Dashboard
- **Supabase**: Logs in Supabase Dashboard > Logs

---

## Troubleshooting

### "No providers configured"
Set at least one provider API key in environment variables.

### "Trained model not found"
Run `python -m train.train` to generate local models.

### Supabase connection failed
Check `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`. Ensure RLS policies allow the operations.

### Python function timeout
Increase `maxDuration` in `vercel.json` (max 60s for query, 3600s for training).

---

## Scaling Considerations

- **Query Ensemble**: Stateless, horizontal scaling via Vercel Functions
- **Training Jobs**: Long-running, use Vercel Functions with 1hr timeout
- **Database**: Supabase handles scaling; add indexes for high query volume
- **Storage**: Model artifacts in Supabase Storage (100MB limit per file)
- **Rate Limiting**: Implement in Next.js middleware or Supabase Edge Functions

---

## Security Checklist

- [ ] `ENCRYPTION_KEY` is 32-byte base64, stored only in secure env
- [ ] `SUPABASE_SERVICE_ROLE_KEY` only used server-side
- [ ] API keys encrypted at rest (using `encryption.py`)
- [ ] PII redaction enabled (`PRIVACY_REDACTION=1`)
- [ ] HTTPS enforced (Vercel default)
- [ ] CORS configured for your domain only
- [ ] Rate limiting on `/api/query` endpoint
- [ ] RLS policies tested for all tables