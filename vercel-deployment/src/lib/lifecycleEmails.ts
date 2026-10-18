import { sendEmail } from "@/lib/email";
import { welcomeEmail, lowCreditsEmail, planExpiringEmail } from "@/lib/emailTemplates";
import { tryClaimLifecycleEmail, releaseLifecycleEmailClaim } from "@/lib/supabase/services";
import { PLAN_CREDIT_ALLOWANCES, type PlanId } from "@/lib/credits";

// Claims the slot, then sends -- if the send itself throws (missing Resend
// config, Resend outage, etc.), releases the claim so a later attempt isn't
// permanently blocked by a send that never actually happened. Rethrows so
// each call site's existing catch/log behavior is unchanged.
async function sendClaimedEmail(
  userId: string,
  emailType: string,
  periodKey: string,
  build: () => { subject: string; text: string },
  to: string
): Promise<void> {
  const claimed = await tryClaimLifecycleEmail(userId, emailType, periodKey);
  if (!claimed) return;
  try {
    const { subject, text } = build();
    await sendEmail({ to, subject, text });
  } catch (err) {
    await releaseLifecycleEmailClaim(userId, emailType, periodKey);
    throw err;
  }
}

interface ProfileLike {
  id: string;
  email: string;
  name: string | null;
  plan: PlanId;
  credits: number;
  credits_period_start: string;
  plan_expires_at: string | null;
}

// Low-credits threshold: below 10% of the plan's monthly allowance.
const LOW_CREDITS_RATIO = 0.1;

export async function sendWelcomeEmailOnce(profile: ProfileLike): Promise<void> {
  await sendClaimedEmail(profile.id, "welcome", "once", () => welcomeEmail({ name: profile.name }), profile.email);
}

/**
 * Call after a credit consumption succeeds -- no-ops unless the remaining
 * balance just dropped below 10% of the plan's allowance. Scoped to the
 * current credits_period_start so it can fire again next period rather than
 * being a one-time-ever email.
 */
export async function maybeSendLowCreditsEmail(profile: ProfileLike, remainingCredits: number): Promise<void> {
  const allowance = PLAN_CREDIT_ALLOWANCES[profile.plan] ?? PLAN_CREDIT_ALLOWANCES.free;
  if (remainingCredits >= allowance * LOW_CREDITS_RATIO) return;

  await sendClaimedEmail(
    profile.id,
    "low_credits",
    profile.credits_period_start,
    () => lowCreditsEmail({ name: profile.name, creditsRemaining: remainingCredits, plan: profile.plan }),
    profile.email
  );
}

export async function maybeSendPlanExpiringEmail(profile: ProfileLike): Promise<void> {
  if (!profile.plan_expires_at) return;

  await sendClaimedEmail(
    profile.id,
    "plan_expiring",
    profile.plan_expires_at,
    () => planExpiringEmail({ name: profile.name, planExpiresAt: profile.plan_expires_at as string }),
    profile.email
  );
}
