// Server/edge Sentry init, following Next.js's instrumentation hook
// (https://nextjs.org/docs/app/guides/instrumentation). Runs once per
// runtime at boot, which is why the DSN config lives inline here rather
// than in separate sentry.server.config.ts/sentry.edge.config.ts files.
import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" || process.env.NEXT_RUNTIME === "edge") {
    Sentry.init({
      dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
      tracesSampleRate: 0,
      debug: false,
    });
  }
}

// Catches errors Next.js surfaces outside a route handler's own try/catch --
// e.g. a thrown error during Server Component rendering -- that would
// otherwise reach the user as a generic error page with nothing reported.
export const onRequestError = Sentry.captureRequestError;
