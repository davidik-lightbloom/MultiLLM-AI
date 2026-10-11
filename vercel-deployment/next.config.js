// NEXT_PUBLIC_CONTACT_EMAIL backs every billing/pricing mailto CTA and the
// footer -- there is no payment processor, so this address is the entire
// upgrade/downgrade/cancellation/support path. Shipping a real production
// deploy without it set (previously silently falling back to
// "sales@example.com") means those links go nowhere real. Only a genuine
// Vercel production build is blocked here -- CI, local dev, and preview
// deploys don't set VERCEL_ENV=production, so they're unaffected.
if (process.env.VERCEL_ENV === "production" && !process.env.NEXT_PUBLIC_CONTACT_EMAIL) {
  throw new Error(
    "NEXT_PUBLIC_CONTACT_EMAIL must be set for a production build -- it's the only contact path for billing (no payment processor). Set it in the Vercel project's production environment variables."
  );
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Turbopack (default since Next 16) walks up for the nearest lockfile to
  // infer the workspace root, and picks up an unrelated package-lock.json
  // higher up this machine's directory tree outside the git repo -- pin it
  // explicitly instead.
  turbopack: {
    root: __dirname,
  },
  // /terms, /privacy, and /dpa read their content from legal/*.md via a
  // parameterized fs.readFileSync call, which Next's build-time file tracer
  // can't always detect through static analysis alone -- force-include the
  // directory so it isn't silently dropped from the deployed function.
  // (Next 16: this moved out of `experimental` to a top-level key.)
  outputFileTracingIncludes: {
    "/terms": ["./legal/**"],
    "/privacy": ["./legal/**"],
    "/dpa": ["./legal/**"],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
          },
        ],
      },
    ];
  },
};

// @sentry/nextjs v11 moved the build-time config helper to this subpath --
// it's no longer re-exported from the package root.
const { withSentryConfig } = require("@sentry/nextjs/config");

// org/project/authToken are read from SENTRY_ORG/SENTRY_PROJECT/
// SENTRY_AUTH_TOKEN env vars automatically (set by the Vercel Marketplace
// Sentry integration) -- no need to pass them here. Source map upload is a
// webpack-only feature of this plugin; under Turbopack (Next 16's default
// bundler) it no-ops, so errors still report without mapped stack traces
// until Sentry's Turbopack support lands -- see src/instrumentation.ts and
// src/instrumentation-client.ts for the actual error-capture wiring.
module.exports = withSentryConfig(nextConfig, {
  silent: !process.env.CI,
  widenClientFileUpload: true,
});
