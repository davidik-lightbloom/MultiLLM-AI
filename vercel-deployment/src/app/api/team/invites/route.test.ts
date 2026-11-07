import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getAuthenticatedUserId: vi.fn(),
  getProfile: vi.fn(),
  createInvite: vi.fn(),
  countTeamSeatsUsed: vi.fn(),
  getTeamContext: vi.fn(),
  isDemoMode: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock("@/lib/supabase/serverAuth", () => ({
  getAuthenticatedUserId: mocks.getAuthenticatedUserId,
}));
vi.mock("@/lib/supabase/services", () => ({
  getProfile: mocks.getProfile,
}));
vi.mock("@/lib/supabase/team", () => ({
  createInvite: mocks.createInvite,
  countTeamSeatsUsed: mocks.countTeamSeatsUsed,
  getTeamContext: mocks.getTeamContext,
  TEAM_SEAT_LIMITS: { free: 1, pro: 5, enterprise: Infinity },
}));
vi.mock("@/lib/email", () => ({
  sendEmail: mocks.sendEmail,
}));
vi.mock("@/lib/demoMode", () => ({
  isDemoMode: mocks.isDemoMode,
}));

import { POST } from "./route";

function postRequest(body: unknown) {
  return new NextRequest("http://localhost:3000/api/team/invites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/team/invites", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAuthenticatedUserId.mockResolvedValue("owner-1");
    mocks.getTeamContext.mockResolvedValue({ tenantId: "owner-1", role: "owner" });
    mocks.getProfile.mockResolvedValue({ plan: "pro", name: "Owner" });
    mocks.countTeamSeatsUsed.mockResolvedValue(1);
    mocks.isDemoMode.mockReturnValue(false);
    mocks.sendEmail.mockResolvedValue(undefined);
    mocks.createInvite.mockResolvedValue({
      success: true,
      token: "rawtoken123",
      invite: { id: "inv-1", invited_email: "friend@example.com", role: "member", expires_at: "2026-01-08T00:00:00Z", created_at: "2026-01-01T00:00:00Z" },
    });
  });

  it("refuses in demo mode", async () => {
    mocks.isDemoMode.mockReturnValue(true);
    const res = await POST(postRequest({ email: "friend@example.com" }));
    expect(res.status).toBe(403);
    expect(mocks.getAuthenticatedUserId).not.toHaveBeenCalled();
  });

  it("requires authentication", async () => {
    mocks.getAuthenticatedUserId.mockResolvedValue(null);
    const res = await POST(postRequest({ email: "friend@example.com" }));
    expect(res.status).toBe(401);
  });

  it("rejects an invalid email", async () => {
    const res = await POST(postRequest({ email: "not-an-email" }));
    expect(res.status).toBe(400);
    expect(mocks.createInvite).not.toHaveBeenCalled();
  });

  it("refuses when the caller is a team member, not the owner", async () => {
    mocks.getTeamContext.mockResolvedValue({ tenantId: "real-owner", role: "member" });
    const res = await POST(postRequest({ email: "friend@example.com" }));
    expect(res.status).toBe(403);
    expect(mocks.createInvite).not.toHaveBeenCalled();
  });

  it("rejects once the plan's seat limit is reached", async () => {
    mocks.getProfile.mockResolvedValue({ plan: "free", name: "Owner" });
    mocks.countTeamSeatsUsed.mockResolvedValue(1); // free limit is 1 (just the owner)

    const res = await POST(postRequest({ email: "friend@example.com" }));
    const json = await res.json();

    expect(res.status).toBe(402);
    expect(json.code).toBe("SEAT_LIMIT_REACHED");
    expect(mocks.createInvite).not.toHaveBeenCalled();
  });

  it("creates an invite, emails it (best-effort), and returns the invite link", async () => {
    const res = await POST(postRequest({ email: "friend@example.com", role: "admin" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(mocks.createInvite).toHaveBeenCalledWith("owner-1", "friend@example.com", "admin");
    expect(mocks.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "friend@example.com" }));
    expect(json.inviteUrl).toContain("rawtoken123");
  });

  it("still returns the invite successfully even if the notification email fails to send", async () => {
    mocks.sendEmail.mockRejectedValue(new Error("Resend down"));

    const res = await POST(postRequest({ email: "friend@example.com" }));

    expect(res.status).toBe(200);
  });

  it("surfaces a createInvite failure (e.g. already invited/already a member) as a 400", async () => {
    mocks.createInvite.mockResolvedValue({ success: false, error: "That person is already on your team." });

    const res = await POST(postRequest({ email: "friend@example.com" }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toMatch(/already/i);
  });
});
