import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  tryClaimLifecycleEmail: vi.fn(),
  releaseLifecycleEmailClaim: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock("@/lib/supabase/services", () => ({
  tryClaimLifecycleEmail: mocks.tryClaimLifecycleEmail,
  releaseLifecycleEmailClaim: mocks.releaseLifecycleEmailClaim,
}));
vi.mock("@/lib/email", () => ({
  sendEmail: mocks.sendEmail,
}));

import { sendWelcomeEmailOnce, maybeSendLowCreditsEmail, maybeSendPlanExpiringEmail } from "./lifecycleEmails";

const PROFILE = {
  id: "user-1",
  email: "user@example.com",
  name: "Ada",
  plan: "free" as const,
  credits: 5,
  credits_period_start: "2026-01-01T00:00:00Z",
  plan_expires_at: "2026-01-10T00:00:00Z",
};

describe("lifecycleEmails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendEmail.mockResolvedValue(undefined);
  });

  it("sends the welcome email once a claim succeeds", async () => {
    mocks.tryClaimLifecycleEmail.mockResolvedValue(true);
    await sendWelcomeEmailOnce(PROFILE);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(mocks.tryClaimLifecycleEmail).toHaveBeenCalledWith("user-1", "welcome", "once");
  });

  it("does not send the welcome email a second time (claim already taken)", async () => {
    mocks.tryClaimLifecycleEmail.mockResolvedValue(false);
    await sendWelcomeEmailOnce(PROFILE);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("sends the low-credits email once remaining credits drop below 10% of the plan allowance", async () => {
    mocks.tryClaimLifecycleEmail.mockResolvedValue(true);
    // free plan allowance is 100 -> 10% = 10
    await maybeSendLowCreditsEmail(PROFILE, 5);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("does not send the low-credits email while above the 10% threshold", async () => {
    await maybeSendLowCreditsEmail(PROFILE, 50);
    expect(mocks.tryClaimLifecycleEmail).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("does not resend the low-credits email once already claimed for this period", async () => {
    mocks.tryClaimLifecycleEmail.mockResolvedValue(false);
    await maybeSendLowCreditsEmail(PROFILE, 5);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("releases the claim when the send itself fails, so a later attempt can retry", async () => {
    mocks.tryClaimLifecycleEmail.mockResolvedValue(true);
    mocks.sendEmail.mockRejectedValue(new Error("RESEND_API_KEY and EMAIL_FROM must both be set to send email in production."));

    await expect(sendWelcomeEmailOnce(PROFILE)).rejects.toThrow();

    expect(mocks.releaseLifecycleEmailClaim).toHaveBeenCalledWith("user-1", "welcome", "once");
  });

  it("sends the plan-expiring email once", async () => {
    mocks.tryClaimLifecycleEmail.mockResolvedValue(true);
    await maybeSendPlanExpiringEmail(PROFILE);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(mocks.tryClaimLifecycleEmail).toHaveBeenCalledWith("user-1", "plan_expiring", PROFILE.plan_expires_at);
  });

  it("does not send a plan-expiring email for an account with no expiry", async () => {
    await maybeSendPlanExpiringEmail({ ...PROFILE, plan_expires_at: null });
    expect(mocks.tryClaimLifecycleEmail).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });
});
