-- Supabase Schema for MultiLLM
-- Run this in Supabase SQL Editor
--
-- Safe to run top-to-bottom against a brand-new, empty Supabase project
-- (e.g. for a staging environment -- see docs/STAGING.md) AND safe to
-- re-run against an already-provisioned one: every CREATE TABLE/INDEX uses
-- IF NOT EXISTS, every CREATE FUNCTION uses OR REPLACE, every
-- CREATE POLICY/TRIGGER is preceded by its own DROP ... IF EXISTS, and every
-- backfill ALTER TABLE ... ADD COLUMN uses IF NOT EXISTS so it's a no-op on
-- a fresh table that already has the column from its own CREATE TABLE above.
-- Audited 2026-10-08 for ordering hazards (a table/column/function referenced
-- before it's defined) -- none found; every forward reference resolves to
-- something created earlier in this same file.

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table (extends auth.users)
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    name TEXT,
    plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'enterprise')),
    credits INTEGER NOT NULL DEFAULT 100,
    -- Start of the current monthly credit period, used for a lazy reset (no
    -- cron) on the next query -- see decrement_credits_atomic /
    -- reset_credits_period below and src/lib/credits.ts's decideCreditReset.
    credits_period_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    plan_expires_at TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- API Keys table (encrypted)
CREATE TABLE IF NOT EXISTS public.api_keys (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('openai', 'gemini', 'mistral', 'openrouter')),
    name TEXT NOT NULL,
    encrypted_key TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    usage_count INTEGER NOT NULL DEFAULT 0,
    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, provider)
);

-- Query History
CREATE TABLE IF NOT EXISTS public.queries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    prompt TEXT NOT NULL,
    answer TEXT NOT NULL,
    top_provider TEXT NOT NULL,
    top_model TEXT NOT NULL,
    confidence_score DOUBLE PRECISION NOT NULL,
    latency_ms DOUBLE PRECISION NOT NULL,
    carbon_saved DOUBLE PRECISION NOT NULL,
    emissions DOUBLE PRECISION NOT NULL,
    candidates JSONB,
    sources JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Training Jobs
CREATE TABLE IF NOT EXISTS public.training_jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    kind TEXT NOT NULL DEFAULT 'both' CHECK (kind IN ('generator', 'scorer', 'both')),
    epochs INTEGER NOT NULL DEFAULT 20,
    batch_size INTEGER NOT NULL DEFAULT 16,
    n_layer INTEGER NOT NULL DEFAULT 6,
    n_head INTEGER NOT NULL DEFAULT 4,
    n_embd INTEGER NOT NULL DEFAULT 128,
    learning_rate DOUBLE PRECISION NOT NULL DEFAULT 0.003,
    logs TEXT,
    model_path TEXT,
    final_loss DOUBLE PRECISION,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Added after the initial release -- covers a fresh CREATE TABLE above (no-op
-- there) and backfills a pre-existing table on an already-provisioned project.
ALTER TABLE public.training_jobs ADD COLUMN IF NOT EXISTS learning_rate DOUBLE PRECISION NOT NULL DEFAULT 0.003;
ALTER TABLE public.training_jobs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Same: covers a fresh CREATE TABLE above (no-op there) and backfills an
-- already-provisioned profiles table. Existing rows get NOW() as their
-- period start -- they're not granted extra credits immediately, just
-- enrolled starting today instead of resetting on an unknown past date.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS credits_period_start TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Feature 4 (local-only mode): a per-user preference, persisted here so it
-- survives across sessions/devices for a logged-in user. An anonymous
-- visitor's choice lives in localStorage instead (see page.tsx) since there's
-- no profile row to attach it to.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS local_only_mode BOOLEAN NOT NULL DEFAULT FALSE;

-- Subscriptions (billing is a manual, email-based flow -- see
-- dashboard/billing/page.tsx -- not Stripe; the stripe_customer_id /
-- stripe_subscription_id columns + idx_subscriptions_stripe_customer index
-- from an earlier, since-removed Stripe integration are intentionally gone.
-- Pending: this drop still needs to be applied to the live project via
-- apply_migration -- see the matching migration name
-- "drop_unused_stripe_subscription_columns" once it's run.
CREATE TABLE IF NOT EXISTS public.subscriptions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'enterprise')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'canceled', 'past_due', 'trialing')),
    current_period_end TIMESTAMPTZ,
    credits_included INTEGER NOT NULL DEFAULT 100,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_profiles_email ON public.profiles(email);
CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON public.api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_queries_user_created ON public.queries(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_training_jobs_user_status ON public.training_jobs(user_id, status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON public.subscriptions(user_id);

-- Row Level Security
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.queries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

-- RLS Policies
-- Profiles: users can read/update their own profile
DROP POLICY IF EXISTS "Users can view own profile" ON public.profiles;
CREATE POLICY "Users can view own profile" ON public.profiles
    FOR SELECT USING ((SELECT auth.uid()) = id);
DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
CREATE POLICY "Users can update own profile" ON public.profiles
    FOR UPDATE USING ((SELECT auth.uid()) = id);

-- API Keys: users can CRUD their own keys
DROP POLICY IF EXISTS "Users can manage own API keys" ON public.api_keys;
CREATE POLICY "Users can manage own API keys" ON public.api_keys
    FOR ALL USING ((SELECT auth.uid()) = user_id);

-- Queries: users can read/create their own queries
DROP POLICY IF EXISTS "Users can view own queries" ON public.queries;
CREATE POLICY "Users can view own queries" ON public.queries
    FOR SELECT USING ((SELECT auth.uid()) = user_id);
DROP POLICY IF EXISTS "Users can create queries" ON public.queries;
CREATE POLICY "Users can create queries" ON public.queries
    FOR INSERT WITH CHECK ((SELECT auth.uid()) = user_id);

-- Training Jobs: users can read/create/update their own jobs
DROP POLICY IF EXISTS "Users can manage own training jobs" ON public.training_jobs;
CREATE POLICY "Users can manage own training jobs" ON public.training_jobs
    FOR ALL USING ((SELECT auth.uid()) = user_id);

-- Subscriptions: users can read their own subscription
DROP POLICY IF EXISTS "Users can view own subscription" ON public.subscriptions;
CREATE POLICY "Users can view own subscription" ON public.subscriptions
    FOR SELECT USING ((SELECT auth.uid()) = user_id);

-- Function to handle new user signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.profiles (id, email, name, plan, credits)
    VALUES (NEW.id, NEW.email, NEW.raw_user_meta_data->>'name', 'free', 100);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- This is SECURITY DEFINER (needs elevated rights to insert into profiles on
-- a new auth.users row) and only ever meant to run as the trigger below --
-- not to be called directly. Revoke the default PUBLIC/anon/authenticated
-- EXECUTE grant so it isn't exposed as a callable RPC
-- (/rest/v1/rpc/handle_new_user); the trigger itself doesn't need this grant
-- to fire since it runs as part of the INSERT, not via a role's own EXECUTE
-- privilege.
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

-- Trigger for new user signup
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

-- Triggers for updated_at
DROP TRIGGER IF EXISTS update_profiles_updated_at ON public.profiles;
CREATE TRIGGER update_profiles_updated_at
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_api_keys_updated_at ON public.api_keys;
CREATE TRIGGER update_api_keys_updated_at
    BEFORE UPDATE ON public.api_keys
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_subscriptions_updated_at ON public.subscriptions;
CREATE TRIGGER update_subscriptions_updated_at
    BEFORE UPDATE ON public.subscriptions
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_training_jobs_updated_at ON public.training_jobs;
CREATE TRIGGER update_training_jobs_updated_at
    BEFORE UPDATE ON public.training_jobs
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Platform-issued gateway API keys (for programmatic Authorization: Bearer
-- access to /api/query), separate from api_keys above (which stores each
-- user's own BYO provider keys, not platform keys). Only a SHA-256 hash of
-- the key is stored -- the plaintext is shown once at creation and never
-- persisted.
CREATE TABLE IF NOT EXISTS public.platform_api_keys (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    tier TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'pro', 'enterprise')),
    key_prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    usage_count INTEGER NOT NULL DEFAULT 0,
    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_platform_api_keys_user_id ON public.platform_api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_platform_api_keys_key_hash ON public.platform_api_keys(key_hash);

ALTER TABLE public.platform_api_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own platform API keys" ON public.platform_api_keys;
CREATE POLICY "Users can manage own platform API keys" ON public.platform_api_keys
    FOR ALL USING ((SELECT auth.uid()) = user_id);

-- Atomic usage-count increments for both key tables, called only by the
-- backend's service-role client (never a client-supplied key_id) --
-- read-modify-write from application code would lose updates under
-- concurrent requests on the same key.
CREATE OR REPLACE FUNCTION public.increment_api_key_usage(key_id uuid)
RETURNS void AS $$
BEGIN
    UPDATE public.api_keys
    SET usage_count = usage_count + 1, last_used_at = now()
    WHERE id = key_id;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION public.increment_api_key_usage(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.increment_platform_api_key_usage(key_id uuid)
RETURNS void AS $$
BEGIN
    UPDATE public.platform_api_keys
    SET usage_count = usage_count + 1, last_used_at = now()
    WHERE id = key_id;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION public.increment_platform_api_key_usage(uuid) FROM PUBLIC, anon, authenticated;

-- Credit consumption: a single UPDATE guarded by its own WHERE clause, so
-- concurrent requests on the same user's credits can never drive the balance
-- negative (no read-then-write from application code -- the previous
-- decrementCredits() read credits, then wrote credits - amount in a separate
-- round trip, which could lose a concurrent decrement). Returns one row with
-- the new balance on success, or zero rows if there weren't enough credits --
-- the caller (consumeCredits() in src/lib/supabase/services.ts) treats an
-- empty result as "insufficient credits" and never goes negative.
--
-- This function does NOT handle the monthly reset -- the "is a reset due"
-- decision lives in TypeScript (src/lib/credits.ts's decideCreditReset),
-- not here, specifically so it's unit-testable; this repo's Vitest suite
-- never hits a real database, so logic buried only in PL/pgSQL can't be
-- exercised by a test at all. See reset_credits_period below for the other
-- half, which consumeCredits() calls first when a reset is due.
CREATE OR REPLACE FUNCTION public.decrement_credits_atomic(p_user_id uuid, p_amount int)
RETURNS TABLE(remaining_credits int) AS $$
    UPDATE public.profiles
       SET credits = credits - p_amount
     WHERE id = p_user_id AND credits >= p_amount
    RETURNING credits;
$$ LANGUAGE sql SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION public.decrement_credits_atomic(uuid, int) FROM PUBLIC, anon, authenticated;

-- Starts a new monthly credit period with the given allowance. Guarded by
-- p_expected_period_start (the value TypeScript observed when it decided a
-- reset was due) so a second concurrent caller that made the same decision
-- from the same stale read can't re-apply the reset a moment later and
-- re-grant a full allowance on top of what the first caller already
-- consumed -- its UPDATE simply matches zero rows and is a no-op. Never
-- called for demo/trial accounts (plan_expires_at IS NOT NULL) -- see
-- decideCreditReset, which refuses to schedule a reset for those regardless
-- of how old their period is.
CREATE OR REPLACE FUNCTION public.reset_credits_period(p_user_id uuid, p_new_credits int, p_expected_period_start timestamptz)
RETURNS void AS $$
    UPDATE public.profiles
       SET credits = p_new_credits, credits_period_start = now()
     WHERE id = p_user_id AND credits_period_start = p_expected_period_start;
$$ LANGUAGE sql SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION public.reset_credits_period(uuid, int, timestamptz) FROM PUBLIC, anon, authenticated;

-- Multi-tenant client project tracking: an agency user creates one row per
-- end-client they serve, and queries can be tagged against a project so
-- usage/quality can be reported per end-client later.
CREATE TABLE IF NOT EXISTS public.client_projects (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_client_projects_user_id ON public.client_projects(user_id);

ALTER TABLE public.client_projects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own client projects" ON public.client_projects;
CREATE POLICY "Users can manage own client projects" ON public.client_projects
    FOR ALL USING ((SELECT auth.uid()) = user_id);

DROP TRIGGER IF EXISTS update_client_projects_updated_at ON public.client_projects;
CREATE TRIGGER update_client_projects_updated_at
    BEFORE UPDATE ON public.client_projects
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Tag queries against a client project (nullable -- not every query needs
-- to belong to one).
ALTER TABLE public.queries ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES public.client_projects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_queries_project_id ON public.queries(project_id);

-- Estimated provider cost for this query (see src/lib/providerPricing.ts),
-- computed and written by the /api/query route at insert time. "Estimated"
-- because it's derived from a cheap ~4-chars/token heuristic and a
-- manually-maintained price table, not a provider's actual billed amount --
-- same honesty-about-precision convention as carbon_saved/emissions above.
ALTER TABLE public.queries ADD COLUMN IF NOT EXISTS estimated_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0;

-- Supports both the global daily spend cap's "sum today's cost across every
-- user" scan (get_today_provider_spend_usd below) and scripts/usage-report.mjs's
-- per-account 7/30-day window scans.
CREATE INDEX IF NOT EXISTS idx_queries_created_at ON public.queries(created_at);

-- Returns today's total estimated provider spend across all accounts
-- combined (UTC day boundary) -- used by the daily spend cap check in
-- src/app/api/query/route.ts before calling any paid provider. A SQL
-- function (not a plain client-side SELECT+sum) so the aggregate runs in
-- Postgres rather than pulling every row over the wire on every query.
CREATE OR REPLACE FUNCTION public.get_today_provider_spend_usd()
RETURNS double precision AS $$
    SELECT COALESCE(SUM(estimated_cost_usd), 0)::double precision
      FROM public.queries
     WHERE created_at >= date_trunc('day', now());
$$ LANGUAGE sql STABLE SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION public.get_today_provider_spend_usd() FROM PUBLIC, anon, authenticated;

-- Records a failed query attempt (ensemble unavailable, no remote provider
-- answered, etc.) so scripts/usage-report.mjs can report real per-account
-- error counts -- previously a failed query left no row anywhere. Written
-- only by the backend's service-role client, same as queries/platform_api_keys.
CREATE TABLE IF NOT EXISTS public.query_errors (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_query_errors_user_created ON public.query_errors(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_query_errors_created_at ON public.query_errors(created_at);

ALTER TABLE public.query_errors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own query errors" ON public.query_errors;
CREATE POLICY "Users can view own query errors" ON public.query_errors
    FOR SELECT USING ((SELECT auth.uid()) = user_id);

-- Dedupe log for lifecycle emails (see src/lib/email.ts, lifecycleEmails.ts):
-- the UNIQUE constraint below -- not a prior SELECT check -- is what actually
-- prevents sending the same email twice under concurrent requests. period_key
-- scopes "once per X": 'once' for welcome, the credit period's
-- credits_period_start for low_credits (so it can fire again next period),
-- and plan_expires_at's own value for plan_expiring (fixed per account, so
-- a daily cron re-scanning the same account can't resend it). No public RLS
-- policy -- only the backend's service-role client ever reads/writes this.
CREATE TABLE IF NOT EXISTS public.sent_emails (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    email_type TEXT NOT NULL CHECK (email_type IN ('welcome', 'low_credits', 'plan_expiring')),
    period_key TEXT NOT NULL,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, email_type, period_key)
);

CREATE INDEX IF NOT EXISTS idx_sent_emails_user_id ON public.sent_emails(user_id);

ALTER TABLE public.sent_emails ENABLE ROW LEVEL SECURITY;

-- Storage buckets (run in Supabase Dashboard > Storage)
-- INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
-- VALUES 
--     ('model-artifacts', 'model-artifacts', false, 104857600, ARRAY['application/octet-stream', 'application/json']),
--     ('knowledge-sources', 'knowledge-sources', false, 52428800, ARRAY['text/plain', 'text/markdown', 'application/json', 'text/csv']);