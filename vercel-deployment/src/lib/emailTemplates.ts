// Plain, short, text-first templates -- no HTML, no marketing styling. Each
// returns {subject, text} for src/lib/email.ts's sendEmail().

export function welcomeEmail(params: { name: string | null }): { subject: string; text: string } {
  const greeting = params.name ? `Hi ${params.name},` : "Hi,";
  const onboardingUrl = process.env.ONBOARDING_GUIDE_URL || "";
  return {
    subject: "Welcome to MultiLLM",
    text: [
      greeting,
      "",
      "Thanks for signing up for MultiLLM -- one prompt, run across multiple LLMs, with the best answer automatically selected.",
      onboardingUrl ? `Get started here: ${onboardingUrl}` : "",
      "",
      "If you have any questions, just reply to this email.",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

export function lowCreditsEmail(params: { name: string | null; creditsRemaining: number; plan: string }): {
  subject: string;
  text: string;
} {
  const greeting = params.name ? `Hi ${params.name},` : "Hi,";
  return {
    subject: "You're running low on MultiLLM credits",
    text: [
      greeting,
      "",
      `You have ${params.creditsRemaining} credits left on your ${params.plan} plan.`,
      "Upgrade your plan, or wait for your next monthly reset, to keep querying without interruption.",
      "",
      "Reply to this email if you'd like help choosing a plan.",
    ].join("\n"),
  };
}

export function teamInviteEmail(params: { inviterName: string | null; role: "admin" | "member"; inviteUrl: string }): {
  subject: string;
  text: string;
} {
  const inviter = params.inviterName || "Someone";
  return {
    subject: `${inviter} invited you to their MultiLLM team`,
    text: [
      `${inviter} has invited you to join their MultiLLM team as a${params.role === "admin" ? "n admin" : " member"}.`,
      "Accepting shares their plan, credits, and client projects -- sign in (or create a free account with this same email) and open the link below to join:",
      "",
      params.inviteUrl,
      "",
      "This link expires in 7 days. If you weren't expecting this, you can ignore this email.",
    ].join("\n"),
  };
}

export function planExpiringEmail(params: { name: string | null; planExpiresAt: string }): {
  subject: string;
  text: string;
} {
  const greeting = params.name ? `Hi ${params.name},` : "Hi,";
  const expiresDate = new Date(params.planExpiresAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  return {
    subject: "Your MultiLLM access expires in 3 days",
    text: [
      greeting,
      "",
      `Your MultiLLM plan expires on ${expiresDate}.`,
      "Reply to this email if you'd like to extend your access.",
    ].join("\n"),
  };
}
