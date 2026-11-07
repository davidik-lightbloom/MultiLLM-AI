import { NextRequest, NextResponse } from "next/server";
import { getPlatformApiKeyById, deletePlatformApiKey } from "@/lib/supabase/services";
import { getAuthenticatedUserId } from "@/lib/supabase/serverAuth";
import { getTeamContext, isTeamManager } from "@/lib/supabase/team";
import { isDemoMode } from "@/lib/demoMode";
import { demoModeUnavailable } from "@/lib/demoModeApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  if (isDemoMode()) {
    return demoModeUnavailable("Revoking platform API keys");
  }

  const params = await props.params;
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { tenantId, role } = await getTeamContext(userId);
  if (!isTeamManager(role)) {
    return NextResponse.json({ error: "Only a team owner or admin can revoke API keys" }, { status: 403 });
  }

  const existing = await getPlatformApiKeyById(params.id);
  if (!existing || existing.user_id !== tenantId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const ok = await deletePlatformApiKey(params.id);
  if (!ok) {
    return NextResponse.json({ error: "Failed to delete API key" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
