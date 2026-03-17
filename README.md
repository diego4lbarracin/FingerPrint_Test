# Fingerprint Authentication (DigitalPersona U.are.U 4500)

Full-stack example using:

- Frontend: React + DigitalPersona JavaScript SDK (`@digitalpersona/devices`)
- Backend: Node.js + Express
- Database: Supabase PostgreSQL

## What this app does

1. Create User

- Collects `name`, `lastname`, `email`
- Captures fingerprint sample from the U.are.U 4500 reader
- Stores user and fingerprint template in Supabase

2. Authenticate User

- Captures a live fingerprint sample
- Compares against enrolled templates
- Returns authenticated user when score is above threshold

## Important biometric note

This demo uses a custom similarity strategy on captured sample payloads. It is useful for prototyping flow and storage, but it is **not equivalent** to a certified biometric matcher.

For production-grade biometric verification, use:

- DigitalPersona server-side authentication/enrollment services, or
- A dedicated biometric matching engine validated for your compliance requirements.

## Prerequisites

- Node.js 20+
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
- `FRONTEND_ORIGIN` (for local dev, default `http://localhost:5173`)
- `MATCH_THRESHOLD` (default `0.72`)

### Frontend

Copy `frontend/.env.example` to `frontend/.env` and set:

- `VITE_API_BASE_URL` (default `http://localhost:4000`)

## Run locally

Terminal 1:

```bash
cd backend
npm install
npm run dev
```

Terminal 2:

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`.

## API endpoints

- `GET /api/health`
- `POST /api/users/register`
- `POST /api/users/authenticate`

### Register payload

```json
{
  "name": "John",
  "lastName": "Doe",
  "email": "john@company.com",
  "fingerprint": {
    "deviceId": "reader-id",
    "sampleFormat": 2,
    "quality": 0,
    "capturedAt": "2026-03-17T00:00:00.000Z",
    "samples": [
      {
        "data": "base64url-sample",
        "header": {}
      }
    ]
  }
}
```

### Authenticate payload

```json
{
  "fingerprint": {
    "deviceId": "reader-id",
    "sampleFormat": 2,
    "quality": 0,
    "capturedAt": "2026-03-17T00:00:00.000Z",
    "samples": [
      {
        "data": "base64url-sample",
        "header": {}
      }
    ]
  }
}
```

## Deployment notes

- Frontend can be deployed to Vercel, Render static site, or GitHub Pages.
- Backend should be deployed as a server (Render/Fly/railway/etc.) with secure env vars.
- The reader capture requires DigitalPersona local services on the machine that runs the browser.
  This means remote cloud users cannot directly access local hardware unless you provide an edge/desktop bridge architecture.
