import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getAuthenticatedUserId: vi.fn(),
  getQueries: vi.fn(),
  getQueryStats: vi.fn(),
  isDemoMode: vi.fn(),
  getTeamContext: vi.fn(),
}));

vi.mock("@/lib/supabase/serverAuth", () => ({
  getAuthenticatedUserId: mocks.getAuthenticatedUserId,
}));
vi.mock("@/lib/supabase/services", () => ({
  getQueries: mocks.getQueries,
  getQueryStats: mocks.getQueryStats,
}));
vi.mock("@/lib/demoMode", () => ({
  isDemoMode: mocks.isDemoMode,
}));
vi.mock("@/lib/supabase/team", () => ({
  getTeamContext: mocks.getTeamContext,
}));

import { GET } from "./route";

function getRequest() {
  return new NextRequest("http://localhost:3000/api/analytics");
}

describe("GET /api/analytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isDemoMode.mockReturnValue(false);
    mocks.getTeamContext.mockImplementation(async (userId: string) => ({ tenantId: userId, role: "owner" }));
  });

  it("reads a team member's analytics from their team owner's tenant id", async () => {
    mocks.getAuthenticatedUserId.mockResolvedValue("member-1");
    mocks.getTeamContext.mockResolvedValue({ tenantId: "owner-1", role: "member" });
    mocks.getQueries.mockResolvedValue([]);
    mocks.getQueryStats.mockResolvedValue({ totalQueries: 0, totalCreditsUsed: 0, avgLatency: 0, totalCarbonSaved: 0 });

    await GET(getRequest());

    expect(mocks.getQueries).toHaveBeenCalledWith("owner-1", 500, 0);
    expect(mocks.getQueryStats).toHaveBeenCalledWith("owner-1");
  });

  it("returns a zeroed-out, valid shape in demo mode instead of 401ing", async () => {
    mocks.isDemoMode.mockReturnValue(true);

    const res = await GET(getRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.overview).toEqual([]);
    expect(json.hourlyData).toHaveLength(24);
    expect(json.totals).toEqual({ totalQueries: 0, avgAccuracy: 0, totalCarbonSaved: 0, avgLatencyMs: 0 });
    expect(mocks.getAuthenticatedUserId).not.toHaveBeenCalled();
  });

  it("requires authentication outside demo mode", async () => {
    mocks.getAuthenticatedUserId.mockResolvedValue(null);

    const res = await GET(getRequest());

    expect(res.status).toBe(401);
  });
});
