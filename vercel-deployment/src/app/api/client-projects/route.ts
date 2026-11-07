import { NextRequest, NextResponse } from "next/server";
import {
  createClientProject,
  getClientProjects,
  countActiveClientProjects,
  getProfile,
  CLIENT_PROJECT_LIMITS,
} from "@/lib/supabase/services";
import { getAuthenticatedUserId } from "@/lib/supabase/serverAuth";
import { getTeamContext, isTeamManager } from "@/lib/supabase/team";
import { isDemoMode } from "@/lib/demoMode";
import { demoModeUnavailable } from "@/lib/demoModeApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (isDemoMode()) {
    // Matches the fake "pro" demo account shown elsewhere (AuthProvider's
    // demoUser()) rather than defaulting to the free-tier limit.
    return NextResponse.json({ projects: [], limit: CLIENT_PROJECT_LIMITS.pro, plan: "pro" });
  }

  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // Any team member can view the tenant's client projects (read-only for a
  // plain 'member' -- see POST below for the manager-only mutation gate).
  const { tenantId } = await getTeamContext(userId);
  const [projects, profile] = await Promise.all([getClientProjects(tenantId), getProfile(tenantId)]);
  const plan = (profile?.plan as "free" | "pro" | "enterprise") || "free";
  const limit = CLIENT_PROJECT_LIMITS[plan];

  return NextResponse.json({
    projects,
    limit: Number.isFinite(limit) ? limit : null,
    plan,
  });
}

export async function POST(req: NextRequest) {
  if (isDemoMode()) {
    return demoModeUnavailable("Creating client projects");
  }

  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { tenantId, role } = await getTeamContext(userId);
  if (!isTeamManager(role)) {
    return NextResponse.json({ error: "Only a team owner or admin can create client projects" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "Missing name" }, { status: 400 });
  }

  const profile = await getProfile(tenantId);
  const plan = (profile?.plan as "free" | "pro" | "enterprise") || "free";
  const limit = CLIENT_PROJECT_LIMITS[plan];

  const currentCount = await countActiveClientProjects(tenantId);
  if (currentCount >= limit) {
    return NextResponse.json(
      {
        error: `Your ${plan} plan allows up to ${Number.isFinite(limit) ? limit : "unlimited"} client projects. Upgrade to add more.`,
        code: "PROJECT_LIMIT_REACHED",
      },
      { status: 402 }
    );
  }

  const project = await createClientProject(tenantId, name);
  if (!project) {
    return NextResponse.json({ error: "Failed to create client project" }, { status: 500 });
  }

  return NextResponse.json({ project });
}
