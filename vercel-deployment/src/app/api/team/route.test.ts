import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthenticatedUserId: vi.fn(),
  getProfile: vi.fn(),
  getTeamContext: vi.fn(),
  getTeamRoster: vi.fn(),
  getPendingInvites: vi.fn(),
  isDemoMode: vi.fn(),
}));

vi.mock("@/lib/supabase/serverAuth", () => ({
  getAuthenticatedUserId: mocks.getAuthenticatedUserId,
}));
vi.mock("@/lib/supabase/services", () => ({
  getProfile: mocks.getProfile,
}));
vi.mock("@/lib/supabase/team", () => ({
  getTeamContext: mocks.getTeamContext,
  getTeamRoster: mocks.getTeamRoster,
  getPendingInvites: mocks.getPendingInvites,
  TEAM_SEAT_LIMITS: { free: 1, pro: 5, enterprise: Infinity },
}));
vi.mock("@/lib/demoMode", () => ({
  isDemoMode: mocks.isDemoMode,
}));

import { GET } from "./route";

describe("GET /api/team", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isDemoMode.mockReturnValue(false);
    mocks.getAuthenticatedUserId.mockResolvedValue("owner-1");
    mocks.getTeamContext.mockResolvedValue({ tenantId: "owner-1", role: "owner" });
    mocks.getProfile.mockResolvedValue({ plan: "pro" });
    mocks.getTeamRoster.mockResolvedValue([{ id: "tm1", member_id: "member-1", role: "member", created_at: "", name: null, email: "m@example.com" }]);
    mocks.getPendingInvites.mockResolvedValue([{ id: "inv1", invited_email: "x@example.com", role: "member", expires_at: "", created_at: "" }]);
  });

  it("requires authentication", async () => {
    mocks.getAuthenticatedUserId.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns the roster and seat limit for the owner, including pending invites", async () => {
    const res = await GET();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.role).toBe("owner");
    expect(json.roster).toHaveLength(1);
    expect(json.pendingInvites).toHaveLength(1);
    expect(json.seatLimit).toBe(5);
  });

  it("omits pending invites for a plain team member", async () => {
    mocks.getAuthenticatedUserId.mockResolvedValue("member-1");
    mocks.getTeamContext.mockResolvedValue({ tenantId: "owner-1", role: "member" });

    const res = await GET();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.pendingInvites).toEqual([]);
    expect(mocks.getPendingInvites).not.toHaveBeenCalled();
  });

  it("reports an unbounded seat limit (null) for enterprise", async () => {
    mocks.getProfile.mockResolvedValue({ plan: "enterprise" });
    const res = await GET();
    const json = await res.json();
    expect(json.seatLimit).toBeNull();
  });
});
