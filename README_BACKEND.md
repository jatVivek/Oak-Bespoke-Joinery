# Oak & Mortise — Backend API

A lightweight Node.js + Express + SQLite backend for the Oak & Mortise Bespoke Joinery website.

---

## Stack

| Layer        | Library             |
|--------------|---------------------|
| HTTP server  | Express 4           |
| Database     | SQLite via better-sqlite3 |
| Auth         | JWT (jsonwebtoken)  |
| PIN hashing  | bcryptjs            |
| Security     | helmet, express-rate-limit, cors |
| Config       | dotenv              |

---

## Quick Start

### 1. Install dependencies

```bash
cd /path/to/Oak&MortiseBespokeJoinery
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env — set JWT_SECRET and OWNER_PIN_HASH at minimum
```

### 3. Run the server

```bash
node server.js
# → [Oak & Mortise API] Listening on http://localhost:3001
```

For development with auto-restart (Node ≥ 18):

```bash
npm run dev
```

---

## Environment Variables

| Variable        | Required | Description                                              |
|-----------------|----------|----------------------------------------------------------|
| `PORT`          | No       | Port to listen on (default: `3001`)                     |
| `JWT_SECRET`    | **Yes**  | Long random string used to sign JWTs                    |
| `OWNER_PIN_HASH`| **Yes**  | bcrypt hash of the owner login PIN                      |
| `CORS_ORIGIN`   | No       | Comma-separated allowed origins (default: `http://localhost:3000`) |

### Generating JWT_SECRET

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

### Generating a new PIN hash

```bash
node -e "require('bcryptjs').hash('YOUR_PIN', 12).then(console.log)"
```

The default `.env.example` ships with the hash of `2468`. **Change it before going live.**

---

## API Reference

All endpoints are prefixed with `/api`. Protected endpoints require:

```
Authorization: Bearer <jwt-token>
```

Tokens are issued by `POST /api/auth/login` and expire after **8 hours**.

---

### Auth

#### `POST /api/auth/login`

Rate-limited: 10 requests / 15 min / IP.

**Request body**
```json
{ "pin": "2468" }
```

**Response `200`**
```json
{ "token": "<jwt>" }
```

**Response `401`** — Incorrect PIN  
**Response `400`** — Invalid PIN format

---

### Enquiries

#### `GET /api/enquiries` 🔒

Returns all enquiries, newest first.

**Query params**

| Param    | Type   | Description                                     |
|----------|--------|-------------------------------------------------|
| `status` | string | Filter by status (`new`, `in-progress`, `quoted`, `closed`) |
| `limit`  | number | Max rows to return (default 200, max 500)       |
| `offset` | number | Pagination offset (default 0)                   |

**Response `200`**
```json
{
  "enquiries": [ { "id": "OM-5312", "name": "...", ... } ],
  "count": 1
}
```

---

#### `POST /api/enquiries`

Rate-limited: **5 requests / 15 min / IP**.  
Public — no auth required.

**Request body**

| Field      | Type   | Required | Notes                                              |
|------------|--------|----------|----------------------------------------------------|
| `name`     | string | ✅       | 2–120 chars                                        |
| `postcode` | string | ✅       | 3–10 chars, stored uppercased                      |
| `property` | string | ✅       | 2–200 chars                                        |
| `survey`   | string | ✅       | `yes` \| `no` \| `unsure`                          |
| `project`  | string | ✅       | `front-door` \| `back-door` \| `french-doors` \| `garage-door` \| `staircase` \| `stair-parts` \| `gate` \| `window` \| `other` |
| `width`    | string | ✅       | Opening width in mm (1–10000)                     |
| `finish`   | string | ✅       | `primed` \| `painted` \| `oiled` \| `waxed` \| `lacquered` \| `bare` \| `other` |
| `estimate` | string | No       | Pre-calculated estimate label (max 200 chars)      |
| `notes`    | string | No       | Free-text notes (max 2000 chars)                   |

**Response `201`**
```json
{ "enquiry": { "id": "OM-5312", "status": "new", "created_at": "2026-11-21T10:00:00Z", ... } }
```

---

#### `PATCH /api/enquiries/:id/status` 🔒

**Request body**
```json
{ "status": "in-progress" }
```
Valid values: `new`, `in-progress`, `quoted`, `closed`

**Response `200`** — returns updated enquiry object  
**Response `404`** — enquiry not found

---

#### `DELETE /api/enquiries/:id` 🔒

**Response `200`**
```json
{ "message": "Enquiry OM-5312 deleted" }
```

---

### Brand Config

#### `GET /api/brand`

Returns the current brand configuration as a JSON object. Public.

**Response `200`**
```json
{ "brand": { "companyName": "Oak & Mortise", "phone": "...", ... } }
```

---

#### `PUT /api/brand` 🔒

Replaces the entire brand configuration. Send any JSON object (max 64 KB).

**Response `200`** — returns the saved brand object

---

### Health

#### `GET /api/health`

```json
{ "status": "ok", "timestamp": "2026-11-21T10:00:00.000Z" }
```

---

## SQLite Schema

```sql
CREATE TABLE enquiries (
  id          TEXT PRIMARY KEY,   -- e.g. "OM-1234"
  name        TEXT NOT NULL,
  postcode    TEXT NOT NULL,
  property    TEXT NOT NULL,
  survey      TEXT NOT NULL,
  project     TEXT NOT NULL,
  width       TEXT NOT NULL,
  finish      TEXT NOT NULL,
  estimate    TEXT,
  notes       TEXT,
  status      TEXT NOT NULL DEFAULT 'new',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE brand_config (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  config_json TEXT NOT NULL DEFAULT '{}'
);
```

The SQLite file lives in `data/oak_mortise.db` (gitignored).

---

## Deployment

### Railway / Render (recommended for quick deploys)

1. Push the repo to GitHub (make sure `data/` and `.env` are gitignored).
2. Create a new **Web Service** on Railway or Render pointing at your repo.
3. Set all required **environment variables** in the platform dashboard.
4. Set the **start command** to `node server.js`.
5. The SQLite database file will be written to the ephemeral disk — for production use a **persistent volume** (Railway: `/data` volume mount).

### VPS (e.g. DigitalOcean, Hetzner)

```bash
# On the server
git clone <repo> /srv/oak-mortise
cd /srv/oak-mortise
npm install --omit=dev
cp .env.example .env && nano .env   # fill in secrets

# Run with PM2
npm install -g pm2
pm2 start server.js --name oak-mortise
pm2 save
pm2 startup
```

Add a **Caddy** or **nginx** reverse proxy in front for HTTPS:

```
# Caddyfile example
api.oakandmortise.co.uk {
    reverse_proxy localhost:3001
}
```

---

## Security Notes

- JWTs expire after **8 hours** — the owner must re-login after that.
- The PIN is **never stored in plaintext** — only the bcrypt hash is used.
- Raw error messages are **never sent to clients** — always generic `500`.
- `helmet` sets sensible HTTP security headers automatically.
- Rate limiting protects the login and enquiry submission endpoints.
- Input is validated and sanitised on every write endpoint.
