import axios from 'axios';

// ─── LiveTV base URLs ────────────────────────────────────────────────────────
const LIVETV_BASE = 'https://livetv902.me';
const LIVETV_EMBED = 'https://emb.apl423.me';

// ─── Interfaces ──────────────────────────────────────────────────────────────
export interface LiveTVStream {
    channelId: string;
    language: string;
    rating: number;          // percentage (e.g., 95)
    webPlayerUrl: string;    // full webplayer URL
    hlsUrl?: string;         // resolved HLS URL (after calling resolve)
}

export interface LiveTVEvent {
    eventId: string;
    title: string;
    sport: string;
    tournament: string;
    time: string;            // e.g., "21:00"
    date: string;            // e.g., "9 July 2026"
    streams: LiveTVStream[];
    aceStreams: string[];     // acestream:// hashes
    url: string;             // original event page URL
}

export interface LiveTVResolvedStream {
    channelId: string;
    hlsUrl: string;
    playerUrl: string;       // embed player URL
    serverDomain: string;    // e.g., "a50.azplay43.me"
    cstToken: string;        // the CST auth token
}

// ─── LiveTV Service ──────────────────────────────────────────────────────────
export class LiveTVService {

    // Cache resolved streams for 5 minutes (CST tokens may expire)
    private static resolveCache: Map<string, { data: LiveTVResolvedStream, expiresAt: number }> = new Map();
    private static readonly RESOLVE_TTL = 5 * 60 * 1000; // 5 min

    /**
     * Fetch a LiveTV event page and extract all available stream links.
     * Returns structured data about the event and its streams.
     */
    static async getEventStreams(eventUrl: string): Promise<LiveTVEvent | null> {
        try {
            console.log(`[LiveTV] Fetching event page: ${eventUrl}`);

            const response = await axios.get(eventUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml',
                    'Accept-Language': 'en-US,en;q=0.9',
                },
                timeout: 15000,
            });

            const html = response.data as string;
            return this.parseEventPage(html, eventUrl);
        } catch (error: any) {
            console.error('[LiveTV] Event fetch error:', error.message);
            return null;
        }
    }

    /**
     * Parse the event page HTML to extract stream links.
     */
    private static parseEventPage(html: string, eventUrl: string): LiveTVEvent | null {
        try {
            // Extract event title from <h1> tag
            const h1Match = html.match(/<h1[^>]*>(?:LiveStream, Broadcast\s*)?(.+?)<\/h1>/i);
            const title = h1Match ? h1Match[1].replace(/<[^>]+>/g, '').trim() : 'Unknown Event';

            // Extract event ID from URL
            const eventIdMatch = eventUrl.match(/eventinfo\/(\d+)/);
            const eventId = eventIdMatch ? eventIdMatch[1] : '';

            // Extract tournament and date info
            const tournamentMatch = html.match(/class="competition"[^>]*>([^<]+)/i) ||
                                   html.match(/<a[^>]*league[^>]*>([^<]+)/i);
            const tournament = tournamentMatch ? tournamentMatch[1].trim() : '';

            const dateMatch = html.match(/(\d{1,2}\s+\w+\s+\d{4})\s+at\s+(\d{2}:\d{2})/);
            const date = dateMatch ? dateMatch[1] : '';
            const time = dateMatch ? dateMatch[2] : '';

            // Extract browser stream links (alieztv webplayer links)
            const streams: LiveTVStream[] = [];
            // Pattern: webplayer2.php?t=alieztv&c=CHANNEL_ID&lang=LANG&eid=EVENT_ID&lid=LINK_ID&ci=CI&si=SI
            const webPlayerPattern = /webplayer2\.php\?t=alieztv&(?:amp;)?c=(\d+)&(?:amp;)?lang=(\w+)&(?:amp;)?eid=(\d+)&(?:amp;)?lid=(\d+)/g;
            const seenChannels = new Set<string>();

            let match;
            while ((match = webPlayerPattern.exec(html)) !== null) {
                const channelId = match[1];
                if (seenChannels.has(channelId)) continue;
                seenChannels.add(channelId);

                // Extract the full URL from the href
                const fullUrlMatch = html.substring(Math.max(0, match.index - 200), match.index + match[0].length + 200)
                    .match(/href="([^"]*webplayer2\.php[^"]*c=\d+[^"]*)"/);

                const webPlayerUrl = fullUrlMatch
                    ? fullUrlMatch[1].replace(/&amp;/g, '&')
                    : `${LIVETV_BASE}/webplayer2.php?t=alieztv&c=${channelId}&lang=${match[2]}&eid=${match[3]}&lid=${match[4]}&ci=2608&si=1`;

                // Extract language flag image near this link
                const langCode = match[2] || 'en';

                streams.push({
                    channelId,
                    language: langCode,
                    rating: 95, // Default rating from the page
                    webPlayerUrl: webPlayerUrl.startsWith('http') ? webPlayerUrl : `${LIVETV_BASE}/${webPlayerUrl}`,
                });
            }

            // Extract AceStream hashes
            const aceStreams: string[] = [];
            const acePattern = /acestream:\/\/([a-f0-9]{40})/g;
            while ((match = acePattern.exec(html)) !== null) {
                if (!aceStreams.includes(match[1])) {
                    aceStreams.push(match[1]);
                }
            }

            console.log(`[LiveTV] Parsed event: "${title}" — ${streams.length} browser streams, ${aceStreams.length} ace streams`);

            return {
                eventId,
                title,
                sport: 'Football',
                tournament,
                time,
                date,
                streams,
                aceStreams,
                url: eventUrl,
            };
        } catch (error: any) {
            console.error('[LiveTV] Parse error:', error.message);
            return null;
        }
    }

    /**
     * Resolve a channel ID to its actual HLS URL by fetching the embed player page
     * and extracting the pl.init() call.
     */
    static async resolveStream(channelId: string): Promise<LiveTVResolvedStream | null> {
        // Check cache first
        const cached = this.resolveCache.get(channelId);
        if (cached && Date.now() < cached.expiresAt) {
            console.log(`[LiveTV] Using cached stream for channel ${channelId}`);
            return cached.data;
        }

        try {
            const embedUrl = `${LIVETV_EMBED}/player/live.php?id=${channelId}&w=700&h=480`;
            console.log(`[LiveTV] Resolving channel ${channelId} via: ${embedUrl}`);

            const response = await axios.get(embedUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml',
                    'Referer': `${LIVETV_BASE}/`,
                },
                timeout: 15000,
            });

            const html = response.data as string;

            // Extract the HLS URL from: pl.init('//a59.azplay43.me/hls/streama261315/index.m3u8?cst=TOKEN');
            const initMatch = html.match(/pl\.init\(['"]([^'"]+)['"]\)/);
            if (!initMatch) {
                console.error('[LiveTV] Could not find pl.init() in embed page');
                // Try alternate pattern: source or src attributes with m3u8
                const srcMatch = html.match(/(?:src|source)\s*[:=]\s*['"]([^'"]*\.m3u8[^'"]*)['"]/i);
                if (!srcMatch) {
                    console.error('[LiveTV] No HLS URL found in embed page');
                    return null;
                }
                const hlsUrl = srcMatch[1].startsWith('//') ? `https:${srcMatch[1]}` : srcMatch[1];
                const serverMatch = hlsUrl.match(/\/\/(a\d+\.azplay\d+\.me)/);
                const cstMatch = hlsUrl.match(/cst=([a-f0-9]+)/);

                const result: LiveTVResolvedStream = {
                    channelId,
                    hlsUrl,
                    playerUrl: embedUrl,
                    serverDomain: serverMatch ? serverMatch[1] : 'unknown',
                    cstToken: cstMatch ? cstMatch[1] : '',
                };

                this.resolveCache.set(channelId, { data: result, expiresAt: Date.now() + this.RESOLVE_TTL });
                return result;
            }

            let hlsUrl = initMatch[1];
            // Ensure protocol
            if (hlsUrl.startsWith('//')) {
                hlsUrl = `https:${hlsUrl}`;
            }

            // Extract server domain
            const serverMatch = hlsUrl.match(/\/\/(a\d+\.azplay\d+\.me)/);
            const serverDomain = serverMatch ? serverMatch[1] : 'unknown';

            // Extract CST token
            const cstMatch = hlsUrl.match(/cst=([a-f0-9]+)/);
            const cstToken = cstMatch ? cstMatch[1] : '';

            console.log(`[LiveTV] ✅ Resolved channel ${channelId}: ${hlsUrl.substring(0, 80)}...`);
            console.log(`[LiveTV]    Server: ${serverDomain}, CST: ${cstToken.substring(0, 16)}...`);

            const result: LiveTVResolvedStream = {
                channelId,
                hlsUrl,
                playerUrl: embedUrl,
                serverDomain,
                cstToken,
            };

            // Cache the result
            this.resolveCache.set(channelId, { data: result, expiresAt: Date.now() + this.RESOLVE_TTL });
            return result;

        } catch (error: any) {
            console.error(`[LiveTV] Resolve error for channel ${channelId}:`, error.message);
            return null;
        }
    }

    /**
     * Resolve multiple channels at once (best-effort, returns first successful ones).
     */
    static async resolveMultiple(channelIds: string[], maxConcurrent: number = 3): Promise<LiveTVResolvedStream[]> {
        const results: LiveTVResolvedStream[] = [];

        // Process in batches to avoid overwhelming the server
        for (let i = 0; i < channelIds.length; i += maxConcurrent) {
            const batch = channelIds.slice(i, i + maxConcurrent);
            const promises = batch.map(id => this.resolveStream(id));
            const batchResults = await Promise.allSettled(promises);

            for (const result of batchResults) {
                if (result.status === 'fulfilled' && result.value) {
                    results.push(result.value);
                }
            }
        }

        return results;
    }

    /**
     * Proxy an HLS stream request (manifest or segment) with the correct Referer header.
     * This is needed because the CDN checks for the embed domain as referer.
     */
    static async proxyStreamRequest(url: string, rangeHeader?: string): Promise<{
        status: number;
        headers: Record<string, string>;
        data: any;
        isManifest: boolean;
    }> {
        const isManifest = url.includes('.m3u8');

        const headers: Record<string, string> = {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Origin': LIVETV_EMBED,
            'Referer': `${LIVETV_EMBED}/`,
        };

        if (rangeHeader) {
            headers['Range'] = rangeHeader;
        }

        const response = await axios({
            method: 'get',
            url,
            headers,
            responseType: isManifest ? 'text' : 'stream',
            timeout: 15000,
            maxRedirects: 5,
            validateStatus: (status) => status >= 200 && status < 400 || status === 206,
        });

        const responseHeaders: Record<string, string> = {};
        const forwardHeaders = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control'];
        forwardHeaders.forEach(h => {
            if (response.headers[h]) responseHeaders[h] = String(response.headers[h]);
        });

        return {
            status: response.status,
            headers: responseHeaders,
            data: response.data,
            isManifest,
        };
    }

    /**
     * Search LiveTV for upcoming/live events matching a query.
     * Scrapes the allupcoming page for matching events.
     */
    static async searchEvents(query: string): Promise<Array<{
        eventId: string;
        title: string;
        time: string;
        tournament: string;
        url: string;
        isLive: boolean;
    }>> {
        try {
            console.log(`[LiveTV] Searching for events: "${query}"`);

            const response = await axios.get(`${LIVETV_BASE}/enx/allupcomingsports/1/`, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
                    'Accept': 'text/html',
                },
                timeout: 15000,
            });

            const html = response.data as string;
            const results: Array<{
                eventId: string;
                title: string;
                time: string;
                tournament: string;
                url: string;
                isLive: boolean;
            }> = [];

            // Extract event links: /enx/eventinfo/EVENT_ID_title/
            const eventPattern = /href="(\/enx\/eventinfo\/(\d+)[^"]*)"[^>]*>([^<]+)<\/a>/g;
            const q = query.toLowerCase();
            let match;

            while ((match = eventPattern.exec(html)) !== null) {
                const eventPath = match[1];
                const eventId = match[2];
                const title = match[3].trim();

                // Check if title matches query
                if (title.toLowerCase().includes(q) ||
                    q.split(/\s+/).every(word => title.toLowerCase().includes(word))) {

                    // Check if there's a "LIVE" indicator nearby
                    const contextStart = Math.max(0, match.index - 200);
                    const context = html.substring(contextStart, match.index + match[0].length + 100);
                    const isLive = context.includes('play.gif') || context.includes('live_icon');

                    results.push({
                        eventId,
                        title,
                        time: '',
                        tournament: '',
                        url: `${LIVETV_BASE}${eventPath}`,
                        isLive,
                    });
                }
            }

            console.log(`[LiveTV] Found ${results.length} matching events for "${query}"`);
            return results;

        } catch (error: any) {
            console.error('[LiveTV] Search error:', error.message);
            return [];
        }
    }
}
