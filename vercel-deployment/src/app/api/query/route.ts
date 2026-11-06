import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/client";
import { MultiLLM } from "@/lib/multi-llm";
import {
  getProfile,
  consumeCredits,
  getApiKeys,
  getClientProject,
  incrementApiKeyUsage,
  getTodayProviderSpendUsd,
  recordQueryError,
} from "@/lib/supabase/services";
import { authenticateApiKey } from "@/lib/apiKeyAuth";
import { getAuthenticatedUserId } from "@/lib/supabase/serverAuth";
import { checkRateLimit, getClientIp, type Tier } from "@/lib/rateLimiter";
import { decryptApiKey } from "@/lib/encryption";
import { isDemoMode } from "@/lib/demoMode";
import { evaluateSpendCap, getDailySpendCapUsd } from "@/lib/spendCap";
import { estimateQueryCostUsd } from "@/lib/providerCost";
import { maybeSendLowCreditsEmail } from "@/lib/lifecycleEmails";

/**
 * Loads the user's own BYO provider keys (if any), decrypted server-side
 * only, grouped by provider. Never logged -- returned only for a single
 * request's outbound call to the Python ensemble over the internal-secret
 * channel, never persisted or echoed back to the client.
 */
async function loadUserProviderKeys(userId: string): Promise<Record<string, string[]> | null> {
  const rows = await getApiKeys(userId);
  if (!rows.length) return null;

  const grouped: Record<string, string[]> = {};
  const usedRowIds: string[] = [];
  for (const row of rows) {
    try {
      const plaintext = await decryptApiKey(row.encrypted_key);
      grouped[row.provider] = [...(grouped[row.provider] || []), plaintext];
      usedRowIds.push(row.id);
    } catch {
      // Skip a key that fails to decrypt (e.g. rotated ENCRYPTION_KEY)
      // rather than failing the whole query.
    }
  }
  if (!Object.keys(grouped).length) return null;

  // Best-effort usage tracking -- a key that's included in this request's
  // provider stack counts as "used" even if the ensemble ends up not
  // drawing a candidate from it; never block the actual query on this.
  Promise.all(usedRowIds.map((id) => incrementApiKeyUsage(id))).catch(() => {});

  return grouped;
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const multiLLM = new MultiLLM();
// Vercel injects this automatically at runtime from the "backend" service
// binding declared in vercel.json -- never set it manually as a Vercel env
// var. Falls back to a plain localhost URL for local dev (`uvicorn` running
// the query-ensemble function directly, outside the Services model).
const PYTHON_ENSEMBLE_URL = process.env.PYTHON_ENSEMBLE_INTERNAL_URL || "http://localhost:8000";

// Deep Review (cross-check the final answer with one extra provider call for
// an explicit confidence score) is a paid-tier feature -- gated here, not in
// the UI alone, since the UI toggle is trivially bypassable.
const DEEP_REVIEW_PLANS = new Set(["pro", "enterprise"]);

async function callPythonEnsemble(prompt: string, options: any = {}, requestId?: string) {
  try {
    const response = await fetch(`${PYTHON_ENSEMBLE_URL}/api/query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": process.env.INTERNAL_API_SECRET || "",
        ...(requestId ? { "x-request-id": requestId } : {}),
      },
      body: JSON.stringify({ prompt, ...options }),
      signal: AbortSignal.timeout(55000),
    });

    if (!response.ok) {
      throw new Error(`Python ensemble returned ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.warn("Python ensemble unavailable, falling back to mock:", error);
    return null;
  }
}

// Feature 2 (streaming synthesis): same request as callPythonEnsemble, but to
// the SSE-emitting sibling route, with a longer timeout -- the user is
// actively watching tokens arrive, so a slow-but-progressing stream
// shouldn't be cut off at the same 55s budget used for a single blocking
// call.
async function streamPythonEnsemble(
  prompt: string,
  options: any = {},
  requestId?: string
): Promise<Response | null> {
  try {
    const response = await fetch(`${PYTHON_ENSEMBLE_URL}/api/query/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "x-internal-secret": process.env.INTERNAL_API_SECRET || "",
        ...(requestId ? { "x-request-id": requestId } : {}),
      },
      body: JSON.stringify({ prompt, ...options }),
      signal: AbortSignal.timeout(90000),
    });
    if (!response.ok || !response.body) {
      console.warn("Python ensemble stream returned", response.status);
      return null;
    }
    return response;
  } catch (error) {
    console.warn("Python ensemble stream unavailable:", error);
    return null;
  }
}

export async function POST(req: NextRequest) {
  const requestId = req.headers.get("x-request-id") || crypto.randomUUID();
  let prompt = "";
  let options = {};
  let requestedProjectId = "";
  let requestedDeepReview = false;
  let requestedStream = false;
  let requestedLocalOnly = false;
  let requestedMode: "fast" | "deep" | null = null;

  // Programmatic access via a generated API key takes precedence over the
  // dashboard's own logged-in session. Neither is ever taken from the
  // request body -- that would let a caller claim any user_id they like.
  const apiKeyAuth = await authenticateApiKey(req);
  const sessionUserId = apiKeyAuth ? null : await getAuthenticatedUserId();
  const userId = apiKeyAuth?.userId || sessionUserId || "";

  try {
    const body = await req.json();
    prompt = typeof body?.prompt === "string" ? body.prompt : "";
    requestedProjectId = typeof body?.project_id === "string" ? body.project_id : "";
    requestedDeepReview = body?.deep_review === true;
    requestedStream = body?.stream === true;
    requestedLocalOnly = body?.local_only === true;
    requestedMode = body?.mode === "deep" ? "deep" : body?.mode === "fast" ? "fast" : null;
    options = {
      bot_count: body?.bot_count,
      top_k: body?.top_k,
      privacy_redaction: body?.privacy_redaction,
    };
  } catch {
    // fall through
  }

  if (!prompt.trim()) {
    return NextResponse.json({ error: "Missing prompt" }, { status: 400 });
  }

  // A project_id is only ever trusted once verified to belong to this
  // user -- same "never trust a client-supplied id" rule as user_id itself.
  let projectId: string | null = null;
  if (requestedProjectId && userId) {
    const project = await getClientProject(requestedProjectId);
    if (project && project.user_id === userId && project.is_active) {
      projectId = project.id;
    }
  }

  const profile = userId ? await getProfile(userId) : null;

  // Demo mode (no Supabase configured) has no real session at all -- every
  // request looks anonymous to this route by default (no userId, no
  // profile), even though the dashboard shows a fake "Pro, 10,000 credits"
  // account. Without this, a demo visitor gets rate-limited at the strict
  // anonymous 3/min and sees Deep Review locked behind "Upgrade to enable",
  // contradicting what they're shown -- treat demo traffic as pro-tier
  // instead, scoped per-IP (not a global shared bucket) since there's no
  // real per-user identity to key on.
  const demoMode = isDemoMode();
  const tier: Tier = (apiKeyAuth?.tier as Tier) || (profile?.plan as Tier) || (demoMode ? "pro" : "free");
  // Phase 1 of the adaptive-hierarchy roadmap: Fast vs Deep mode. Same
  // per-request-override-then-profile-fallback pattern as local_only below.
  // Computed before deepReviewAllowed since mode=="deep" is also a trigger
  // for Deep Review (still gated by DEEP_REVIEW_PLANS either way).
  const mode: "fast" | "deep" = requestedMode || (profile?.default_mode === "deep" ? "deep" : "fast");
  const wantsDeepReview = requestedDeepReview || mode === "deep";
  const deepReviewAllowed = wantsDeepReview && (demoMode || DEEP_REVIEW_PLANS.has(profile?.plan || "free"));
  // Feature 4: local-only mode. A per-request flag takes precedence (lets an
  // anonymous visitor, who has no profile row, still use it from
  // localStorage), falling back to the logged-in user's saved preference so
  // it stays on across sessions/devices without the client re-sending it.
  const localOnly = requestedLocalOnly || profile?.local_only_mode === true;
  const identityKey = apiKeyAuth
    ? `key:${apiKeyAuth.keyId}`
    : userId
      ? `user:${userId}`
      : demoMode
        ? `demo:${getClientIp(req)}`
        : undefined;
  const rateLimit = await checkRateLimit({ ip: getClientIp(req), identityKey, tier });
  if (!rateLimit.allowed) {
    const message =
      rateLimit.reason === "anon_daily_cap"
        ? "MultiLLM's free anonymous demo has hit its query limit for today. Sign up for a free account to keep going."
        : "Rate limit exceeded. Please slow down.";
    return NextResponse.json(
      { error: message, code: rateLimit.reason },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } }
    );
  }

  // profiles.is_active and .plan_expires_at exist in the schema (and are
  // already enforced for platform API keys via getPlatformApiKeyByHash's own
  // is_active filter) but were never actually checked on this, the session
  // path -- a deactivated or expired account could still query normally.
  // This is what makes revoking a demo/trial account (see scripts/
  // demo-account.mjs) actually take effect rather than being cosmetic.
  if (profile && profile.is_active === false) {
    return NextResponse.json({ error: "This account has been deactivated." }, { status: 403 });
  }
  if (profile?.plan_expires_at && new Date(profile.plan_expires_at) < new Date()) {
    return NextResponse.json(
      { error: "Your plan has expired. Contact us to renew." },
      { status: 402 }
    );
  }

  // Atomic check-and-decrement: closes a real race in the old flow (a
  // separate read-then-write decrementCredits() call after the fact) where
  // two concurrent requests could both pass a stale "credits > 0" read and
  // both decrement, going negative. Doing this up front -- rather than only
  // after a successful ensemble call -- means a request that fails
  // downstream (e.g. the 503 below) still spends the credit; that's a
  // deliberate trade-off for closing the race, not an oversight.
  if (userId && profile) {
    const consumption = await consumeCredits(userId, 1, profile);
    if (!consumption.success) {
      return NextResponse.json(
        { error: "Out of credits. Upgrade your plan to continue." },
        { status: 402 }
      );
    }
    // Fire-and-forget: a lifecycle email should never block or fail the
    // query itself. No-ops unless this just dropped below 10% of the plan's
    // allowance, and is deduped per credit period (see tryClaimLifecycleEmail).
    maybeSendLowCreditsEmail(profile, consumption.remainingCredits).catch((err) =>
      console.warn("Low-credits email failed:", err)
    );
  }

  // Global daily spend cap: once today's estimated provider cost (across
  // every account combined) reaches the cap, stop calling paid providers
  // entirely rather than let individual accounts keep spending past it.
  // Checked after credits (a capped-out request still cost the user a
  // credit, same trade-off as the downstream-failure case above) but before
  // any provider is actually called. Doesn't apply to local-only mode at
  // all -- it makes zero paid-provider calls, so it can't contribute to (or
  // be blocked by) a cap that exists purely to bound paid-provider spend.
  const dailySpendCapUsd = getDailySpendCapUsd();
  if (!localOnly && dailySpendCapUsd !== null) {
    const todaySpendUsd = await getTodayProviderSpendUsd();
    const spendCap = evaluateSpendCap(todaySpendUsd, dailySpendCapUsd);
    if (spendCap.warn && !spendCap.blocked) {
      console.warn(
        `ALERT: daily provider spend at $${todaySpendUsd.toFixed(2)} of $${dailySpendCapUsd.toFixed(2)} cap (>=80%).`
      );
    }
    if (spendCap.blocked) {
      console.warn(
        `Daily provider spend cap reached ($${todaySpendUsd.toFixed(2)} of $${dailySpendCapUsd.toFixed(2)}) -- refusing to call paid providers.`
      );
      return NextResponse.json(
        {
          error: "MultiLLM is temporarily limited due to high demand. Please try again later.",
          code: "SPEND_CAP_REACHED",
          request_id: requestId,
        },
        { status: 503, headers: { "Retry-After": "300", "x-request-id": requestId } }
      );
    }
  }

  // BYO provider keys: if the user has connected their own (encrypted at
  // rest, decrypted only here, server-side, for this one request), run
  // their query against those instead of the platform's keys, falling back
  // to the platform's per-provider when they haven't connected one. Skipped
  // entirely for local-only mode -- nothing would use them, so there's no
  // reason to decrypt a user's keys on a request that won't call any
  // remote provider.
  const userProviderKeys = !localOnly && userId ? await loadUserProviderKeys(userId) : null;
  if (userProviderKeys) {
    options = { ...options, provider_keys: userProviderKeys };
  }
  if (deepReviewAllowed) {
    options = { ...options, deep_review: true };
  }
  if (localOnly) {
    options = { ...options, local_only: true };
  }
  // mode itself is forwarded unconditionally, unlike deep_review above --
  // bot_count is already a fully client-controlled, ungated field today, so
  // deep mode's bot_count bump riding along with it is no new exposure.
  // Deep Review's extra paid-tier call stays gated by deepReviewAllowed
  // above regardless of what mode is set to.
  options = { ...options, mode };

  if (requestedStream) {
    return handleStreamingQuery({ prompt, options, requestId, userId, projectId, apiKeyAuth });
  }

  // Policy: when the Python ensemble is unreachable, fail loudly (503) rather
  // than silently answering with lib/multi-llm.ts's canned demo text and
  // fake scores. Handing a paying user a fabricated "answer" that looks real
  // is worse than a clear, retryable error -- they'd have no way to tell the
  // difference. lib/multi-llm.ts is kept only for the GET health/model-list
  // fallback below, which doesn't fabricate a query result.
  const pythonResult = await callPythonEnsemble(prompt, options, requestId);
  if (!pythonResult) {
    if (userId) recordQueryError(userId, "ensemble_unavailable").catch(() => {});
    return NextResponse.json(
      {
        error: "The ensemble backend is temporarily unavailable. Please try again shortly.",
        code: "ENSEMBLE_UNAVAILABLE",
        request_id: requestId,
      },
      { status: 503, headers: { "Retry-After": "30", "x-request-id": requestId } }
    );
  }

  const answer: string = pythonResult.answer;
  const metrics: any = {
    accuracy: pythonResult.metrics?.top_score || 0,
    latency_s: (pythonResult.metrics?.latency_ms || 0) / 1000,
    carbon_saved_g: pythonResult.metrics?.carbon_saved_g || 0,
    emissions_g: pythonResult.metrics?.emissions_g || 0,
    providers_used: pythonResult.providers_used || [],
  };
  const candidates: any[] = pythonResult.candidates || [];
  const sources: any[] = pythonResult.sources || [];
  const tokenSavings: Record<string, number> | null = pythonResult.token_savings || null;
  const refinedPrompt: string | null = pythonResult.refined_prompt || null;
  const deepReviewConfidence: number | null =
    typeof pythonResult.confidence_score === "number" ? pythonResult.confidence_score : null;

  const estimatedCostUsd = estimateQueryCostUsd({ prompt, candidates, finalAnswer: answer });

  // Save query history if userId provided
  if (userId) {
    const supabase = createServerSupabaseClient();
    const queryRecord = {
      user_id: userId,
      project_id: projectId,
      prompt,
      answer,
      top_provider: candidates[0]?.provider_name || "MultiLLM",
      top_model: candidates[0]?.model || "ensemble",
      confidence_score: metrics.accuracy,
      latency_ms: metrics.latency_s * 1000,
      carbon_saved: metrics.carbon_saved_g,
      emissions: metrics.emissions_g,
      candidates,
      sources,
      estimated_cost_usd: estimatedCostUsd,
    };
    await supabase.from("queries").insert(queryRecord as any);
  }

  if (apiKeyAuth) {
    await apiKeyAuth.recordUsage();
  }

  return NextResponse.json(
    {
      answer,
      metrics,
      _source: "python-ensemble",
      _candidates: candidates,
      _sources: sources,
      token_savings: tokenSavings,
      refined_prompt: refinedPrompt,
      request_id: requestId,
      project_id: projectId,
      deep_review_confidence: deepReviewConfidence,
      // Feature 1: which category/providers this prompt was routed to --
      // same info already logged server-side (ai_client.py's _route_for_query),
      // surfaced here too so it's visible without digging through logs.
      routing: pythonResult.routing || null,
      // ai_client.py's _generate_candidates already computes this sanitized
      // (no keys, no raw exception text -- see classify_failure) per-bot
      // failure list specifically "for surfacing to the API response" per
      // its own docstring, but nothing between there and here ever read it,
      // so every partial ensemble failure was invisible to callers and to
      // us. Surfacing it closes that gap -- a caller (or we, watching
      // production) can now tell a degraded-but-answered query from a fully
      // healthy one instead of only ever seeing whichever providers survived.
      provider_failures: pythonResult.provider_failures || [],
    },
    { headers: { "x-request-id": requestId } }
  );
}

// Feature 2 (streaming synthesis): proxies the Python ensemble's SSE stream
// straight through to the browser, byte for byte, while also watching each
// event go by to capture the final "done" payload -- once the upstream
// stream closes, the same accounting the non-streaming path does inline
// (query history, API-key usage) runs using that captured payload instead of
// a whole-response JSON body.
async function handleStreamingQuery(params: {
  prompt: string;
  options: any;
  requestId: string;
  userId: string;
  projectId: string | null;
  apiKeyAuth: Awaited<ReturnType<typeof authenticateApiKey>>;
}) {
  const { prompt, options, requestId, userId, projectId, apiKeyAuth } = params;

  const upstream = await streamPythonEnsemble(prompt, options, requestId);
  if (!upstream || !upstream.body) {
    if (userId) recordQueryError(userId, "ensemble_unavailable").catch(() => {});
    return NextResponse.json(
      {
        error: "The ensemble backend is temporarily unavailable. Please try again shortly.",
        code: "ENSEMBLE_UNAVAILABLE",
        request_id: requestId,
      },
      { status: 503, headers: { "Retry-After": "30", "x-request-id": requestId } }
    );
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let doneEvent: any = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.body!.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);

          buffer += decoder.decode(value, { stream: true });
          let separatorIndex;
          while ((separatorIndex = buffer.indexOf("\n\n")) !== -1) {
            const rawEvent = buffer.slice(0, separatorIndex);
            buffer = buffer.slice(separatorIndex + 2);
            const dataLine = rawEvent.split("\n").find((line) => line.startsWith("data:"));
            if (!dataLine) continue;
            try {
              const parsed = JSON.parse(dataLine.slice(5).trim());
              if (parsed.event === "done") doneEvent = parsed;
            } catch {
              // Malformed SSE line -- ignore, the client gets the raw bytes
              // either way and can surface its own parse error if it cares.
            }
          }
        }
      } catch (error) {
        console.warn("Streaming ensemble response interrupted:", error);
      } finally {
        controller.close();
      }

      if (!doneEvent) {
        // Stream ended without ever producing a "done" event (error event,
        // or the connection dropped) -- nothing to record.
        return;
      }

      const metrics: any = {
        accuracy: doneEvent.metrics?.top_score || 0,
        latency_s: (doneEvent.metrics?.latency_ms || 0) / 1000,
        carbon_saved_g: doneEvent.metrics?.carbon_saved_g || 0,
        emissions_g: doneEvent.metrics?.emissions_g || 0,
        providers_used: doneEvent.providers_used || [],
      };
      const estimatedCostUsd = estimateQueryCostUsd({
        prompt,
        candidates: doneEvent.candidates || [],
        finalAnswer: doneEvent.answer,
      });

      if (userId) {
        const supabase = createServerSupabaseClient();
        const queryRecord = {
          user_id: userId,
          project_id: projectId,
          prompt,
          answer: doneEvent.answer,
          top_provider: doneEvent.candidates?.[0]?.provider_name || "MultiLLM",
          top_model: doneEvent.candidates?.[0]?.model || "ensemble",
          confidence_score: metrics.accuracy,
          latency_ms: metrics.latency_s * 1000,
          carbon_saved: metrics.carbon_saved_g,
          emissions: metrics.emissions_g,
          candidates: doneEvent.candidates || [],
          sources: doneEvent.sources || [],
          estimated_cost_usd: estimatedCostUsd,
        };
        await supabase.from("queries").insert(queryRecord as any);
      }

      if (apiKeyAuth) {
        await apiKeyAuth.recordUsage();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "x-request-id": requestId,
    },
  });
}

export async function GET() {
  // Try Python ensemble health check
  try {
    const response = await fetch(`${PYTHON_ENSEMBLE_URL}/api/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      const health = await response.json();
      return NextResponse.json({
        models: health.provider_status?.split("\n").filter(Boolean).map((l: string) => l.trim()) || [],
        _source: "python-ensemble",
        _health: health,
      });
    }
  } catch {
    // fall through
  }

  return NextResponse.json({ models: multiLLM.getStats().models, _source: "mock" });
}