# RZ Fetch API Documentation

## Overview
This is a stream fetching server that aggregates channels from multiple sources (MeowZone, Nvision BD, BDIX) and provides subscription-based access control with caching capabilities.

---

## Environment Variables

Configure these in your `.env` file:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Server port |
| `PLAYLIST_URL` | MeowZone URL | Primary playlist source URL (JSON) |
| `NVSIONBD_M3U` | - | Nvision BD M3U playlist URL |
| `BDIX_M3U` | - | BDIX channels JSON URL |
| `SUBSCRIPTION_URL_TEMPLATE` | bdstream.site | Template for subscription API: `{id}` is replaced with subscriber ID |
| `EXPIRED_VIDEO_URL` | bdstream.site expired | Video URL served to inactive subscribers |
| `PROXY_SEGMENTS` | false | Enable segment proxying (true/false) |
| `CACHE_TTL_SECONDS` | 60 | Cache expiration time in seconds |
| `PROXY_FALLBACK_MODE` | wrapper | Fallback mode: 'redirect' or 'wrapper' |

---

## API Endpoints

### 1. MeowZone/RoarZone Endpoint

#### `GET /rz/ch_no/:chnum`

Fetches streams from the MeowZone playlist by channel number.

**Parameters:**
- `chnum` (path) - Channel number (numeric)
- `m3u` (query, optional) - Set to `1` or `true` to fetch M3U format
- `subscriber` (query, optional) - Subscriber ID for subscription validation (required with `m3u=1`)

**Response:**
- Redirects to the stream URL
- If `m3u=1` with invalid/no subscriber: redirects to expired video URL
- Returns 404 if channel not found
- Returns 400 if channel number is invalid

**Examples:**

```bash
# Direct redirect (no subscription check)
GET /rz/ch_no/1

# M3U format without subscriber
GET /rz/ch_no/1?m3u=1

# M3U format with subscription check
GET /rz/ch_no/1?m3u=1&subscriber=user123
```

**Success Response:**
- HTTP 302 redirect to stream URL

**Error Response:**
```json
{
  "error": "channel not found"
}
```

---

### 2. Nvision BD Endpoint

#### `GET /nvision/:xuiId`

Fetches streams from the Nvision BD M3U playlist.

**Parameters:**
- `xuiId` (path) - XUI ID from the playlist (required)
- `subscriber` (query) - Subscriber ID (required)

**Response:**
- Redirects to the stream URL if subscriber is active
- Redirects to expired video URL if subscriber is inactive
- Returns 400 if required parameters are missing
- Returns 404 if XUI ID not found in playlist

**Important:** This endpoint **ALWAYS requires both `xuiId` and `subscriber`** parameters.

**Examples:**

```bash
# Fetch stream with subscription check
GET /nvision/ch123?subscriber=user456
```

**Success Response:**
- HTTP 302 redirect to stream URL

**Error Response:**
```json
{
  "error": "subscriber required"
}
```

```json
{
  "error": "m3u=1 required"
}
```

---

### 3. BDIX Endpoint

#### `GET /bdix/:number`

Fetches streams from the BDIX channels JSON source.

**Parameters:**
- `number` (path) - Channel number from BDIX playlist (numeric, required)
- `subscriber` (query) - Subscriber ID (required)

**Response:**
- Redirects to the m3u8_url if subscriber is active
- Redirects to expired video URL if subscriber is inactive
- Returns 400 if subscriber is missing or channel number is invalid
- Returns 404 if channel not found

**Important:** This endpoint **ALWAYS requires the `subscriber` parameter**. All requests are subject to subscription validation.

**Examples:**

```bash
# Fetch BDIX channel with subscription check
GET /bdix/1?subscriber=user789

# Channel 10 (AXN HD)
GET /bdix/10?subscriber=user789

# Channel 11 (BAL BHARAT)
GET /bdix/11?subscriber=user789
```

**Success Response:**
- HTTP 302 redirect to stream URL (e.g., m3u8_url)

**Error Response:**
```json
{
  "error": "subscriber required"
}
```

```json
{
  "error": "channel not found"
}
```

---

### 4. Direct URL Endpoint

#### `GET /all/direct` (query)

Generic endpoint for direct URL streaming with optional subscription validation. Target URL is passed via query parameter (`u` or `url`) so no manual encoding is needed.

**Parameters:**
- `u` or `url` (query, required) - Target stream URL (server will decode)
- `m3u` (query, optional) - Set to `1` or `true` to enforce subscription check
- `subscriber` (query, optional) - Subscriber ID (required if `m3u=1`)

**Response:**
- Redirects to the target URL
- If `m3u=1` with valid subscriber: redirects to target
- If `m3u=1` without subscriber: returns 400 error
- If `m3u=1` with invalid subscriber: redirects to expired video URL

**Examples:**

```bash
# Direct redirect (no subscription check)
GET /all/direct?u=https://example.com/stream.m3u8

# With subscription check
GET /all/direct?u=https://example.com/stream.m3u8&m3u=1&subscriber=user123
```

---

### 5. Health Check Endpoint

#### `GET /_health`

Simple health check endpoint.

**Response:**
```json
{
  "status": "ok"
}
```

---

### 6. Manual Playlist Refresh

#### `POST /_refresh-playlist`

Manually trigger a playlist refresh (clears cache and fetches fresh data).

**Response:**
```json
{
  "ok": true
}
```

**Error Response:**
```json
{
  "ok": false,
  "error": "error message"
}
```

---

### 7. Segment Proxy Endpoint

#### `GET /_segment`

Used internally when `PROXY_SEGMENTS=true`. Proxies media segments and forwards Range headers.

**Parameters:**
- `u` (query) - URL-encoded upstream segment URL (required)

**Features:**
- Supports HTTP Range requests
- Sets CORS headers for browser playback
- Forwards User-Agent and Referer headers

**Example:**

```bash
GET /_segment?u=http%3A%2F%2Fcdn.example.com%2Fsegment.ts
```

---

### 8. M3U Proxy Endpoint

#### `GET /_m3u`

Used internally when `PROXY_SEGMENTS=true`. Proxies nested M3U8 playlists and rewrites relative URIs to absolute.

**Parameters:**
- `u` (query) - URL-encoded source M3U8 URL (required)

**Features:**
- Rewrites relative URIs to absolute URLs
- Recursively proxies nested playlists
- Wraps MP4 files in simple M3U8 format
- Fallback modes: 'redirect' or 'wrapper'

**Example:**

```bash
GET /_m3u?u=http%3A%2F%2Fcdn.example.com%2Fplaylist.m3u8
```

---

## Subscription Validation

### How It Works

1. Subscriber ID is validated against `SUBSCRIPTION_URL_TEMPLATE`
2. The endpoint replaces `{id}` with the subscriber ID
3. Expects one of these success indicators:
   - JSON response with `active: true`
   - JSON response with `status: "active"`
   - JSON response with `is_active: true`
   - JSON response with `code: 200`
   - JSON response with `subscribed: true` or `is_subscribed: true`
   - Boolean `true` as response
   - Plain text containing "active", "true", or "1"

### Example Subscription Check

```bash
# If subscriber is "user123" and template is:
# https://backend.bdstream.site/api/smarttv/subscription-status/{id}

# The server will call:
# https://backend.bdstream.site/api/smarttv/subscription-status/user123
```

---

## Caching

- **Nvision M3U**: Cached for `CACHE_TTL_SECONDS` (default: 60s)
- **BDIX Channels**: Cached for `CACHE_TTL_SECONDS` (default: 60s)
- **MeowZone Playlist**: Cached for `CACHE_TTL_SECONDS` (default: 60s)
- Cache is automatically refreshed after TTL expires
- Manual refresh available via `POST /_refresh-playlist`

---

## Error Handling

### Common Errors

| Status | Error | Cause |
|--------|-------|-------|
| 400 | `invalid channel number` | Non-numeric channel parameter |
| 400 | `subscriber required` | Missing subscriber parameter |
| 400 | `missing target url` | Missing URL in direct endpoint |
| 404 | `channel not found` | Channel/XUI ID doesn't exist in source |
| 500 | `internal server error` | Fetch failure or parsing error |
| 502 | `Bad gateway` | Upstream source unavailable |

---

## Source Information

### MeowZone
- **URL Type**: JSON
- **Default URL**: https://raw.githubusercontent.com/devmujahidul/MeowZone/refs/heads/main/playlist.json
- **Channel Property**: `channel_number`
- **Stream Property**: `url`

### Nvision BD
- **URL Type**: M3U/Text
- **Identifier**: `xui-id` attribute in M3U entries
- **Stream**: Next non-comment line after xui-id

### BDIX
- **URL Type**: JSON
- **Default URL**: https://raw.githubusercontent.com/devmujahidul/bdix_sc/refs/heads/main/channels.json
- **Channel Property**: `number`
- **Stream Property**: `m3u8_url`
- **Additional Fields**: `name`, `stream_id`, `logo`

---

## Usage Examples

### Python
```python
import requests

# BDIX endpoint
response = requests.get('http://localhost:3000/bdix/1', params={'subscriber': 'user123'})
stream_url = response.headers['Location']
print(f"Stream URL: {stream_url}")

# Health check
health = requests.get('http://localhost:3000/_health')
print(health.json())
```

### cURL
```bash
# Check health
curl http://localhost:3000/_health

# Get BDIX channel stream
curl -L http://localhost:3000/bdix/1?subscriber=user123

# Get Nvision stream
curl -L http://localhost:3000/nvision/ch123?subscriber=user123

# Get RoarZone stream
curl -L http://localhost:3000/rz/ch_no/1?subscriber=user123
```

### JavaScript
```javascript
// Fetch stream URL
async function getStream(source, identifier, subscriber) {
  let endpoint;
  
  if (source === 'bdix') {
    endpoint = `/bdix/${identifier}?subscriber=${subscriber}`;
  } else if (source === 'nvision') {
    endpoint = `/nvision/${identifier}?subscriber=${subscriber}`;
  } else if (source === 'rz') {
    endpoint = `/rz/ch_no/${identifier}?m3u=1&subscriber=${subscriber}`;
  }
  
  const response = await fetch(endpoint, { redirect: 'manual' });
  return response.headers.get('location');
}

// Usage
const streamUrl = await getStream('bdix', 1, 'user123');
console.log('Stream URL:', streamUrl);
```

---

## Notes

- All subscription-required endpoints redirect to `EXPIRED_VIDEO_URL` for inactive subscribers
- Segment and M3U proxying is optional (enable with `PROXY_SEGMENTS=true`)
- Cache is stored in memory and cleared on server restart
- Timeouts are set to 8-20 seconds for external requests
- CORS headers are set to allow browser playback

