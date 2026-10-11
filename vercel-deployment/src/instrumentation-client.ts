// Client-side Sentry init -- see src/instrumentation.ts for the
// server/edge side. This file's name/location is load-bearing: Turbopack
// (Next 16's default bundler) only picks up src/instrumentation-client.ts,
// not the older sentry.client.config.ts convention.
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  // Errors only for now, no performance tracing -- this is a small,
  // cost-conscious deployment on Sentry's free tier, and the goal is "page
  // someone on a real failure," not full APM. Raise this if/when traces
  // become worth the quota.
  tracesSampleRate: 0,
  // Silence Sentry's own console noise in production; still logs locally
  // since NODE_ENV isn't "production" in dev.
  debug: false,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
