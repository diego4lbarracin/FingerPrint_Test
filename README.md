# Fingerprint Authentication (DigitalPersona U.are.U 4500)

Full-stack example using:

- Frontend: React + DigitalPersona JavaScript SDK (`@digitalpersona/devices`)
- Backend: Go + Gin + SourceAFIS (`github.com/jtejido/sourceafis`)
- Database: Supabase PostgreSQL

## What this app does

1. Create User

- Collects `name`, `lastname`, `email`
- Captures fingerprint sample from the U.are.U 4500 reader in `SampleFormat.PngImage`
- Converts PNG to SourceAFIS search template on the Go backend
- Stores only the serialized SourceAFIS template in Supabase

2. Authenticate User

- Captures a live fingerprint sample
- Converts probe PNG to SourceAFIS template on the Go backend
- Runs 1:N matching against all enrolled templates
- Uses threshold `40` on SourceAFIS score scale
- Returns authenticated user if best score exceeds threshold

## Important biometric note

This implementation now uses SourceAFIS for template extraction and matching in the backend.

## Prerequisites

- Node.js 20+
- Go 1.25+
- DigitalPersona local runtime/service installed (you said this is already installed)
- U.are.U 4500 reader connected
- Supabase project created

## WebSdk runtime file

The frontend loads DigitalPersona browser scripts from `frontend/public`.

Required files:

- `websdk.client.bundle.min.js`
- `dp.core.bundle.js`
- `dp.devices.bundle.js`

How to get them:

- `websdk.client.bundle.min.js`: from DigitalPersona client/SDK installation on Windows.
- `dp.core.bundle.js`: copy from `frontend/node_modules/@digitalpersona/core/dist/es5.bundles/index.umd.js`.
- `dp.devices.bundle.js`: copy from `frontend/node_modules/@digitalpersona/devices/dist/es5.bundles/index.umd.js`.

## Database setup (Supabase)

Run SQL from [supabase/schema.sql](supabase/schema.sql) in the Supabase SQL editor.

## Environment variables

### Backend

Copy `backend/.env.example` to `backend/.env` and set:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `FRONTEND_ORIGIN` (for local dev, default `http://localhost:5173,http://127.0.0.1:5173`)
- `MATCH_THRESHOLD` (default `40`)

### Frontend

Copy `frontend/.env.example` to `frontend/.env` and set:

- `VITE_API_BASE_URL` (default `http://localhost:4000`)

## Run locally

Terminal 1:

```bash
cd backend
go mod tidy
go run .
```

Terminal 2:

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`.

## API endpoints

- `HEAD /api/health`
- `GET /api/users`
- `POST /api/users/enroll`
- `POST /api/auth/fingerprint`

### Register payload

```json
{
  "name": "John",
  "lastname": "Doe",
  "email": "john@company.com",
  "fingerprintTemplate": "<base64 PNG>"
}
```

### Authenticate payload

```json
{
  "fingerprintTemplate": "<base64 PNG>"
}
```

## Supabase tables

The SQL in `supabase/schema.sql` creates:

- `users`: enrollment info and serialized SourceAFIS template (`fingerprint_template`)
- `auth_logs`: every fingerprint auth attempt with score and success flag

## Deployment notes

- Frontend is configured for GitHub Pages through `.github/workflows/deploy-frontend-pages.yml`.
- Set repository secret `VITE_API_BASE_URL` to your deployed backend URL before triggering the workflow.
- For project pages (`https://<owner>.github.io/<repo>/`), Vite base path is auto-resolved in CI from the repository name.
- A `404.html` SPA fallback is generated from `index.html` during deployment so deep links route to the React app.
- Backend should be deployed as a server (Render/Fly/Railway/etc.) with secure env vars.
- In backend env, set `FRONTEND_ORIGIN` to the hosted site origin, for example `https://<owner>.github.io`.
- Ensure `VITE_API_BASE_URL` uses HTTPS; GitHub Pages is HTTPS and mixed-content HTTP API calls may be blocked by the browser.
- The reader capture requires DigitalPersona local services on the machine that runs the browser.
  This means remote cloud users cannot directly access local hardware unless you provide an edge/desktop bridge architecture.
