import express from 'express';
import cors from 'cors';
import axios from 'axios';
import path from 'path';
import { Zee5Service } from './zee5.service';
import { generateZee5Fingerprint, getZee5RotatedHeaders } from './fingerprint';
import { LiveTVService } from './livetv.service';

const app = express();
const PORT = process.env.PORT || 3002;

app.use(cors());
app.use(express.json());

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, '../public')));


// ─── Health check ────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'zee5-scraper', timestamp: new Date().toISOString() });
});

// ─── Homepage content: live buckets from ZEE5 API ────────────────────────────
// GET /api/zee5/homepage
// Returns categorized content rows (Trending, Movies, Originals, FIFA, etc.)
// This is the primary data source for the frontend homepage.
app.get('/api/zee5/homepage', async (_req, res) => {
    try {
        console.log('[API] Fetching homepage content from ZEE5 collection API');
        const buckets = await Zee5Service.getHomepageContent();
        if (buckets.length === 0) {
            res.status(502).json({ error: 'Failed to fetch homepage content from ZEE5' });
            return;
        }
        res.json({ buckets });
    } catch (error) {
        console.error('[API] Homepage error:', error);
        res.status(500).json({ error: (error as Error).message });
    }
});

// ─── Full pipeline: page URL → content details with stream URLs ──────────────
// GET /api/zee5/content?url=<zee5PageUrl>
// This is the main endpoint — give it any Zee5 content URL and get back
// title, HLS/DASH stream URLs, DRM info, etc.
app.get('/api/zee5/content', async (req, res) => {
    try {
        const url = req.query.url as string;
        const contentId = req.query.id as string | undefined;
        if (!url) {
            res.status(400).json({ error: 'URL is required (pass as ?url=<zee5PageUrl>)' });
            return;
        }
        console.log(`[API] Full pipeline: ${url}`);
        const content = await Zee5Service.getContentFromPage(url, contentId);
        if (!content) {
            res.status(404).json({ error: 'Content not found or failed to extract' });
            return;
        }
        res.json(content);
    } catch (error) {
        console.error('[API] Content error:', error);
        res.status(500).json({ error: (error as Error).message });
    }
});

// ─── Content details by ID (requires platform token — auto-fetched) ──────────
// GET /api/zee5/details?id=<contentId>&country=IN
app.get('/api/zee5/details', async (req, res) => {
    try {
        const contentId = req.query.id as string;
        const country = (req.query.country as string) || 'IN';
        if (!contentId) {
            res.status(400).json({ error: 'Content ID (id) is required' });
            return;
        }
        console.log(`[API] Zee5 Details: ${contentId}`);
        const details = await Zee5Service.getContentDetails(contentId, undefined, country);
        if (!details) {
            res.status(404).json({ error: 'Content not found' });
            return;
        }
        res.json(details);
    } catch (error) {
        console.error('[API] Details error:', error);
        res.status(500).json({ error: (error as Error).message });
    }
});

// ─── Search content ──────────────────────────────────────────────────────────
// GET /api/zee5/search?q=<query>
// Searches through cached homepage content (gwapi doesn't expose a public search endpoint)
app.get('/api/zee5/search', async (req, res) => {
    try {
        const q = req.query.q as string;
        if (!q || q.trim().length === 0) {
            res.json([]);
            return;
        }
        console.log(`[API] Zee5 Search: "${q}"`);
        const results = await Zee5Service.searchContent(q.trim());
        console.log(`[API] Found ${results.length} results`);
        res.json(results);
    } catch (error) {
        console.error('[API] Search error:', error);
        res.status(500).json({ error: (error as Error).message });
    }
});

// ─── ⭐ Signed Playback URLs (NEW USER ROTATION) ────────────────────────────
// GET /api/zee5/playback?id=<contentId>&show_id=<optional>&country=IN
// This is the BREAKTHROUGH endpoint — calls spapi.zee5.com/singlePlayback to get
// CDN-signed stream URLs. Each request simulates a NEW guest user with a fresh
// device_id, so we always get valid signed tokens.
app.get('/api/zee5/playback', async (req, res) => {
    try {
        const contentId = req.query.id as string;
        const showId = req.query.show_id as string | undefined;
        const country = (req.query.country as string) || 'IN';
        if (!contentId) {
            res.status(400).json({ error: 'Content ID (id) is required' });
            return;
        }
        console.log(`[API] ⭐ Signed Playback: ${contentId}`);
        const result = await Zee5Service.getSignedPlaybackUrls(contentId, showId, country);
        if (!result) {
            res.status(404).json({ error: 'Failed to get signed playback URLs' });
            return;
        }
        res.json(result);
    } catch (error) {
        console.error('[API] Playback error:', error);
        res.status(500).json({ error: (error as Error).message });
    }
});

// ─── Get platform token (for external use) ──────────────────────────────────
// GET /api/zee5/token
app.get('/api/zee5/token', async (_req, res) => {
    try {
        console.log('[API] Fetching fresh platform token');
        const token = await Zee5Service.getPlatformToken();
        if (!token) {
            res.status(502).json({ error: 'Failed to obtain platform token' });
            return;
        }
        res.json({ token });
    } catch (error) {
        console.error('[API] Token error:', error);
        res.status(500).json({ error: (error as Error).message });
    }
});

// ─── Extract PRELOADED_STATE from a page ─────────────────────────────────────
// GET /api/zee5/state?url=<zee5PageUrl>
app.get('/api/zee5/state', async (req, res) => {
    try {
        const url = req.query.url as string;
        if (!url) {
            res.status(400).json({ error: 'URL is required' });
            return;
        }
        const html = await Zee5Service.fetchPage(url);
        if (!html) {
            res.status(502).json({ error: 'Failed to fetch page' });
            return;
        }
        const state = Zee5Service.extractPreloadedState(html);
        if (!state) {
            res.status(404).json({ error: 'No PRELOADED_STATE found in page' });
            return;
        }
        res.json(state);
    } catch (error) {
        console.error('[API] State error:', error);
        res.status(500).json({ error: (error as Error).message });
    }
});

// ─── Proxy a Zee5 media URL with rotated fingerprint ─────────────────────────
// GET /api/zee5/stream?url=<mediaUrl>
app.get('/api/zee5/stream', async (req, res) => {
    const { url } = req.query;

    if (!url) {
        res.status(400).json({ error: 'Missing parameter: url is required.' });
        return;
    }

    try {
        const targetUrl = url as string;
        const headers = getZee5RotatedHeaders(targetUrl + Date.now());

        if (req.headers.range) {
            headers['Range'] = req.headers.range as string;
        }

        console.log(`[API] Zee5 Stream Proxy: ${targetUrl}`);

        const isManifest = targetUrl.includes('.m3u8');

        if (isManifest) {
            // For manifest playlists (.m3u8), we need to fetch as text and rewrite relative URLs
            const response = await axios({
                method: 'get',
                url: targetUrl,
                headers: headers,
                responseType: 'text',
                maxRedirects: 5,
            });

            // Set content-type
            res.setHeader('content-type', String(response.headers['content-type'] || 'application/x-mpegURL'));
            res.setHeader('cache-control', 'no-cache');

            // Resolve relative URLs in manifest to absolute proxied URLs
            const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
            const parsedUrl = new URL(targetUrl);
            const searchParams = parsedUrl.search; // e.g. "?req_id=..."

            const content = response.data;
            const lines = content.split('\n');
            const rewrittenLines = lines.map((line: string) => {
                const trimmed = line.trim();
                if (!trimmed) return line;

                // Case 1: Tag with URI attribute (e.g., #EXT-X-MEDIA:...,URI="...")
                if (trimmed.startsWith('#')) {
                    return line.replace(/URI="([^"]+)"/g, (match, relUrl) => {
                        if (relUrl.startsWith('http://') || relUrl.startsWith('https://')) {
                            return match;
                        }
                        const absUrl = new URL(relUrl, baseUrl).href;
                        const finalUrl = absUrl.includes('?') ? absUrl : absUrl + searchParams;
                        return `URI="http://localhost:${PORT}/api/zee5/stream?url=${encodeURIComponent(finalUrl)}"`;
                    });
                }

                // Case 2: Relative URL path (playlist file or media segment)
                if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://') && !trimmed.startsWith('data:')) {
                    const absUrl = new URL(trimmed, baseUrl).href;
                    const finalUrl = absUrl.includes('?') ? absUrl : absUrl + searchParams;
                    return `http://localhost:${PORT}/api/zee5/stream?url=${encodeURIComponent(finalUrl)}`;
                }

                return line;
            });

            res.status(response.status).send(rewrittenLines.join('\n'));
        } else {
            // For segment files (.ts, .m4s, etc.), stream them directly
            const response = await axios({
                method: 'get',
                url: targetUrl,
                headers: headers,
                responseType: 'stream',
                maxRedirects: 5,
                validateStatus: (status) => status >= 200 && status < 400 || status === 206,
            });

            const forwardHeaders = [
                'content-type', 'content-length', 'content-range',
                'accept-ranges', 'etag', 'last-modified', 'cache-control',
            ];
            forwardHeaders.forEach(header => {
                if (response.headers[header]) {
                    res.setHeader(header, response.headers[header]);
                }
            });

            res.status(response.status);
            response.data.pipe(res);

            req.on('close', () => {
                if (response.data.destroy) {
                    response.data.destroy();
                }
            });
        }
    } catch (error: any) {
        console.error('[API] Stream proxy error:', error.message);
        if (error.response) {
            res.status(error.response.status).json({ error: 'Proxy request failed', details: error.message });
        } else {
            res.status(500).json({ error: 'Internal server error', details: error.message });
        }
    }
});

// ─── Proxy page fetch ────────────────────────────────────────────────────────
// GET /api/zee5/page?url=<zee5PageUrl>
app.get('/api/zee5/page', async (req, res) => {
    const { url } = req.query;

    if (!url) {
        res.status(400).json({ error: 'Missing parameter: url is required.' });
        return;
    }

    try {
        const html = await Zee5Service.fetchPage(url as string);
        if (!html) {
            res.status(502).json({ error: 'Failed to fetch page' });
            return;
        }
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.status(200).send(html);
    } catch (error: any) {
        console.error('[API] Page proxy error:', error.message);
        res.status(500).json({ error: 'Internal server error', details: error.message });
    }
});

// ─── Debug: show a generated fingerprint ─────────────────────────────────────
// GET /api/zee5/debug/fingerprint?seed=<optional_seed>
app.get('/api/zee5/debug/fingerprint', (req, res) => {
    const seed = req.query.seed as string || undefined;
    const fp = generateZee5Fingerprint(seed);
    res.json({
        guestToken: fp.guestToken,
        cookies: fp.cookies,
        headers: fp.headers,
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ─── LiveTV Free Stream Endpoints ────────────────────────────────────────────
// These endpoints provide free HLS streams as alternatives when Zee5 premium
// content is DRM-blocked. Streams are sourced from LiveTV aggregator.
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Get streams for a LiveTV event ──────────────────────────────────────────
// GET /api/livetv/event?url=<eventPageUrl>
// Fetches the event page and extracts all available stream channel IDs.
app.get('/api/livetv/event', async (req, res) => {
    try {
        const url = req.query.url as string;
        if (!url) {
            res.status(400).json({ error: 'Event URL is required (pass as ?url=<liveTvEventUrl>)' });
            return;
        }
        console.log(`[API] 🔴 LiveTV Event: ${url}`);
        const event = await LiveTVService.getEventStreams(url);
        if (!event) {
            res.status(404).json({ error: 'Could not fetch or parse event page' });
            return;
        }
        res.json(event);
    } catch (error) {
        console.error('[API] LiveTV event error:', error);
        res.status(500).json({ error: (error as Error).message });
    }
});

// ─── Resolve a channel ID to its HLS URL ─────────────────────────────────────
// GET /api/livetv/resolve?channel=<channelId>
// Fetches the embed player page and extracts the actual HLS manifest URL.
app.get('/api/livetv/resolve', async (req, res) => {
    try {
        const channelId = req.query.channel as string;
        if (!channelId) {
            res.status(400).json({ error: 'Channel ID is required (pass as ?channel=<channelId>)' });
            return;
        }
        console.log(`[API] 🔴 LiveTV Resolve: channel=${channelId}`);
        const resolved = await LiveTVService.resolveStream(channelId);
        if (!resolved) {
            res.status(404).json({ error: 'Could not resolve stream for this channel' });
            return;
        }
        // Return the proxied HLS URL so the frontend can play directly
        res.json({
            ...resolved,
            proxiedHlsUrl: `http://localhost:${PORT}/api/livetv/stream?url=${encodeURIComponent(resolved.hlsUrl)}`,
        });
    } catch (error) {
        console.error('[API] LiveTV resolve error:', error);
        res.status(500).json({ error: (error as Error).message });
    }
});

// ─── Search LiveTV for live/upcoming events ──────────────────────────────────
// GET /api/livetv/search?q=<query>
app.get('/api/livetv/search', async (req, res) => {
    try {
        const q = req.query.q as string;
        if (!q || q.trim().length === 0) {
            res.json([]);
            return;
        }
        console.log(`[API] 🔴 LiveTV Search: "${q}"`);
        const results = await LiveTVService.searchEvents(q.trim());
        res.json(results);
    } catch (error) {
        console.error('[API] LiveTV search error:', error);
        res.status(500).json({ error: (error as Error).message });
    }
});

// ─── Proxy LiveTV HLS streams (adds correct Referer header) ──────────────────
// GET /api/livetv/stream?url=<hlsUrl>
// Proxies .m3u8 manifests and .ts segments with the required Referer header.
app.get('/api/livetv/stream', async (req, res) => {
    const { url } = req.query;

    if (!url) {
        res.status(400).json({ error: 'Missing parameter: url is required.' });
        return;
    }

    try {
        const targetUrl = url as string;
        console.log(`[API] 🔴 LiveTV Stream Proxy: ${targetUrl}`);

        const result = await LiveTVService.proxyStreamRequest(
            targetUrl,
            req.headers.range as string | undefined
        );

        if (result.isManifest) {
            // Rewrite relative URLs in manifest to go through our proxy
            const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
            const content = result.data as string;
            const lines = content.split('\n');
            const rewrittenLines = lines.map((line: string) => {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) return line;
                // Relative .ts segment URLs
                if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
                    const absUrl = new URL(trimmed, baseUrl).href;
                    return `http://localhost:${PORT}/api/livetv/stream?url=${encodeURIComponent(absUrl)}`;
                }
                return line;
            });

            res.setHeader('content-type', 'application/x-mpegURL');
            res.setHeader('cache-control', 'no-cache');
            res.setHeader('access-control-allow-origin', '*');
            res.status(result.status).send(rewrittenLines.join('\n'));
        } else {
            // Forward segment data as stream
            Object.entries(result.headers).forEach(([key, value]) => {
                res.setHeader(key, value);
            });
            res.setHeader('access-control-allow-origin', '*');
            res.status(result.status);
            result.data.pipe(res);

            req.on('close', () => {
                if (result.data.destroy) result.data.destroy();
            });
        }
    } catch (error: any) {
        console.error('[API] LiveTV stream proxy error:', error.message);
        if (error.response) {
            res.status(error.response.status).json({ error: 'Proxy request failed', details: error.message });
        } else {
            res.status(500).json({ error: 'Internal server error', details: error.message });
        }
    }
});

// ─── Start server ────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n🎬 Zee5 Scraper + LiveTV running on http://localhost:${PORT}`);
    console.log(`\n── Zee5 Endpoints ──`);
    console.log(`  GET /api/zee5/homepage                         — ⭐ Live homepage content rows`);
    console.log(`  GET /api/zee5/content?url=<pageUrl>            — ⭐ Full pipeline: URL → stream URLs`);
    console.log(`  GET /api/zee5/details?id=<contentId>           — Content details by ID`);
    console.log(`  GET /api/zee5/search?q=<query>                 — Search content`);
    console.log(`  GET /api/zee5/token                            — Get fresh platform token`);
    console.log(`  GET /api/zee5/state?url=<pageUrl>              — Extract page PRELOADED_STATE`);
    console.log(`  GET /api/zee5/stream?url=<mediaUrl>            — Proxy media stream`);
    console.log(`  GET /api/zee5/page?url=<pageUrl>               — Proxy page HTML`);
    console.log(`  GET /api/zee5/debug/fingerprint?seed=<seed>    — Debug fingerprint`);
    console.log(`\n── 🔴 LiveTV Free Stream Endpoints ──`);
    console.log(`  GET /api/livetv/event?url=<eventUrl>           — 🔴 Get streams for a live event`);
    console.log(`  GET /api/livetv/resolve?channel=<channelId>    — 🔴 Resolve channel → HLS URL`);
    console.log(`  GET /api/livetv/search?q=<query>               — 🔴 Search live/upcoming events`);
    console.log(`  GET /api/livetv/stream?url=<hlsUrl>            — 🔴 Proxy LiveTV HLS stream`);
    console.log(`\n  GET /health                                    — Health check\n`);
});
