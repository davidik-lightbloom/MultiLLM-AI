import { CONTACT_EMAIL } from "@/lib/contact";

// Replaces what used to be a sticky "Development environment -- not the live
// app" bar that was accidentally showing on real production (APP_ENV was
// never set there, and getAppEnv() defaults unset to "development" on
// purpose -- see lib/env.ts). This app genuinely is an early, manually-run
// product (placeholder pricing, no payment processor, plan changes go to a
// real person) so an honest "beta, talk to us" strip is more accurate than
// pretending otherwise, and it doubles as a contact CTA.
export default function BetaBanner() {
  return (
    <div className="sticky top-0 z-50 w-full bg-purple-600 text-white text-center text-xs font-semibold py-1.5 tracking-wide">
      MultiLLM is in open beta —{" "}
      <a href={`mailto:${CONTACT_EMAIL}`} className="underline underline-offset-2 hover:text-purple-100">
        questions or feedback? Contact us
      </a>
    </div>
  );
}
