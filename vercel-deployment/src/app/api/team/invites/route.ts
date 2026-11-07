import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUserId } from "@/lib/supabase/serverAuth";
import { getProfile } from "@/lib/supabase/services";
import { createInvite, countTeamSeatsUsed, getTeamContext, TEAM_SEAT_LIMITS } from "@/lib/supabase/team";
import { sendEmail } from "@/lib/email";
import { teamInviteEmail } from "@/lib/emailTemplates";
import { isDemoMode } from "@/lib/demoMode";
import { demoModeUnavailable } from "@/lib/demoModeApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: NextRequest) {
  if (isDemoMode()) {
    return demoModeUnavailable("Inviting team members");
  }

  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  const role = body?.role === "admin" ? "admin" : "member";

  if (!email || !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "Please provide a valid email address" }, { status: 400 });
  }

  // Only the owner manages the roster in V1 -- a member/admin has no team of
  // their own to invite into.
  const context = await getTeamContext(userId);
  if (context.role !== "owner") {
    return NextResponse.json({ error: "Only the team owner can send invites" }, { status: 403 });
  }

  const profile = await getProfile(userId);
  const plan = (profile?.plan as "free" | "pro" | "enterprise") || "free";
  const seatLimit = TEAM_SEAT_LIMITS[plan];
  const seatsUsed = await countTeamSeatsUsed(userId);
  if (seatsUsed >= seatLimit) {
    return NextResponse.json(
      {
        error: Number.isFinite(seatLimit)
          ? `Your ${plan} plan allows up to ${seatLimit} team seats (including you). Upgrade to invite more people.`
          : "Seat limit reached.",
        code: "SEAT_LIMIT_REACHED",
      },
      { status: 402 }
    );
  }

  const result = await createInvite(userId, email, role);
  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  const origin = req.nextUrl.origin;
  const inviteUrl = `${origin}/team/accept?token=${result.token}`;

  try {
    const { subject, text } = teamInviteEmail({ inviterName: profile?.name ?? null, role, inviteUrl });
    await sendEmail({ to: email, subject, text });
  } catch (err) {
    // Best-effort, same as the welcome/low-credits emails elsewhere -- the
    // invite row (and its link) already exists regardless of whether the
    // notification email actually sent.
    console.warn("Team invite email failed:", err);
  }

  return NextResponse.json({
    invite: {
      id: result.invite.id,
      invited_email: result.invite.invited_email,
      role: result.invite.role,
      expires_at: result.invite.expires_at,
      created_at: result.invite.created_at,
    },
    inviteUrl,
  });
}
