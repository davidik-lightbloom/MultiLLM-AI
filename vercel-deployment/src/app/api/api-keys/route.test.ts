import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getAuthenticatedUserId: vi.fn(),
  getProfile: vi.fn(),
  createPlatformApiKey: vi.fn(),
  getPlatformApiKeys: vi.fn(),
  isDemoMode: vi.fn(),
  getTeamContext: vi.fn(),
}));

vi.mock("@/lib/supabase/serverAuth", () => ({
  getAuthenticatedUserId: mocks.getAuthenticatedUserId,
}));
vi.mock("@/lib/supabase/services", () => ({
  getProfile: mocks.getProfile,
  createPlatformApiKey: mocks.createPlatformApiKey,
  getPlatformApiKeys: mocks.getPlatformApiKeys,
}));
vi.mock("@/lib/demoMode", () => ({
  isDemoMode: mocks.isDemoMode,
}));
vi.mock("@/lib/supabase/team", () => ({
  getTeamContext: mocks.getTeamContext,
  isTeamManager: (role: string) => role === "owner" || role === "admin",
}));

import { POST } from "./route";

function postRequest(body: unknown) {
  return new NextRequest("http://localhost:3000/api/api-keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/api-keys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAuthenticatedUserId.mockResolvedValue("user-1");
    mocks.isDemoMode.mockReturnValue(false);
    mocks.getTeamContext.mockImplementation(async (userId: string) => ({ tenantId: userId, role: "owner" }));
  });

  it("refuses key generation for a plain team member (not owner/admin)", async () => {
    mocks.getTeamContext.mockResolvedValue({ tenantId: "owner-1", role: "member" });

    const res = await POST(postRequest({ name: "Key", tier: "free" }));

    expect(res.status).toBe(403);
    expect(mocks.createPlatformApiKey).not.toHaveBeenCalled();
  });

  it("refuses to generate a key in demo mode", async () => {
    mocks.isDemoMode.mockReturnValue(true);

    const res = await POST(postRequest({ name: "Key", tier: "free" }));

    expect(res.status).toBe(403);
    expect(mocks.getAuthenticatedUserId).not.toHaveBeenCalled();
  });

  it("rejects a free-plan account requesting an enterprise-tier key, even calling the API directly", async () => {
    mocks.getProfile.mockResolvedValue({ plan: "free" });

    const res = await POST(postRequest({ name: "Sneaky key", tier: "enterprise" }));
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error).toMatch(/free/i);
    expect(mocks.createPlatformApiKey).not.toHaveBeenCalled();
  });

  it("rejects a pro-plan account requesting an enterprise-tier key", async () => {
    mocks.getProfile.mockResolvedValue({ plan: "pro" });

    const res = await POST(postRequest({ name: "Sneaky key", tier: "enterprise" }));

    expect(res.status).toBe(403);
    expect(mocks.createPlatformApiKey).not.toHaveBeenCalled();
  });

  it("allows a pro-plan account to create a pro-tier key", async () => {
    mocks.getProfile.mockResolvedValue({ plan: "pro" });
    mocks.createPlatformApiKey.mockResolvedValue({
      id: "key-1",
      name: "My key",
      tier: "pro",
      key_prefix: "mllm_pro_abc1",
      created_at: "2026-01-01T00:00:00Z",
    });

    const res = await POST(postRequest({ name: "My key", tier: "pro" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.tier).toBe("pro");
    expect(mocks.createPlatformApiKey).toHaveBeenCalledWith(
      "user-1",
      "My key",
      "pro",
      expect.any(String),
      expect.any(String),
    );
  });

  it("defaults an unrecognized tier value to free rather than rejecting or crashing", async () => {
    mocks.getProfile.mockResolvedValue({ plan: "free" });
    mocks.createPlatformApiKey.mockResolvedValue({
      id: "key-1",
      name: "My key",
      tier: "free",
      key_prefix: "mllm_free_abc1",
      created_at: "2026-01-01T00:00:00Z",
    });

    const res = await POST(postRequest({ name: "My key", tier: "superadmin" }));

    expect(res.status).toBe(200);
    expect(mocks.createPlatformApiKey).toHaveBeenCalledWith(
      "user-1",
      "My key",
      "free",
      expect.any(String),
      expect.any(String),
    );
  });

  it("requires a name", async () => {
    mocks.getProfile.mockResolvedValue({ plan: "free" });

    const res = await POST(postRequest({ tier: "free" }));
    expect(res.status).toBe(400);
  });

  it("requires authentication", async () => {
    mocks.getAuthenticatedUserId.mockResolvedValue(null);

    const res = await POST(postRequest({ name: "My key" }));
    expect(res.status).toBe(401);
  });
});
