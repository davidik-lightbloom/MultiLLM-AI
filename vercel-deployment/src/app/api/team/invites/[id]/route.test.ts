import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthenticatedUserId: vi.fn(),
  cancelInvite: vi.fn(),
  isDemoMode: vi.fn(),
}));

vi.mock("@/lib/supabase/serverAuth", () => ({
  getAuthenticatedUserId: mocks.getAuthenticatedUserId,
}));
vi.mock("@/lib/supabase/team", () => ({
  cancelInvite: mocks.cancelInvite,
}));
vi.mock("@/lib/demoMode", () => ({
  isDemoMode: mocks.isDemoMode,
}));

import { DELETE } from "./route";

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("DELETE /api/team/invites/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isDemoMode.mockReturnValue(false);
    mocks.getAuthenticatedUserId.mockResolvedValue("owner-1");
  });

  it("requires authentication", async () => {
    mocks.getAuthenticatedUserId.mockResolvedValue(null);
    const res = await DELETE(new Request("http://localhost/api/team/invites/inv1"), params("inv1"));
    expect(res.status).toBe(401);
  });

  it("cancels a pending invite owned by the caller", async () => {
    mocks.cancelInvite.mockResolvedValue(true);
    const res = await DELETE(new Request("http://localhost/api/team/invites/inv1"), params("inv1"));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(mocks.cancelInvite).toHaveBeenCalledWith("owner-1", "inv1");
  });

  it("returns 404 for an invite that isn't the caller's (or doesn't exist)", async () => {
    mocks.cancelInvite.mockResolvedValue(false);
    const res = await DELETE(new Request("http://localhost/api/team/invites/inv1"), params("inv1"));
    expect(res.status).toBe(404);
  });
});
