import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUserId } from "@/lib/supabase/serverAuth";
import { updateProfile } from "@/lib/supabase/services";
import { getTeamContext } from "@/lib/supabase/team";
import { isDemoMode } from "@/lib/demoMode";
import { demoModeUnavailable } from "@/lib/demoModeApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// AI-behavior preferences (default_mode, enabled_skills, local_only_mode) are
// tenant-wide settings -- for a team member, they live on the team owner's
// profiles row, not the member's own, since they govern how every query
// under that tenant behaves by default. This route resolves the tenant
// server-side and allowlists exactly these three fields, rather than letting
// the client write straight to `profiles` (which a team member has no RLS
// grant to do anyway -- see schema.sql's "Users can view own profile" note).
const ALLOWED_FIELDS = ["default_mode", "enabled_skills", "local_only_mode"] as const;
type AllowedField = (typeof ALLOWED_FIELDS)[number];

function isDefaultMode(value: unknown): value is "fast" | "deep" {
  return value === "fast" || value === "deep";
}

export async function POST(req: NextRequest) {
  if (isDemoMode()) {
    return demoModeUnavailable("Saving preferences");
  }

  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const updates: Partial<Record<AllowedField, unknown>> = {};

  if ("default_mode" in body) {
    if (!isDefaultMode(body.default_mode)) {
      return NextResponse.json({ error: "default_mode must be 'fast' or 'deep'" }, { status: 400 });
    }
    updates.default_mode = body.default_mode;
  }
  if ("enabled_skills" in body) {
    if (!Array.isArray(body.enabled_skills) || !body.enabled_skills.every((s: unknown) => typeof s === "string")) {
      return NextResponse.json({ error: "enabled_skills must be an array of strings" }, { status: 400 });
    }
    updates.enabled_skills = body.enabled_skills;
  }
  if ("local_only_mode" in body) {
    if (typeof body.local_only_mode !== "boolean") {
      return NextResponse.json({ error: "local_only_mode must be a boolean" }, { status: 400 });
    }
    updates.local_only_mode = body.local_only_mode;
  }

  if (!Object.keys(updates).length) {
    return NextResponse.json({ error: "No recognized preference fields supplied" }, { status: 400 });
  }

  const context = await getTeamContext(userId);
  const profile = await updateProfile(context.tenantId, updates as any);
  if (!profile) {
    return NextResponse.json({ error: "Failed to save preferences" }, { status: 500 });
  }

  return NextResponse.json({ profile });
}
