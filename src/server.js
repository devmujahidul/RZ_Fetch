const express = require('express');
const fetch = require('node-fetch');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config();

const PLAYLIST_URL = process.env.PLAYLIST_URL || 'https://raw.githubusercontent.com/devmujahidul/MeowZone/refs/heads/main/playlist.json';
const SUBSCRIPTION_URL_TEMPLATE = process.env.SUBSCRIPTION_URL_TEMPLATE || 'https://backend.bdstream.site/api/smarttv/subscription-status/{id}';
const EXPIRED_VIDEO_URL = process.env.EXPIRED_VIDEO_URL || 'http://bdstream.site/playback_video/fall.mp4';
const PORT = process.env.PORT || 3000;
// cache removed: always fetch fresh playlist
const PROXY_SEGMENTS = String(process.env.PROXY_SEGMENTS || '').toLowerCase() === 'true';
const NVSIONBD_M3U = process.env.NVSIONBD_M3U;
const BDIX_M3U = process.env.BDIX_M3U;
const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 60);

const app = express();

async function fetchPlaylist() {
  console.log(`[playlist] fetching playlist from ${PLAYLIST_URL}`);
  const res = await fetch(PLAYLIST_URL, { timeout: 10000 });
  if (!res.ok) {
    console.error(`[playlist] fetch failed: ${res.status} ${res.statusText}`);
    throw new Error(`Failed to fetch playlist: ${res.status}`);
  }
  const json = await res.json();
  console.log(`[playlist] fetched playlist with ${Array.isArray(json.channels) ? json.channels.length : 0} channels`);
  return json;
}

async function checkSubscription(subscriberId) {
  if (!subscriberId) return false;
  const url = SUBSCRIPTION_URL_TEMPLATE.replace('{id}', encodeURIComponent(subscriberId));
  try {
    console.log(`[subscription] checking subscriber=${subscriberId} -> ${url}`);
    const res = await fetch(url, { timeout: 8000 });
    console.log(`[subscription] received status ${res.status}`);
    if (!res.ok) {
      console.warn(`[subscription] non-OK response (${res.status}) for subscriber ${subscriberId}`);
      // Treat non-200 as not active
      return false;
    }
    const text = await res.text();
    const preview = String(text).slice(0, 1000).replace(/\s+/g, ' ');
    console.log(`[subscription] response preview: ${preview}${text.length > 1000 ? '...[truncated]' : ''}`);
    // Try to parse JSON, but if not JSON, use substring checks
    try {
      const json = JSON.parse(text);
      // Accept several possible shapes indicating active
      if (json === true) {
        console.log('[subscription] active (response boolean true)');
        return true;
      }
      if (json.active === true) {
        console.log('[subscription] active (json.active === true)');
        return true;
      }
      if (json.status && String(json.status).toLowerCase() === 'active') {
        console.log('[subscription] active (json.status === active)');
        return true;
      }
      if (json.is_active === true) {
        console.log('[subscription] active (json.is_active === true)');
        return true;
      }
      if (json.code && Number(json.code) === 200) {
        console.log('[subscription] active (json.code === 200)');
        return true;
      }
      if (json.subscribed === true || json.is_subscribed === true) {
        console.log('[subscription] active (subscribed flag)');
        return true;
      }
      console.log('[subscription] not active (no matching active fields in JSON)');
      return false;
    } catch (e) {
      // not JSON: simple text check
      const lower = text.toLowerCase();
      if (lower.includes('active') || lower.includes('true') || lower.includes('1')) {
        console.log('[subscription] active (text match)');
        return true;
      }
      console.log('[subscription] not active (text does not indicate active)');
      return false;
    }
  } catch (err) {
    console.warn('[subscription] check failed:', err.message || err);
    return false;
  }
}

let nvisionCache = { text: null, expiresAt: 0 };
async function fetchNvisionM3U() {
  if (!NVSIONBD_M3U) throw new Error('NVSIONBD_M3U env not set');
  const now = Date.now();
  if (nvisionCache.text && nvisionCache.expiresAt > now) return nvisionCache.text;
  console.log(`[nvision] fetching playlist from ${NVSIONBD_M3U}`);
  const res = await fetch(NVSIONBD_M3U, { timeout: 10000 });
  if (!res.ok) throw new Error(`Failed to fetch NVSIONBD_M3U: ${res.status}`);
  const text = await res.text();
  nvisionCache = { text, expiresAt: now + CACHE_TTL_SECONDS * 1000 };
  return text;
}

let bdixCache = { data: null, expiresAt: 0 };
async function fetchBdixChannels() {
  if (!BDIX_M3U) throw new Error('BDIX_M3U env not set');
  const now = Date.now();
  if (bdixCache.data && bdixCache.expiresAt > now) return bdixCache.data;
  console.log(`[bdix] fetching channels from ${BDIX_M3U}`);
  const res = await fetch(BDIX_M3U, { timeout: 10000 });
  if (!res.ok) throw new Error(`Failed to fetch BDIX_M3U: ${res.status}`);
  const data = await res.json();
  bdixCache = { data, expiresAt: now + CACHE_TTL_SECONDS * 1000 };
  return data;
}

function findBdixChannelByNumber(bdixData, number) {
  if (!bdixData || !Array.isArray(bdixData.channels)) return null;
  const numStr = String(number);
  return bdixData.channels.find(ch => String(ch.number) === numStr);
}

function findStreamByXuiId(m3uText, xuiId) {
  if (!m3uText || !xuiId) return null;
  const lines = String(m3uText).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = /xui-id="([^"]+)"/i.exec(line);
    if (match && match[1] === String(xuiId)) {
      // stream URL is expected on the next non-empty, non-comment line
      for (let j = i + 1; j < lines.length; j++) {
        const candidate = lines[j].trim();
        if (!candidate || candidate.startsWith('#')) continue;
        return candidate;
      }
    }
  }
  return null;
}

// (removed .m3u8 proxy routes per new requirements)

app.get('/rz/ch_no/:chnum', async (req, res) => {
  const chnum = Number(req.params.chnum);
  if (Number.isNaN(chnum)) return res.status(400).json({ error: 'invalid channel number' });

  console.log(`[request] incoming /rz/ch_no/${req.params.chnum} from ${req.ip} query=${JSON.stringify(req.query)}`);

  try {
    const playlist = await fetchPlaylist();
    const channels = Array.isArray(playlist.channels) ? playlist.channels : [];
    const channel = channels.find(c => Number(c.channel_number) === chnum);
    if (!channel) return res.status(404).json({ error: 'channel not found' });

    console.log(`[request] channel found #${chnum} -> name="${channel.name}" stream_path="${channel.stream_path || ''}" url="${channel.url}"`);

    const wantsM3U = req.query.m3u === '1' || req.query.m3u === 'true';
    if (wantsM3U) {
      const subscriber = req.query.subscriber;
      let target;
      if (subscriber) {
        const active = await checkSubscription(subscriber);
        target = active ? channel.url : EXPIRED_VIDEO_URL;
        console.log(`[request] m3u=1 subscriber=${subscriber} active=${active} -> redirect target: ${target}`);
      } else {
        target = channel.url;
        console.log(`[request] m3u=1 without subscriber -> redirect target: ${target}`);
      }
      // Requirement: do not rewrite; just redirect to stream URL (or expired video)
      return res.redirect(target);
    }

    // No m3u requested: do not check subscription, just redirect to the raw URL (suitable for backend players).
    console.log(`[request] no m3u param -> redirecting to channel url: ${channel.url}`);
    return res.redirect(channel.url);
  } catch (err) {
    console.error('[request] error processing request:', err.message || err);
    return res.status(500).json({ error: 'internal server error' });
  }
});

// (moved earlier)

/**
 * Proxy an M3U8 or wrap an MP4 in a simple M3U8 so HLS players can consume it.
 * Rewrites relative URIs in m3u8 to absolute URLs based on the source playlist URL.
 */
async function proxyM3U8(req, res, sourceUrl) {
  try {
    console.log(`[m3u-proxy] fetching source playlist/content: ${sourceUrl}`);
    // If the source look like an mp4 or not an m3u8, create a simple wrapper
    const lower = String(sourceUrl).toLowerCase();
    if (lower.endsWith('.mp4') || lower.indexOf('.mp4?') !== -1) {
      console.log('[m3u-proxy] source is mp4; returning wrapper m3u8');
      const m3u = ['#EXTM3U', '#EXTINF:-1,', sourceUrl].join('\n');
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      res.set('Access-Control-Allow-Origin', '*');
      return res.send(m3u);
    }

    // fetch the playlist content
    // Try primary fetch
    let upstream = await fetch(sourceUrl, { timeout: 10000 });
    let text = '';
    if (!upstream.ok) {
      console.warn(`[m3u-proxy] upstream returned ${upstream.status} ${upstream.statusText} - attempting retry with browser headers`);
      // attempt a retry with browser-like headers (some CDNs block unknown agents)
      try {
        upstream = await fetch(sourceUrl, {
          timeout: 10000,
          redirect: 'follow',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/vnd.apple.mpegurl, application/x-mpegURL, */*;q=0.9',
            'Referer': PLAYLIST_URL
          }
        });
      } catch (e) {
        console.warn('[m3u-proxy] retry fetch failed:', e.message || e);
      }
    }

    if (!upstream.ok) {
      // try to get a small preview of the body to aid debugging
      try { text = await upstream.text(); } catch (e) { text = ''; }
      const preview = String(text || '').slice(0, 1000).replace(/\s+/g, ' ');
      console.error(`[m3u-proxy] upstream not ok after retry: ${upstream.status} ${upstream.statusText} preview=${preview}${text.length > 1000 ? '...[truncated]' : ''}`);
      // fallback option: either redirect or return a small M3U8 wrapper so browsers can fetch upstream directly
      const fallbackMode = (process.env.PROXY_FALLBACK_MODE || 'wrapper').toLowerCase();
      if (fallbackMode === 'redirect') {
        console.warn('[m3u-proxy] falling back to redirect to source URL because PROXY_FALLBACK_MODE=redirect');
        res.set('Access-Control-Allow-Origin', '*');
        return res.redirect(sourceUrl);
      }
      if (fallbackMode === 'wrapper') {
        console.warn('[m3u-proxy] falling back to returning a small M3U8 wrapper pointing at source URL because PROXY_FALLBACK_MODE=wrapper');
        const wrapper = ['#EXTM3U', '#EXTINF:-1,', sourceUrl].join('\n');
        res.set('Content-Type', 'application/vnd.apple.mpegurl');
        res.set('Access-Control-Allow-Origin', '*');
        return res.send(wrapper);
      }
      return res.status(502).send('Bad gateway');
    }
    text = await upstream.text();
    const base = new URL(sourceUrl);
    // rewrite relative URIs to absolute
    const lines = text.split(/\r?\n/);
    const rewritten = lines.map(line => {
      const t = line.trim();
      if (!t || t.startsWith('#')) return line;
      let absolute;
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(t)) {
        absolute = t;
      } else {
        try {
          absolute = new URL(t, base).href;
        } catch (e) {
          return line;
        }
      }
      // If segment proxying is enabled, route media/segment URIs through our /_segment endpoint
      // and route nested playlists (m3u8) through /_m3u so they are rewritten as well.
      if (PROXY_SEGMENTS) {
        const isM3U8 = absolute.toLowerCase().includes('.m3u8');
        if (isM3U8) {
          return `/_m3u?u=${encodeURIComponent(absolute)}`;
        }
        return `/_segment?u=${encodeURIComponent(absolute)}`;
      }
      return absolute;
    }).join('\n');

    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.set('Access-Control-Allow-Origin', '*');
    console.log('[m3u-proxy] returning proxied playlist (rewritten).');
    return res.send(rewritten);
  } catch (err) {
    console.error('[m3u-proxy] error:', err.message || err);
    return res.status(500).send('internal error');
  }
}

// Direct m3u8 redirect endpoint with subscription check
app.get('/all/*/direct', async (req, res) => {
  const rawTarget = req.params[0];
  if (!rawTarget) return res.status(400).json({ error: 'missing target url' });

  let targetUrl;
  try {
    targetUrl = decodeURIComponent(rawTarget);
  } catch (e) {
    targetUrl = rawTarget;
  }

  const subscriber = req.query.subscriber;
  const wantsM3U = req.query.m3u === '1' || req.query.m3u === 'true';
  console.log(`[direct] request target="${targetUrl}" subscriber=${subscriber || 'none'} m3u=${req.query.m3u}`);

  if (wantsM3U) {
    if (!subscriber) return res.status(400).json({ error: 'missing subscriber' });
    const active = await checkSubscription(subscriber);
    const redirectUrl = active ? targetUrl : EXPIRED_VIDEO_URL;
    console.log(`[direct] m3u=1 subscriber=${subscriber} active=${active} -> redirect ${redirectUrl}`);
    return res.redirect(redirectUrl);
  }

  console.log('[direct] no m3u param -> redirecting to target without subscription check');
  return res.redirect(targetUrl);
});

app.get('/nvision/:xuiId', async (req, res) => {
  const xuiId = req.params.xuiId;
  const subscriber = req.query.subscriber;
  const wantsM3U = req.query.m3u === '1' || req.query.m3u === 'true';
  if (!wantsM3U) return res.status(400).json({ error: 'm3u=1 required' });
  if (!subscriber) return res.status(400).json({ error: 'subscriber required' });

  console.log(`[nvision] request xui-id=${xuiId} subscriber=${subscriber}`);

  const active = await checkSubscription(subscriber);
  if (!active) {
    console.log('[nvision] subscriber inactive -> redirecting to expired video');
    return res.redirect(EXPIRED_VIDEO_URL);
  }

  try {
    const m3uText = await fetchNvisionM3U();
    const streamUrl = findStreamByXuiId(m3uText, xuiId);
    if (!streamUrl) {
      console.warn(`[nvision] xui-id ${xuiId} not found in playlist`);
      return res.status(404).json({ error: 'channel not found' });
    }
    console.log(`[nvision] redirecting to stream ${streamUrl}`);
    return res.redirect(streamUrl);
  } catch (err) {
    console.error('[nvision] error handling request:', err.message || err);
    return res.status(500).json({ error: 'internal server error' });
  }
});

app.get('/bdix/:number', async (req, res) => {
  const chnum = Number(req.params.number);
  if (Number.isNaN(chnum)) return res.status(400).json({ error: 'invalid channel number' });

  const subscriber = req.query.subscriber;
  if (!subscriber) return res.status(400).json({ error: 'subscriber required' });

  console.log(`[bdix] request number=${req.params.number} subscriber=${subscriber} from ${req.ip}`);

  try {
    const active = await checkSubscription(subscriber);
    if (!active) {
      console.log('[bdix] subscriber inactive -> redirecting to expired video');
      return res.redirect(EXPIRED_VIDEO_URL);
    }

    const bdixData = await fetchBdixChannels();
    const channel = findBdixChannelByNumber(bdixData, chnum);
    if (!channel) {
      console.warn(`[bdix] channel #${chnum} not found`);
      return res.status(404).json({ error: 'channel not found' });
    }

    console.log(`[bdix] channel found #${chnum} -> name="${channel.name}" -> redirecting subscriber=${subscriber}`);
    return res.redirect(channel.m3u8_url);
  } catch (err) {
    console.error('[bdix] error handling request:', err.message || err);
    return res.status(500).json({ error: 'internal server error' });
  }
});

// Optional health and forced refresh endpoints
app.get('/_health', (req, res) => res.json({ status: 'ok' }));
app.post('/_refresh-playlist', async (req, res) => {
  try {
    console.log('[playlist] manual refresh requested');
    await fetchPlaylist();
    return res.json({ ok: true });
  } catch (err) {
    console.error('[playlist] manual refresh failed:', err.message || err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// Segment proxy endpoint used when PROXY_SEGMENTS=true. Streams an upstream resource
// and forwards Range header if provided. Sets CORS header to allow browser playback.
app.get('/_segment', async (req, res) => {
  const u = req.query.u;
  if (!u) return res.status(400).send('missing u');
  try {
    const upstreamUrl = decodeURIComponent(u);
    console.log(`[segment] proxying ${upstreamUrl} (range=${req.headers.range || 'none'})`);
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Referer': PLAYLIST_URL
    };
    if (req.headers.range) headers.Range = req.headers.range;

    const upstream = await fetch(upstreamUrl, { timeout: 20000, headers, redirect: 'follow' });
    if (!upstream.ok) {
      console.warn('[segment] upstream returned', upstream.status, upstream.statusText);
      // Try to return upstream body preview for debugging when small
      let preview = '';
      try { preview = (await upstream.text()).slice(0, 1000); } catch (e) { preview = ''; }
      res.set('Access-Control-Allow-Origin', '*');
      return res.status(upstream.status).send(preview || 'upstream error');
    }

    // Copy some headers
    res.set('Access-Control-Allow-Origin', '*');
    const contentType = upstream.headers.get('content-type');
    if (contentType) res.set('Content-Type', contentType);
    const contentRange = upstream.headers.get('content-range');
    if (contentRange) res.set('Content-Range', contentRange);
    const acceptRanges = upstream.headers.get('accept-ranges');
    if (acceptRanges) res.set('Accept-Ranges', acceptRanges);

    res.status(upstream.status);
    // stream
    const body = upstream.body;
    if (!body) return res.status(500).send('no body');
    body.pipe(res);
  } catch (err) {
    console.error('[segment] proxy error:', err.message || err);
    return res.status(500).send('internal error');
  }
});

// Endpoint to proxy nested m3u8 playlists so their internal URIs get rewritten as well.
app.get('/_m3u', async (req, res) => {
  const u = req.query.u;
  if (!u) return res.status(400).send('missing u');
  try {
    const sourceUrl = decodeURIComponent(u);
    // reuse proxyM3U8 logic which rewrites URIs and can recurse into segment proxying
    return proxyM3U8(req, res, sourceUrl);
  } catch (err) {
    console.error('[_m3u] error:', err.message || err);
    return res.status(500).send('internal error');
  }
});

app.listen(PORT, () => {
  console.log(`Fetcher backend listening on port ${PORT}`);
  console.log(`PLAYLIST_URL=${PLAYLIST_URL}`);
});

module.exports = app;
