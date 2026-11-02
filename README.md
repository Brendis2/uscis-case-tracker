# Caseway - USCIS Case Tracker

A small Next.js app for looking up USCIS case statuses, saving cases to a private account, refreshing them, recording status changes over time, and sharing a read-only case view with an attorney or other existing account.

## Run locally

1. Install Node.js 20+ and create a Supabase project.
2. In the Supabase SQL editor, run [`supabase/schema.sql`](supabase/schema.sql). If you already applied an earlier version, rerun the updated script to install the latest row-level policies, `updated_at` trigger, and atomic status-history function.
3. Copy `.env.example` to `.env.local`. Set the Supabase URL and publishable key. Add the USCIS sandbox client ID and secret from the USCIS Torch developer portal. The sandbox OAuth and API URLs are prefilled; production URLs are issued separately.
4. Install packages and start the app:

   ```sh
   npm install
   npm run dev
   ```

5. Open http://localhost:3000 and create an account. Supabase email confirmation may need to be enabled or adjusted in the Supabase Auth settings for local testing.

If the USCIS sandbox is unavailable, set `USCIS_DEMO_MODE=true` in `.env.local` and restart the dev server to walk through saving a clearly labeled simulated sample (`EAC9999103402`). Demo mode only runs in local development, only accepts that sample receipt, and never calls USCIS. Turn it off before using the real sandbox.

The API route uses the USCIS documented sandbox endpoints and response fields (`case_status`, `current_case_status_text_en`, and `current_case_status_desc_en`). Reconfirm the contract when the portal comes back online and if the API version changes. USCIS credentials stay server-side and are never prefixed with `NEXT_PUBLIC_`.

## Checks

Run the local unit tests, lint, and production build with:

```sh
npm test
npm run lint
npm run typecheck
npm run build
```

## Architecture and decisions

- **Next.js app router:** keeps the OAuth client credentials exchange on the server while serving a compact client UI.
- **Supabase Auth + Postgres:** accounts persist across sessions. Row-level security scopes case and history reads/writes to `auth.uid()`. The browser uses only the publishable key; there is no elevated service-role credential in the app.
- **Two-table case model:** `cases` stores the latest known snapshot and `status_events` is append-only history. Receipt numbers are unique per owner. A database function saves the snapshot and status event atomically; repeated checks of the same status update the checked time without creating duplicate events.
- **Revocable sharing:** `case_shares` grants a specific existing account read access to one case and its timeline. A database function resolves the invitee's email without exposing the account directory to the browser. The owner can revoke the grant; shared users cannot edit, refresh, or delete the case.
- **Insights readiness and consent:** users can opt in per case; consent is off by default and can be changed later. Aggregate analytics are not active yet. Any future analytics should exclude identifiers and descriptions and suppress small cohorts before sharing results outside the user's account.
- **Resilience:** receipt format is checked at the UI and server boundary. API failures, timeouts, missing configuration, unknown cases, and rate limits return readable errors. The integration does not cache results because the user-requested refresh should query USCIS.

## Beyond the minimum

The interface presents an event timeline, revocable read-only sharing with another registered account, and a per-case preference for future anonymous insights. Notifications, scheduled polling, and the aggregate insights service are not implemented yet. Status history is collected from the time the case is first tracked; historical events returned by USCIS need to be mapped after confirming their response schema with the portal's live documentation.

## AI tools

AI coding assistance was used to scaffold and implement the initial app, database schema, and setup notes. The USCIS portal credentials and current endpoint contract must be verified against the developer account before deployment.

## Next steps

1. Connect the USCIS sandbox and confirm token flow, endpoint path, and live response field names with the account's portal docs.
2. Add authorization tests for cross-account access, migration automation, and an end-to-end lookup with sandbox fixtures.
3. Add email invitations for attorneys who do not yet have an account, notification preferences, and opted-in, privacy-protected aggregate insights.
4. Add production rate limiting and deploy with managed secrets.
