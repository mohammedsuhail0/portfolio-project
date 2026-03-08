# Portfolio Project

This project now includes a secure Express backend for the contact form.

## Run Locally

1. Install dependencies:
   - `npm install`
2. Create env file:
   - `copy .env.example .env` (Windows)
3. Fill in `.env` values (Turnstile keys, SMTP, optional database).
4. Start server:
   - `npm run dev`
5. Open:
   - `http://localhost:3000` (or your configured `PORT`)

## Deploy To Vercel

1. Push this repo to GitHub.
2. In Vercel, click `Add New Project` and import the repo.
3. In Project Settings -> Environment Variables, add:
   - `DISABLE_TURNSTILE=true` (for first deploy/testing) OR set real Turnstile keys and `DISABLE_TURNSTILE=false`
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`
   - `CONTACT_TO_EMAIL`, `CONTACT_FROM_EMAIL`
4. Deploy.
5. Open your deployed URL and test the contact form.

Notes:
- This repo includes `vercel.json` + `api/index.js` so Express routes are served through Vercel Functions.
- Local file fallback storage is skipped on Vercel runtime; use SMTP and/or a real database (`DATABASE_URL`) for persistence.

## Security Controls Implemented

- Treat all external form inputs as untrusted.
- Input validation and constraints using `zod`.
- Honeypot anti-spam field.
- Cloudflare Turnstile server-side token verification.
- Endpoint rate limiting using `express-rate-limit`.
- Secure error handling: generic client messages, detailed server logs.
- Parameterized SQL insert (`$1, $2, ...`) when `DATABASE_URL` is set.
- Secrets loaded from environment variables (`.env` not committed).

## Optional Postgres Table

Run the SQL in:
- `db/contact_messages.sql`
