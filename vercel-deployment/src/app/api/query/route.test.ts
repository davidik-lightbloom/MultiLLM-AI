import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getAuthenticatedUserId: vi.fn(),
  authenticateApiKey: vi.fn(),
  getProfile: vi.fn(),
  consumeCredits: vi.fn(),
  getApiKeys: vi.fn(),
  getClientProject: vi.fn(),
  incrementApiKeyUsage: vi.fn(),
  checkRateLimit: vi.fn(),
  getClientIp: vi.fn(),
  decryptApiKey: vi.fn(),
  isDemoMode: vi.fn(),
  insertQuery: vi.fn(),
  getTodayProviderSpendUsd: vi.fn(),
  recordQueryError: vi.fn(),
  getTeamContext: vi.fn(),
}));

vi.mock("@/lib/supabase/serverAuth", () => ({
  getAuthenticatedUserId: mocks.getAuthenticatedUserId,
}));
vi.mock("@/lib/apiKeyAuth", () => ({
  authenticateApiKey: mocks.authenticateApiKey,
}));
vi.mock("@/lib/supabase/services", () => ({
  getProfile: mocks.getProfile,
  consumeCredits: mocks.consumeCredits,
  getApiKeys: mocks.getApiKeys,
  getClientProject: mocks.getClientProject,
  incrementApiKeyUsage: mocks.incrementApiKeyUsage,
  getTodayProviderSpendUsd: mocks.getTodayProviderSpendUsd,
  recordQueryError: mocks.recordQueryError,
}));
vi.mock("@/lib/supabase/client", () => ({
  createServerSupabaseClient: () => ({
    from: () => ({ insert: mocks.insertQuery }),
  }),
}));
vi.mock("@/lib/rateLimiter", () => ({
  checkRateLimit: mocks.checkRateLimit,
  getClientIp: mocks.getClientIp,
}));
vi.mock("@/lib/encryption", () => ({
  decryptApiKey: mocks.decryptApiKey,
}));
vi.mock("@/lib/demoMode", () => ({
  isDemoMode: mocks.isDemoMode,
}));
vi.mock("@/lib/supabase/team", () => ({
  getTeamContext: mocks.getTeamContext,
}));

import { POST } from "./route";

const BASE_PROFILE = {
  id: "user-1",
  email: "user@example.com",
  name: "Test User",
  plan: "free" as const,
  credits: 100,
  credits_period_start: "2026-01-01T00:00:00Z",
  plan_expires_at: null as string | null,
  is_active: true,
  local_only_mode: false,
  default_mode: "fast" as const,
  enabled_skills: ["general"],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

function postRequest(body: unknown) {
  return new NextRequest("http://localhost:3000/api/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/query", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateApiKey.mockResolvedValue(null);
    mocks.getAuthenticatedUserId.mockResolvedValue("user-1");
    mocks.getProfile.mockResolvedValue({ ...BASE_PROFILE });
    mocks.getApiKeys.mockResolvedValue([]);
    mocks.getClientProject.mockResolvedValue(null);
    mocks.consumeCredits.mockResolvedValue({ success: true, remainingCredits: 99 });
    mocks.getClientIp.mockReturnValue("127.0.0.1");
    mocks.checkRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
    mocks.isDemoMode.mockReturnValue(false);
    mocks.insertQuery.mockResolvedValue({ data: null, error: null });
    mocks.getTeamContext.mockImplementation(async (userId: string) => ({ tenantId: userId, role: "owner" }));
    mocks.getTodayProviderSpendUsd.mockResolvedValue(0);
    mocks.recordQueryError.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects a request with no prompt", async () => {
    const res = await POST(postRequest({ prompt: "" }));
    expect(res.status).toBe(400);
  });

  it("falls back to a 503 ENSEMBLE_UNAVAILABLE response when the Python ensemble is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
    );

    const res = await POST(postRequest({ prompt: "hello" }));
    const json = await res.json();

    expect(res.status).toBe(503);
    expect(json.code).toBe("ENSEMBLE_UNAVAILABLE");
  });

  it("rejects a deactivated account with 403, without ever calling the ensemble", async () => {
    mocks.getProfile.mockResolvedValue({ ...BASE_PROFILE, is_active: false });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const res = await POST(postRequest({ prompt: "hello" }));

    expect(res.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects an expired plan with 402", async () => {
    mocks.getProfile.mockResolvedValue({
      ...BASE_PROFILE,
      plan_expires_at: "2020-01-01T00:00:00Z",
    });
    vi.stubGlobal("fetch", vi.fn());

    const res = await POST(postRequest({ prompt: "hello" }));
    const json = await res.json();

    expect(res.status).toBe(402);
    expect(json.error).toMatch(/expired/i);
  });

  it("rejects a request when consumeCredits reports insufficient credits, without calling the ensemble", async () => {
    mocks.consumeCredits.mockResolvedValue({ success: false });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const res = await POST(postRequest({ prompt: "hello" }));

    expect(res.status).toBe(402);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 429 with a Retry-After header when rate limited", async () => {
    mocks.checkRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 42 });
    vi.stubGlobal("fetch", vi.fn());

    const res = await POST(postRequest({ prompt: "hello" }));

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
  });

  it("treats demo-mode requests as pro-tier (rate limit + Deep Review), scoped per-IP", async () => {
    mocks.isDemoMode.mockReturnValue(true);
    mocks.getAuthenticatedUserId.mockResolvedValue(null);
    mocks.getClientIp.mockReturnValue("198.51.100.7");
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        answer: "The answer.",
        candidates: [{ provider_name: "openai", model: "gpt-4o-mini" }],
        sources: [],
        metrics: { top_score: 0.9, latency_ms: 1200 },
        providers_used: ["openai"],
      }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const res = await POST(postRequest({ prompt: "hello", deep_review: true }));

    expect(res.status).toBe(200);
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ tier: "pro", identityKey: "demo:198.51.100.7" })
    );
    const sentBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(sentBody.deep_review).toBe(true);
    // No real session -- credits are never touched in demo mode.
    expect(mocks.consumeCredits).not.toHaveBeenCalled();
  });

  it("suggests signing up when the anonymous global daily cap is hit", async () => {
    mocks.checkRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 3600, reason: "anon_daily_cap" });
    vi.stubGlobal("fetch", vi.fn());

    const res = await POST(postRequest({ prompt: "hello" }));
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(json.code).toBe("anon_daily_cap");
    expect(json.error).toMatch(/sign up/i);
  });

  it("returns a real answer and consumes a credit on a successful ensemble response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          answer: "The answer.",
          candidates: [{ provider_name: "openai", model: "gpt-4o-mini" }],
          sources: [],
          metrics: { top_score: 0.9, latency_ms: 1200 },
          providers_used: ["openai"],
        }),
      }),
    );

    const res = await POST(postRequest({ prompt: "hello" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.answer).toBe("The answer.");
    expect(json._source).toBe("python-ensemble");
    expect(mocks.consumeCredits).toHaveBeenCalledWith("user-1", 1, expect.objectContaining({ id: "user-1" }));
  });

  it("still consumes a credit even when the ensemble call then fails (credit is spent up front, atomically, before the call)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")));

    const res = await POST(postRequest({ prompt: "hello" }));

    expect(res.status).toBe(503);
    expect(mocks.consumeCredits).toHaveBeenCalledWith("user-1", 1, expect.objectContaining({ id: "user-1" }));
  });

  describe("stream: true (Feature 2)", () => {
    function sseResponse(events: Record<string, unknown>[]) {
      const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
      return {
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(body));
            controller.close();
          },
        }),
      };
    }

    it("proxies the Python ensemble's SSE endpoint instead of the JSON one", async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        sseResponse([
          { event: "status", stage: "synthesizing" },
          { event: "done", answer: "Streamed answer.", candidates: [], sources: [], metrics: { top_score: 0.8 } },
        ])
      );
      vi.stubGlobal("fetch", fetchSpy);

      const res = await POST(postRequest({ prompt: "hello", stream: true }));

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/event-stream");
      expect(fetchSpy.mock.calls[0][0]).toMatch(/\/api\/query\/stream$/);

      const text = await res.text();
      expect(text).toContain('"stage":"synthesizing"');
      expect(text).toContain("Streamed answer.");
    });

    it("records query history and API-key usage from the final 'done' event once the stream ends", async () => {
      const recordUsage = vi.fn().mockResolvedValue(undefined);
      mocks.authenticateApiKey.mockResolvedValue({ userId: "user-1", tier: "pro", keyId: "key-1", recordUsage });
      const fetchSpy = vi.fn().mockResolvedValue(
        sseResponse([
          {
            event: "done",
            answer: "Streamed answer.",
            candidates: [{ provider_name: "Groq (OpenAI API)" }],
            sources: [],
            metrics: { top_score: 0.8, latency_ms: 500, carbon_saved_g: 0.1, emissions_g: 0.01 },
            providers_used: ["Groq (OpenAI API)"],
          },
        ])
      );
      vi.stubGlobal("fetch", fetchSpy);

      const res = await POST(postRequest({ prompt: "hello", stream: true }));
      await res.text(); // drain the stream so the post-close accounting runs

      expect(recordUsage).toHaveBeenCalled();
      expect(mocks.insertQuery).toHaveBeenCalledWith(
        expect.objectContaining({ answer: "Streamed answer.", top_provider: "Groq (OpenAI API)" })
      );
      // Regression guard: the streaming path must cost its query the same
      // way the non-streaming path does, or the global daily spend cap
      // silently never sees any spend from stream:true traffic (the main
      // homepage UI always sends stream:true).
      const insertedRecord = mocks.insertQuery.mock.calls[0][0];
      expect(insertedRecord.estimated_cost_usd).toBeGreaterThan(0);
    });

    it("falls back to a 503 ENSEMBLE_UNAVAILABLE response when the stream endpoint is unreachable", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")));

      const res = await POST(postRequest({ prompt: "hello", stream: true }));
      const json = await res.json();

      expect(res.status).toBe(503);
      expect(json.code).toBe("ENSEMBLE_UNAVAILABLE");
    });
  });

  describe("local_only (Feature 4)", () => {
    function jsonResponse(body: Record<string, unknown>) {
      return { ok: true, json: async () => body };
    }

    it("forwards local_only to the Python ensemble when requested per-request", async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        jsonResponse({ answer: "Local answer.", candidates: [], sources: [], metrics: {} })
      );
      vi.stubGlobal("fetch", fetchSpy);

      const res = await POST(postRequest({ prompt: "hello", local_only: true }));

      expect(res.status).toBe(200);
      const sentBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(sentBody.local_only).toBe(true);
      // Skips BYO-key loading entirely -- nothing would use the keys.
      expect(mocks.getApiKeys).not.toHaveBeenCalled();
    });

    it("forwards local_only when it's the user's saved profile preference, even with no per-request flag", async () => {
      mocks.getProfile.mockResolvedValue({ ...BASE_PROFILE, local_only_mode: true });
      const fetchSpy = vi.fn().mockResolvedValue(
        jsonResponse({ answer: "Local answer.", candidates: [], sources: [], metrics: {} })
      );
      vi.stubGlobal("fetch", fetchSpy);

      const res = await POST(postRequest({ prompt: "hello" }));

      expect(res.status).toBe(200);
      const sentBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(sentBody.local_only).toBe(true);
    });

    it("bypasses the daily spend cap entirely for a local-only request", async () => {
      vi.stubEnv("DAILY_PROVIDER_SPEND_CAP_USD", "1");
      mocks.getTodayProviderSpendUsd.mockResolvedValue(999); // would otherwise block
      const fetchSpy = vi.fn().mockResolvedValue(
        jsonResponse({ answer: "Local answer.", candidates: [], sources: [], metrics: {} })
      );
      vi.stubGlobal("fetch", fetchSpy);

      const res = await POST(postRequest({ prompt: "hello", local_only: true }));

      expect(res.status).toBe(200);
      expect(mocks.getTodayProviderSpendUsd).not.toHaveBeenCalled();
    });
  });

  describe("mode (Phase 1)", () => {
    function jsonResponse(body: Record<string, unknown>) {
      return { ok: true, json: async () => body };
    }

    it("forwards mode='deep' to the Python ensemble when requested per-request", async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        jsonResponse({ answer: "Deep answer.", candidates: [], sources: [], metrics: {} })
      );
      vi.stubGlobal("fetch", fetchSpy);

      const res = await POST(postRequest({ prompt: "hello", mode: "deep" }));

      expect(res.status).toBe(200);
      const sentBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(sentBody.mode).toBe("deep");
    });

    it("forwards mode='deep' when it's the user's saved default_mode, even with no per-request flag", async () => {
      mocks.getProfile.mockResolvedValue({ ...BASE_PROFILE, default_mode: "deep" });
      const fetchSpy = vi.fn().mockResolvedValue(
        jsonResponse({ answer: "Deep answer.", candidates: [], sources: [], metrics: {} })
      );
      vi.stubGlobal("fetch", fetchSpy);

      const res = await POST(postRequest({ prompt: "hello" }));

      expect(res.status).toBe(200);
      const sentBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(sentBody.mode).toBe("deep");
    });

    it("passes mode through regardless of plan, but only unlocks Deep Review for a paid plan", async () => {
      // Free plan: mode forwarded, but deep_review stays gated off.
      const freeFetchSpy = vi.fn().mockResolvedValue(
        jsonResponse({ answer: "Deep answer.", candidates: [], sources: [], metrics: {} })
      );
      vi.stubGlobal("fetch", freeFetchSpy);

      const freeRes = await POST(postRequest({ prompt: "hello", mode: "deep" }));

      expect(freeRes.status).toBe(200);
      const freeBody = JSON.parse(freeFetchSpy.mock.calls[0][1].body);
      expect(freeBody.mode).toBe("deep");
      expect(freeBody.deep_review).toBeFalsy();

      // Pro plan: same mode='deep' request now also gets Deep Review.
      mocks.getProfile.mockResolvedValue({ ...BASE_PROFILE, plan: "pro" });
      const proFetchSpy = vi.fn().mockResolvedValue(
        jsonResponse({ answer: "Deep answer.", candidates: [], sources: [], metrics: {} })
      );
      vi.stubGlobal("fetch", proFetchSpy);

      const proRes = await POST(postRequest({ prompt: "hello", mode: "deep" }));

      expect(proRes.status).toBe(200);
      const proBody = JSON.parse(proFetchSpy.mock.calls[0][1].body);
      expect(proBody.mode).toBe("deep");
      expect(proBody.deep_review).toBe(true);
    });
  });

  describe("team tenant resolution", () => {
    function jsonResponse(body: unknown) {
      return { ok: true, json: async () => body };
    }

    it("bills/saves a team member's query against the team owner's tenant, tagging actor_id with the real caller", async () => {
      mocks.getAuthenticatedUserId.mockResolvedValue("member-1");
      mocks.getTeamContext.mockResolvedValue({ tenantId: "owner-1", role: "member" });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          jsonResponse({ answer: "Hi.", candidates: [], sources: [], metrics: {} })
        )
      );

      const res = await POST(postRequest({ prompt: "hello" }));

      expect(res.status).toBe(200);
      expect(mocks.getProfile).toHaveBeenCalledWith("owner-1");
      expect(mocks.consumeCredits).toHaveBeenCalledWith("owner-1", 1, expect.anything());
      expect(mocks.insertQuery).toHaveBeenCalledWith(
        expect.objectContaining({ user_id: "owner-1", actor_id: "member-1" })
      );
    });

    it("sets actor_id to the owner's own id for a solo (non-team) account, not null", async () => {
      mocks.getTeamContext.mockResolvedValue({ tenantId: "user-1", role: "owner" });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          jsonResponse({ answer: "Hi.", candidates: [], sources: [], metrics: {} })
        )
      );

      await POST(postRequest({ prompt: "hello" }));

      expect(mocks.insertQuery).toHaveBeenCalledWith(
        expect.objectContaining({ user_id: "user-1", actor_id: "user-1" })
      );
    });
  });
});
