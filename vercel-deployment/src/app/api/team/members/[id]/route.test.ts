import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getAuthenticatedUserId: vi.fn(),
  getTeamContext: vi.fn(),
  removeMember: vi.fn(),
  updateMemberRole: vi.fn(),
  leaveTeam: vi.fn(),
  isDemoMode: vi.fn(),
}));

vi.mock("@/lib/supabase/serverAuth", () => ({
  getAuthenticatedUserId: mocks.getAuthenticatedUserId,
}));
vi.mock("@/lib/supabase/team", () => ({
  getTeamContext: mocks.getTeamContext,
  removeMember: mocks.removeMember,
  updateMemberRole: mocks.updateMemberRole,
  leaveTeam: mocks.leaveTeam,
}));
vi.mock("@/lib/demoMode", () => ({
  isDemoMode: mocks.isDemoMode,
}));

import { PATCH, DELETE } from "./route";

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

function patchRequest(body: unknown) {
  return new NextRequest("http://localhost/api/team/members/m1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/team/members/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isDemoMode.mockReturnValue(false);
    mocks.getAuthenticatedUserId.mockResolvedValue("owner-1");
    mocks.getTeamContext.mockResolvedValue({ tenantId: "owner-1", role: "owner" });
    mocks.updateMemberRole.mockResolvedValue(true);
  });

  it("requires authentication", async () => {
    mocks.getAuthenticatedUserId.mockResolvedValue(null);
    const res = await PATCH(patchRequest({ role: "admin" }), params("m1"));
    expect(res.status).toBe(401);
  });

  it("refuses a non-owner changing roles", async () => {
    mocks.getTeamContext.mockResolvedValue({ tenantId: "owner-1", role: "admin" });
    const res = await PATCH(patchRequest({ role: "admin" }), params("m1"));
    expect(res.status).toBe(403);
    expect(mocks.updateMemberRole).not.toHaveBeenCalled();
  });

  it("rejects an invalid role value", async () => {
    const res = await PATCH(patchRequest({ role: "superadmin" }), params("m1"));
    expect(res.status).toBe(400);
  });

  it("updates the member's role", async () => {
    const res = await PATCH(patchRequest({ role: "admin" }), params("m1"));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(mocks.updateMemberRole).toHaveBeenCalledWith("owner-1", "m1", "admin");
  });

  it("returns 404 when the target isn't actually on the team", async () => {
    mocks.updateMemberRole.mockResolvedValue(false);
    const res = await PATCH(patchRequest({ role: "admin" }), params("m1"));
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/team/members/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isDemoMode.mockReturnValue(false);
    mocks.removeMember.mockResolvedValue(true);
    mocks.leaveTeam.mockResolvedValue(true);
  });

  it("lets a member leave the team by targeting their own id, without an owner role check", async () => {
    mocks.getAuthenticatedUserId.mockResolvedValue("member-1");

    const res = await DELETE(new Request("http://localhost/api/team/members/member-1"), params("member-1"));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(mocks.leaveTeam).toHaveBeenCalledWith("member-1");
    expect(mocks.getTeamContext).not.toHaveBeenCalled();
  });

  it("refuses a non-owner removing someone else", async () => {
    mocks.getAuthenticatedUserId.mockResolvedValue("admin-1");
    mocks.getTeamContext.mockResolvedValue({ tenantId: "owner-1", role: "admin" });

    const res = await DELETE(new Request("http://localhost/api/team/members/member-2"), params("member-2"));

    expect(res.status).toBe(403);
    expect(mocks.removeMember).not.toHaveBeenCalled();
  });

  it("lets the owner remove another member", async () => {
    mocks.getAuthenticatedUserId.mockResolvedValue("owner-1");
    mocks.getTeamContext.mockResolvedValue({ tenantId: "owner-1", role: "owner" });

    const res = await DELETE(new Request("http://localhost/api/team/members/member-2"), params("member-2"));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(mocks.removeMember).toHaveBeenCalledWith("owner-1", "member-2");
  });
});
