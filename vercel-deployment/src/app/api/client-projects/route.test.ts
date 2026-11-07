import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getAuthenticatedUserId: vi.fn(),
  getProfile: vi.fn(),
  countActiveClientProjects: vi.fn(),
  createClientProject: vi.fn(),
  getClientProjects: vi.fn(),
  isDemoMode: vi.fn(),
  getTeamContext: vi.fn(),
}));

vi.mock("@/lib/supabase/serverAuth", () => ({
  getAuthenticatedUserId: mocks.getAuthenticatedUserId,
}));
vi.mock("@/lib/supabase/services", () => ({
  getProfile: mocks.getProfile,
  countActiveClientProjects: mocks.countActiveClientProjects,
  createClientProject: mocks.createClientProject,
  getClientProjects: mocks.getClientProjects,
  CLIENT_PROJECT_LIMITS: { free: 1, pro: 5, enterprise: Infinity },
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
  return new NextRequest("http://localhost:3000/api/client-projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/client-projects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAuthenticatedUserId.mockResolvedValue("user-1");
    mocks.isDemoMode.mockReturnValue(false);
    mocks.getTeamContext.mockImplementation(async (userId: string) => ({ tenantId: userId, role: "owner" }));
  });

  it("refuses creation for a plain team member (not owner/admin)", async () => {
    mocks.getTeamContext.mockResolvedValue({ tenantId: "owner-1", role: "member" });

    const res = await POST(postRequest({ name: "Acme" }));

    expect(res.status).toBe(403);
    expect(mocks.createClientProject).not.toHaveBeenCalled();
  });

  it("refuses to create a client project in demo mode", async () => {
    mocks.isDemoMode.mockReturnValue(true);

    const res = await POST(postRequest({ name: "Acme" }));

    expect(res.status).toBe(403);
    expect(mocks.getAuthenticatedUserId).not.toHaveBeenCalled();
  });

  it("rejects creation once the plan's client-project limit is reached", async () => {
    mocks.getProfile.mockResolvedValue({ plan: "free" });
    mocks.countActiveClientProjects.mockResolvedValue(1); // free limit is 1

    const res = await POST(postRequest({ name: "Second client" }));
    const json = await res.json();

    expect(res.status).toBe(402);
    expect(json.code).toBe("PROJECT_LIMIT_REACHED");
    expect(mocks.createClientProject).not.toHaveBeenCalled();
  });

  it("allows creation when under the plan's limit", async () => {
    mocks.getProfile.mockResolvedValue({ plan: "pro" });
    mocks.countActiveClientProjects.mockResolvedValue(2); // pro limit is 5
    mocks.createClientProject.mockResolvedValue({ id: "proj-1", name: "New client", user_id: "user-1" });

    const res = await POST(postRequest({ name: "New client" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.project.id).toBe("proj-1");
  });

  it("requires a name", async () => {
    mocks.getProfile.mockResolvedValue({ plan: "pro" });
    mocks.countActiveClientProjects.mockResolvedValue(0);

    const res = await POST(postRequest({}));
    expect(res.status).toBe(400);
  });

  it("requires authentication", async () => {
    mocks.getAuthenticatedUserId.mockResolvedValue(null);

    const res = await POST(postRequest({ name: "New client" }));
    expect(res.status).toBe(401);
  });
});
