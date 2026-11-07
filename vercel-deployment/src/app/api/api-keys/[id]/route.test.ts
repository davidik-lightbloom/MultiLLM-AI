import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getAuthenticatedUserId: vi.fn(),
  getPlatformApiKeyById: vi.fn(),
  deletePlatformApiKey: vi.fn(),
  isDemoMode: vi.fn(),
  getTeamContext: vi.fn(),
}));

vi.mock("@/lib/supabase/serverAuth", () => ({
  getAuthenticatedUserId: mocks.getAuthenticatedUserId,
}));
vi.mock("@/lib/supabase/services", () => ({
  getPlatformApiKeyById: mocks.getPlatformApiKeyById,
  deletePlatformApiKey: mocks.deletePlatformApiKey,
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

describe("DELETE /api/api-keys/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isDemoMode.mockReturnValue(false);
    mocks.getTeamContext.mockImplementation(async (userId: string) => ({ tenantId: userId, role: "owner" }));
  });

  it("refuses revocation for a plain team member (not owner/admin)", async () => {
    mocks.getAuthenticatedUserId.mockResolvedValue("member-1");
    mocks.getTeamContext.mockResolvedValue({ tenantId: "owner-1", role: "member" });

    const res = await DELETE(new NextRequest("http://localhost/api/api-keys/k1"), params("k1"));

    expect(res.status).toBe(403);
    expect(mocks.getPlatformApiKeyById).not.toHaveBeenCalled();
  });

  it("refuses to revoke a key in demo mode", async () => {
    mocks.isDemoMode.mockReturnValue(true);

    const res = await DELETE(new NextRequest("http://localhost/api/api-keys/k1"), params("k1"));

    expect(res.status).toBe(403);
    expect(mocks.getAuthenticatedUserId).not.toHaveBeenCalled();
  });

  it("returns 404 rather than deleting a key owned by a different user", async () => {
    mocks.getAuthenticatedUserId.mockResolvedValue("user-1");
    mocks.getPlatformApiKeyById.mockResolvedValue({ id: "k1", user_id: "someone-else" });

    const res = await DELETE(new NextRequest("http://localhost/api/api-keys/k1"), params("k1"));

    expect(res.status).toBe(404);
    expect(mocks.deletePlatformApiKey).not.toHaveBeenCalled();
  });

  it("deletes a key the caller actually owns", async () => {
    mocks.getAuthenticatedUserId.mockResolvedValue("user-1");
    mocks.getPlatformApiKeyById.mockResolvedValue({ id: "k1", user_id: "user-1" });
    mocks.deletePlatformApiKey.mockResolvedValue(true);

    const res = await DELETE(new NextRequest("http://localhost/api/api-keys/k1"), params("k1"));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(mocks.deletePlatformApiKey).toHaveBeenCalledWith("k1");
  });
});
