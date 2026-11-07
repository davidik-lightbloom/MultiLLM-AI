import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthenticatedUserId: vi.fn(),
  getClientProject: vi.fn(),
  deleteClientProject: vi.fn(),
  isDemoMode: vi.fn(),
  getTeamContext: vi.fn(),
}));

vi.mock("@/lib/supabase/serverAuth", () => ({
  getAuthenticatedUserId: mocks.getAuthenticatedUserId,
}));
vi.mock("@/lib/supabase/services", () => ({
  getClientProject: mocks.getClientProject,
  deleteClientProject: mocks.deleteClientProject,
}));
vi.mock("@/lib/demoMode", () => ({
  isDemoMode: mocks.isDemoMode,
}));
vi.mock("@/lib/supabase/team", () => ({
  getTeamContext: mocks.getTeamContext,
  isTeamManager: (role: string) => role === "owner" || role === "admin",
}));

import { DELETE } from "./route";

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("DELETE /api/client-projects/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isDemoMode.mockReturnValue(false);
    mocks.getTeamContext.mockImplementation(async (userId: string) => ({ tenantId: userId, role: "owner" }));
  });

  it("refuses deletion for a plain team member (not owner/admin)", async () => {
    mocks.getAuthenticatedUserId.mockResolvedValue("member-1");
    mocks.getTeamContext.mockResolvedValue({ tenantId: "owner-1", role: "member" });

    const res = await DELETE(new Request("http://localhost/api/client-projects/p1"), params("p1"));

    expect(res.status).toBe(403);
    expect(mocks.getClientProject).not.toHaveBeenCalled();
  });

  it("refuses to delete a client project in demo mode", async () => {
    mocks.isDemoMode.mockReturnValue(true);

    const res = await DELETE(new Request("http://localhost/api/client-projects/p1"), params("p1"));

    expect(res.status).toBe(403);
    expect(mocks.getAuthenticatedUserId).not.toHaveBeenCalled();
  });

  it("requires authentication", async () => {
    mocks.getAuthenticatedUserId.mockResolvedValue(null);

    const res = await DELETE(new Request("http://localhost/api/client-projects/p1"), params("p1"));

    expect(res.status).toBe(401);
    expect(mocks.getClientProject).not.toHaveBeenCalled();
  });

  it("returns 404 rather than deleting a project owned by a different user", async () => {
    mocks.getAuthenticatedUserId.mockResolvedValue("user-1");
    mocks.getClientProject.mockResolvedValue({ id: "p1", user_id: "someone-else", name: "Other agency's project" });

    const res = await DELETE(new Request("http://localhost/api/client-projects/p1"), params("p1"));

    expect(res.status).toBe(404);
    expect(mocks.deleteClientProject).not.toHaveBeenCalled();
  });

  it("returns 404 for a project id that doesn't exist at all", async () => {
    mocks.getAuthenticatedUserId.mockResolvedValue("user-1");
    mocks.getClientProject.mockResolvedValue(null);

    const res = await DELETE(new Request("http://localhost/api/client-projects/nope"), params("nope"));

    expect(res.status).toBe(404);
  });

  it("deletes a project the caller actually owns", async () => {
    mocks.getAuthenticatedUserId.mockResolvedValue("user-1");
    mocks.getClientProject.mockResolvedValue({ id: "p1", user_id: "user-1", name: "My project" });
    mocks.deleteClientProject.mockResolvedValue(true);

    const res = await DELETE(new Request("http://localhost/api/client-projects/p1"), params("p1"));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(mocks.deleteClientProject).toHaveBeenCalledWith("p1");
  });
});
