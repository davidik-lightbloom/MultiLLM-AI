import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getAuthenticatedUserId: vi.fn(),
  acceptInvite: vi.fn(),
  isDemoMode: vi.fn(),
  getUserById: vi.fn(),
}));

vi.mock("@/lib/supabase/serverAuth", () => ({
  getAuthenticatedUserId: mocks.getAuthenticatedUserId,
}));
vi.mock("@/lib/supabase/team", () => ({
  acceptInvite: mocks.acceptInvite,
}));
vi.mock("@/lib/supabase/client", () => ({
  createServerSupabaseClient: () => ({
    auth: { admin: { getUserById: mocks.getUserById } },
  }),
}));
vi.mock("@/lib/demoMode", () => ({
  isDemoMode: mocks.isDemoMode,
}));

import { POST } from "./route";

function postRequest(body: unknown) {
  return new NextRequest("http://localhost:3000/api/team/invites/accept", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/team/invites/accept", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAuthenticatedUserId.mockResolvedValue("member-1");
    mocks.isDemoMode.mockReturnValue(false);
    mocks.getUserById.mockResolvedValue({ data: { user: { email: "friend@example.com" } }, error: null });
    mocks.acceptInvite.mockResolvedValue({ success: true, ownerId: "owner-1" });
  });

  it("refuses in demo mode", async () => {
    mocks.isDemoMode.mockReturnValue(true);
    const res = await POST(postRequest({ token: "abc" }));
    expect(res.status).toBe(403);
  });

  it("requires authentication", async () => {
    mocks.getAuthenticatedUserId.mockResolvedValue(null);
    const res = await POST(postRequest({ token: "abc" }));
    expect(res.status).toBe(401);
  });

  it("requires a token", async () => {
    const res = await POST(postRequest({}));
    expect(res.status).toBe(400);
    expect(mocks.acceptInvite).not.toHaveBeenCalled();
  });

  it("verifies the caller's own auth email before accepting", async () => {
    await POST(postRequest({ token: "abc" }));
    expect(mocks.acceptInvite).toHaveBeenCalledWith("member-1", "friend@example.com", "abc");
  });

  it("surfaces an acceptInvite failure (expired/wrong email/already a member) as a 400", async () => {
    mocks.acceptInvite.mockResolvedValue({ success: false, error: "This invite was sent to a different email address." });

    const res = await POST(postRequest({ token: "abc" }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toMatch(/different email/i);
  });

  it("returns success once accepted", async () => {
    const res = await POST(postRequest({ token: "abc" }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
  });
});
