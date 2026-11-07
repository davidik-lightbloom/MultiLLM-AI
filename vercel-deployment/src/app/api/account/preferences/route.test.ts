import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getAuthenticatedUserId: vi.fn(),
  updateProfile: vi.fn(),
  getTeamContext: vi.fn(),
  isDemoMode: vi.fn(),
}));

vi.mock("@/lib/supabase/serverAuth", () => ({
  getAuthenticatedUserId: mocks.getAuthenticatedUserId,
}));
vi.mock("@/lib/supabase/services", () => ({
  updateProfile: mocks.updateProfile,
}));
vi.mock("@/lib/supabase/team", () => ({
  getTeamContext: mocks.getTeamContext,
}));
vi.mock("@/lib/demoMode", () => ({
  isDemoMode: mocks.isDemoMode,
}));

import { POST } from "./route";

function postRequest(body: unknown) {
  return new NextRequest("http://localhost:3000/api/account/preferences", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/account/preferences", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAuthenticatedUserId.mockResolvedValue("member-1");
    mocks.getTeamContext.mockResolvedValue({ tenantId: "owner-1", role: "member" });
    mocks.updateProfile.mockResolvedValue({ id: "owner-1", default_mode: "deep" });
    mocks.isDemoMode.mockReturnValue(false);
  });

  it("requires authentication", async () => {
    mocks.getAuthenticatedUserId.mockResolvedValue(null);
    const res = await POST(postRequest({ default_mode: "deep" }));
    expect(res.status).toBe(401);
  });

  it("rejects an unrecognized default_mode value", async () => {
    const res = await POST(postRequest({ default_mode: "turbo" }));
    expect(res.status).toBe(400);
    expect(mocks.updateProfile).not.toHaveBeenCalled();
  });

  it("rejects enabled_skills that isn't an array of strings", async () => {
    const res = await POST(postRequest({ enabled_skills: "coding" }));
    expect(res.status).toBe(400);
  });

  it("rejects when no recognized field is supplied (ignores unknown fields like plan/credits)", async () => {
    const res = await POST(postRequest({ plan: "enterprise", credits: 999999 }));
    expect(res.status).toBe(400);
    expect(mocks.updateProfile).not.toHaveBeenCalled();
  });

  it("writes the update to the resolved tenant (team owner), not the caller's own id", async () => {
    const res = await POST(postRequest({ default_mode: "deep", enabled_skills: ["general", "coding"] }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(mocks.updateProfile).toHaveBeenCalledWith("owner-1", { default_mode: "deep", enabled_skills: ["general", "coding"] });
    expect(json.profile).toBeDefined();
  });

  it("writes to the caller's own profile when they aren't on a team", async () => {
    mocks.getTeamContext.mockResolvedValue({ tenantId: "member-1", role: "owner" });

    await POST(postRequest({ local_only_mode: true }));

    expect(mocks.updateProfile).toHaveBeenCalledWith("member-1", { local_only_mode: true });
  });
});
