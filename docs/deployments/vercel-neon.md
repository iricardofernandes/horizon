# Phase 11 public profile — Vercel + Neon

The public profile is deliberately smaller than the local architecture. It deploys the
same Next.js UI and BFF to Vercel, with a minimal session-and-Catalog backend in Vercel
Functions and seeded data in Neon Postgres.

It does **not** claim to run Kong, RabbitMQ, Redis, the five NestJS processes, delivery
workers, or the local observability stack. The complete order choreography remains the
locally reproducible `make demo` / `make test-phase10` path. Keeping that distinction
visible is part of the deployment contract.

## Why this profile

- Vercel Hobby hosts the Next.js app and route handlers without a recurring fee for a
  personal portfolio deployment.
- Neon Free supplies a serverless Postgres connection without a payment method.
- Fly.io has only a short free trial, not a continuing free tier. Railway Free currently
  includes US$1 of monthly compute, which is too small for Horizon's multi-process stack.

## One-time provisioning

1. Create a Neon project and copy its pooled `DATABASE_URL`.
2. Seed the isolated public-demo tables from a trusted terminal:

   ```bash
   cd web
   DATABASE_URL='postgresql://…' npm run seed:hosted
   ```

3. Import `iricardofernandes/horizon` in Vercel, select `web` as the project root, and
   keep the detected Next.js framework settings.
4. Add these Production and Preview variables in Vercel. Values marked secret must be
   entered in the platform and must never be committed:

   | Variable | Value |
   |---|---|
   | `HORIZON_HOSTED_DEMO` | `true` |
   | `NEXT_PUBLIC_HORIZON_HOSTED_DEMO` | `true` |
   | `DATABASE_URL` | Neon pooled connection string (secret) |
   | `HORIZON_SESSION_SECRET` | At least 32 random characters (secret) |

   Generate the session secret with `openssl rand -base64 48`. Do not configure the
   browser OTLP endpoint unless a public TLS Collector with an explicit origin allowlist
   exists; telemetry disables itself outside localhost when no endpoint is configured.

5. Deploy and verify `/login`, then sign in with:

   - workspace: `horizon-demo`
   - email: `demo@horizon.local`
   - password: `Horizon-demo-2026!`

The hosted banner and reduced navigation make the partial topology explicit. A successful
login followed by the Catalog view proves a real browser → Vercel Function → Neon request
path over seeded data.

## CLI equivalent

After the Vercel and Neon accounts are linked, the final deployment can be issued from
`web/` with `npx vercel --prod`. The resulting production URL must be written into the
root README before Phase 11 is marked complete.
