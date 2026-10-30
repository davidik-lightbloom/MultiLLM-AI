#!/usr/bin/env node
// Admin-only CLI for provisioning agency pilot accounts from cold-outreach.
// Same model as demo-account.mjs (profiles.credits + profiles.plan_expires_at
// cap access), but passwordless: no password is set on the auth user, and
// instead of printing credentials this prints a Supabase magic-link
// (admin.generateLink, type "magiclink") that signs the recipient straight
// into the dashboard on click. Nothing is emailed by this script or by
// Supabase -- the link is meant to be pasted into the outreach email you
// send yourself.
//
//   node --env-file=.env.local scripts/pilot-account.mjs create \
//     --email info@arteries.hu --agency "Arteries Studio" --days 14 --tier pro
//
// Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the
// environment (already present in this repo's .env.local).

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SITE_URL = process.env.PILOT_SITE_URL || "https://multillm.link";

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.\n" +
      "Run `vercel env pull .env.local` first, then re-run this with:\n" +
      "  node --env-file=.env.local scripts/pilot-account.mjs ...",
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const VALID_TIERS = ["free", "pro", "enterprise"];

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.replace(/^--/, "");
    opts[key] = rest[i + 1];
  }
  return { command, opts };
}

async function findUserByEmail(email) {
  let page = 1;
  for (;;) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const found = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (found) return found;
    if (data.users.length < 200) return null;
    page += 1;
  }
}

async function create(opts) {
  const email = opts.email;
  const agency = opts.agency;
  if (!email || !agency) {
    console.error('Usage: create --email <email> --agency "<name>" [--contact "<name>"] [--days 14] [--credits 200] [--tier pro]');
    process.exit(1);
  }
  const contact = opts.contact || "";
  const days = Number(opts.days ?? 14);
  const credits = Number(opts.credits ?? 200);
  const tier = VALID_TIERS.includes(opts.tier) ? opts.tier : "pro";

  let userId;
  const existing = await findUserByEmail(email);
  if (existing) {
    userId = existing.id;
    console.error(`Note: ${email} already exists (id ${userId}) -- updating its profile and issuing a fresh link instead of creating a new user.`);
  } else {
    const { data: created, error: createErr } = await supabase.auth.admin.createUser({
      email,
      email_confirm: true, // passwordless: skip confirmation, sign-in only via the magic link below
      user_metadata: { name: contact || agency, agency },
    });
    if (createErr || !created.user) {
      console.error("Failed to create auth user:", createErr?.message);
      process.exit(1);
    }
    userId = created.user.id;
  }

  const planExpiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  const { error: profileErr } = await supabase
    .from("profiles")
    .update({ plan: tier, credits, plan_expires_at: planExpiresAt, is_active: true, name: contact || agency })
    .eq("id", userId);
  if (profileErr) {
    console.error("Failed to set up profile (auth user was still created -- clean it up manually if needed):", profileErr.message);
    process.exit(1);
  }

  const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: { redirectTo: `${SITE_URL}/dashboard` },
  });
  if (linkErr || !linkData) {
    console.error("Profile set up, but failed to generate the sign-in link:", linkErr?.message);
    process.exit(1);
  }

  // Not linkData.properties.action_link: that points straight at Supabase's
  // hosted verify endpoint, which uses the implicit flow (#access_token=...)
  // -- this app's PKCE-only browser client never picks that up, so the
  // recipient lands on a plain, signed-out /login page. Route through our
  // own /auth/confirm instead (see its handler for why).
  const signInLink = `${SITE_URL}/auth/confirm?token_hash=${linkData.properties.hashed_token}&type=magiclink&next=/dashboard`;

  console.log(`
Pilot account ready: ${agency} <${email}>

  Sign-in link (single click, no password -- paste into the outreach email):
    ${signInLink}

  Plan: ${tier}, ${credits} credits, expires ${planExpiresAt}

The link is single-use and time-limited by Supabase's OTP expiry setting; if
it goes stale before they click it, re-run this same command to mint a new
one (it reuses the existing account). To end access early:
  node --env-file=.env.local scripts/pilot-account.mjs revoke --email ${email}
`);
}

async function revoke(opts) {
  const email = opts.email;
  if (!email) {
    console.error("Usage: revoke --email <email>");
    process.exit(1);
  }
  const user = await findUserByEmail(email);
  if (!user) {
    console.error(`No user found with email ${email}.`);
    process.exit(1);
  }

  const { error: profileErr } = await supabase.from("profiles").update({ is_active: false }).eq("id", user.id);
  if (profileErr) {
    console.error("Failed to deactivate profile:", profileErr.message);
    process.exit(1);
  }

  console.log(`Revoked pilot access for ${email}.`);
}

const { command, opts } = parseArgs(process.argv.slice(2));
if (command === "create") await create(opts);
else if (command === "revoke") await revoke(opts);
else {
  console.error(
    'Usage:\n  pilot-account.mjs create --email <email> --agency "<name>" [--contact "<name>"] [--days 14] [--credits 200] [--tier pro]\n  pilot-account.mjs revoke --email <email>',
  );
  process.exit(1);
}
