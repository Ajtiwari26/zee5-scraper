import axios from 'axios';
import { randomUUID } from 'crypto';
import { generateZee5Fingerprint, getZee5RotatedHeaders, Zee5Fingerprint } from './fingerprint';

// ─── Zee5 base URLs ──────────────────────────────────────────────────────────
const ZEE5_BASE = 'https://www.zee5.com';
const ZEE5_GW_API = 'https://gwapi.zee5.com';
// Playback token API - returns SIGNED CDN URLs with req_id tokens
const ZEE5_SP_API = 'https://spapi.zee5.com';
// CDN base for resolving relative HLS/DASH paths
const ZEE5_CDN_BASE = 'https://z5ams.akamaized.net';
// VOD CDN (often used for non-DRM content thumbnails/VTT)
const ZEE5_VOD_CDN = 'https://zee5vod.akamaized.net';

// ─── Content interfaces ─────────────────────────────────────────────────────
export interface Zee5ContentInfo {
    id: string;
    title: string;
    description?: string;
    imageUrl?: string;
    contentType?: string;       // asset_type number or string
    assetSubtype?: string;      // sports_vod, movie, episode, etc.
    duration?: number;           // seconds
    isDrm?: boolean;
    drmKeyId?: string;
    businessType?: string;       // advertisement, premium, free, etc.
    hlsUrls?: string[];          // resolved HLS (.m3u8) URLs
    dashUrls?: string[];         // resolved DASH (.mpd) URLs
    // ⭐ Signed playback URLs from singlePlayback API (these actually work!)
    signedDashUrl?: string;      // signed DASH manifest URL with req_id token
    signedHlsUrl?: string;       // signed HLS manifest URL (if available)
    drmLicenseUrl?: string;      // Widevine license URL with sdrm/nl tokens
    drmCustomData?: string;      // sdrm token for DRM license
    drmNl?: string;              // nl token for DRM license
    entitlement?: any;           // playback entitlement info
    tags?: string[];
    url: string;                 // original page URL or slug
    rawData?: any;               // full API response
}

export interface Zee5SearchResult {
    id: string;
    title: string;
    imageUrl?: string;
    contentType?: string;
    url: string;
    description?: string;
    duration?: number;
    isDrm?: boolean;
    businessType?: string;
}

export interface Zee5PlatformContext {
    gwapiPlatformToken: string;
    deviceType: string;
    userType: string;
    contentLanguages: string;
    displayLanguage: string;
}

export interface Zee5HomepageBucket {
    id: string;
    title: string;
    items: Zee5BucketItem[];
}

export interface Zee5BucketItem {
    id: string;
    title: string;
    description?: string;
    imageUrl: string;
    coverImage?: string;
    duration?: number;
    isDrm?: boolean;
    businessType?: string;
    assetType?: number;
    assetSubtype?: string;
    slug?: string;
    tags?: string[];
    genre?: string;
}

// ─── Token cache ─────────────────────────────────────────────────────────────
interface TokenCache {
    token: string;
    expiresAt: number; // timestamp
}

// ─── Zee5 Service ────────────────────────────────────────────────────────────
export class Zee5Service {

    // Cache the platform token for 20 minutes to avoid hammering ZEE5
    private static tokenCache: TokenCache | null = null;
    private static readonly TOKEN_TTL = 20 * 60 * 1000; // 20 min

    // Cache homepage data for 5 minutes
    private static homepageCache: { data: Zee5HomepageBucket[], expiresAt: number } | null = null;
    private static readonly HOMEPAGE_TTL = 5 * 60 * 1000; // 5 min

    /**
     * Fetch any Zee5 page with a fresh rotated fingerprint.
     * Returns raw HTML string.
     */
    static async fetchPage(pageUrl: string): Promise<string | null> {
        try {
            // Using timestamp in seed ensures every call gets a unique fingerprint
            const fingerprint = generateZee5Fingerprint(pageUrl + Date.now());

            console.log(`[Zee5Service] Fetching page: ${pageUrl}`);
            console.log(`[Zee5Service]   Guest token: ${fingerprint.guestToken}`);

            const response = await axios.get(pageUrl, {
                headers: fingerprint.headers,
                timeout: 15000,
                maxRedirects: 5,
                validateStatus: (status) => status >= 200 && status < 400,
            });

            console.log(`[Zee5Service]   Status: ${response.status}, Size: ${JSON.stringify(response.data).length} bytes`);
            return response.data;
        } catch (error) {
            console.error('[Zee5Service] Page fetch error:', (error as Error).message);
            return null;
        }
    }

    /**
     * Extract the platform context from a Zee5 page's PRELOADED_STATE.
     * This gives us the gwapiPlatformToken needed for API calls.
     */
    static extractPlatformContext(html: string): Zee5PlatformContext | null {
        try {
            // Try multiple patterns since ZEE5 uses different formats
            const patterns = [
                /window\.PRELOADED_STATE\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/,
                /window\.__PRELOADED_STATE__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/,
                /"gwapiPlatformToken"\s*:\s*"([^"]+)"/,
            ];

            for (const pattern of patterns) {
                const match = html.match(pattern);
                if (!match || !match[1]) continue;

                // If the pattern directly captures the token string
                if (!match[1].startsWith('{')) {
                    return {
                        gwapiPlatformToken: match[1],
                        deviceType: 'desktop',
                        userType: 'guest',
                        contentLanguages: 'en,hi',
                        displayLanguage: 'en',
                    };
                }

                try {
                    const state = JSON.parse(match[1]);
                    const sd = state.ServerData || state.serverData || state;
                    const token = sd?.gwapiPlatformToken || sd?.platformToken;
                    if (!token) continue;

                    return {
                        gwapiPlatformToken: token,
                        deviceType: sd.deviceType || 'desktop',
                        userType: sd.userType || 'guest',
                        contentLanguages: sd.contentLanguages || 'en,hi',
                        displayLanguage: sd.displayLanguage || 'en',
                    };
                } catch {
                    continue;
                }
            }

            return null;
        } catch (error) {
            console.error('[Zee5Service] Platform context extraction error:', (error as Error).message);
            return null;
        }
    }

    /**
     * Extract PRELOADED_STATE from page HTML.
     * Returns the full Redux state object.
     */
    static extractPreloadedState(html: string): Record<string, any> | null {
        try {
            const match = html.match(/window\.PRELOADED_STATE\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/);
            if (!match || !match[1]) return null;
            return JSON.parse(match[1]);
        } catch (error) {
            console.error('[Zee5Service] PRELOADED_STATE extraction error:', (error as Error).message);
            return null;
        }
    }

    /**
     * Resolve relative Zee5 stream paths to full CDN URLs.
     * Zee5 API returns paths like "/drm1/inhousetranscoder/hls/..." 
     * which need the CDN base prepended.
     */
    static resolveStreamUrl(relativePath: string): string {
        if (relativePath.startsWith('http')) return relativePath;
        return `${ZEE5_CDN_BASE}${relativePath}`;
    }

    /**
     * Get a fresh platform token. Uses cache to avoid repeated requests.
     * Falls back to multiple content pages if one fails.
     */
    static async getPlatformToken(): Promise<string | null> {
        // Check cache first
        if (this.tokenCache && Date.now() < this.tokenCache.expiresAt) {
            console.log('[Zee5Service] Using cached platform token');
            return this.tokenCache.token;
        }

        // Try multiple fallback URLs to get a platform token
        const fallbackUrls = [
            `${ZEE5_BASE}/`,
            `${ZEE5_BASE}/sports/football/fifa-world-cup/2026/match-clips/0-6-4z5974253/mex-vs-rsa-match-preview/0-1-6z5976588`,
            `${ZEE5_BASE}/movies`,
        ];

        for (const url of fallbackUrls) {
            console.log(`[Zee5Service] Trying to get platform token from: ${url}`);
            const html = await this.fetchPage(url);
            if (!html) continue;

            const ctx = this.extractPlatformContext(html);
            if (ctx?.gwapiPlatformToken) {
                // Cache the token
                this.tokenCache = {
                    token: ctx.gwapiPlatformToken,
                    expiresAt: Date.now() + this.TOKEN_TTL,
                };
                console.log(`[Zee5Service] Got platform token: ${ctx.gwapiPlatformToken.substring(0, 30)}...`);
                return ctx.gwapiPlatformToken;
            }
        }

        console.error('[Zee5Service] Failed to obtain platform token from all fallback URLs');
        return null;
    }

    /**
     * Fetch homepage content buckets from ZEE5's collection API.
     * Returns categorized content rows (Trending, Movies, Originals, etc.)
     * This is the primary way to populate the frontend with live content.
     */
    static async getHomepageContent(): Promise<Zee5HomepageBucket[]> {
        // Check cache
        if (this.homepageCache && Date.now() < this.homepageCache.expiresAt) {
            console.log('[Zee5Service] Using cached homepage data');
            return this.homepageCache.data;
        }

        try {
            const token = await this.getPlatformToken();
            if (!token) {
                console.error('[Zee5Service] Cannot fetch homepage: no platform token');
                return [];
            }

            const fingerprint = generateZee5Fingerprint('homepage' + Date.now());

            console.log('[Zee5Service] Fetching homepage collection from gwapi...');

            const response = await axios.get(
                `${ZEE5_GW_API}/content/collection/0-8-homepage`,
                {
                    params: {
                        country: 'IN',
                        page: 1,
                        limit: 20,
                        languages: 'en,hi',
                        translation: 'en',
                    },
                    headers: {
                        ...fingerprint.headers,
                        'x-access-token': token,
                        'Accept': 'application/json',
                        'Origin': ZEE5_BASE,
                        'Referer': `${ZEE5_BASE}/`,
                    },
                    timeout: 15000,
                }
            );

            const data = response.data;
            const rawBuckets = data.buckets || [];
            const buckets: Zee5HomepageBucket[] = [];

            for (const bucket of rawBuckets) {
                const title = bucket.title || '';
                const rawItems = bucket.items || [];

                // Skip empty or internal buckets
                if (rawItems.length === 0) continue;
                // Skip "Belly Banner" type entries
                if (title.toLowerCase().includes('belly banner')) continue;

                const items: Zee5BucketItem[] = rawItems.map((item: any) => {
                    const id = item.id || '';

                    // Resolve list_image filename
                    let listImageFilename = '';
                    if (item.list_image) {
                        listImageFilename = item.list_image;
                    } else if (item.image_url && typeof item.image_url === 'object' && item.image_url.list) {
                        const parts = item.image_url.list.split('/');
                        listImageFilename = parts[parts.length - 1];
                    }

                    // Resolve imageUrl (horizontal thumbnail 270x152)
                    let imageUrl = '';
                    if (item.image_url && typeof item.image_url === 'object' && item.image_url.list) {
                        imageUrl = item.image_url.list;
                    } else if (listImageFilename && id) {
                        imageUrl = `https://akamaividz.zee5.com/resources/${id}/list/270x152/${listImageFilename}`;
                    } else if (item.image_url && typeof item.image_url === 'string') {
                        imageUrl = item.image_url;
                    }

                    // Resolve coverImage (horizontal banner 1170x658)
                    let coverImage = '';
                    if (listImageFilename && id) {
                        coverImage = `https://akamaividz.zee5.com/resources/${id}/list/1170x658/${listImageFilename}`;
                    } else if (imageUrl) {
                        coverImage = imageUrl.replace('/270x152/', '/1170x658/');
                    }

                    // Fallback to vertical cover if coverImage is still empty
                    if (!coverImage) {
                        if (item.image_url && typeof item.image_url === 'object' && item.image_url.cover) {
                            coverImage = item.image_url.cover;
                        } else if (item.cover_image && id) {
                            coverImage = `https://akamaividz1.zee5.com/resources/${id}/cover/270x405/${item.cover_image}`;
                        }
                    }

                    // Extract genre
                    let genre = '';
                    if (Array.isArray(item.genre) && item.genre.length > 0) {
                        genre = item.genre[0]?.value || item.genre[0]?.id || '';
                    }

                    return {
                        id: item.id || '',
                        title: item.title || item.original_title || 'Untitled',
                        description: item.description || item.short_description || '',
                        imageUrl,
                        coverImage,
                        duration: item.duration ? parseInt(item.duration) : undefined,
                        isDrm: item.is_drm === 1 || item.is_drm === '1',
                        businessType: item.business_type || '',
                        assetType: item.asset_type,
                        assetSubtype: item.asset_subtype || '',
                        slug: item.slug || item.web_url || '',
                        tags: item.tags || [],
                        genre,
                    };
                });

                buckets.push({
                    id: bucket.id || '',
                    title,
                    items,
                });
            }

            // Cache
            this.homepageCache = {
                data: buckets,
                expiresAt: Date.now() + this.HOMEPAGE_TTL,
            };

            console.log(`[Zee5Service] Homepage: ${buckets.length} buckets, ${buckets.reduce((sum, b) => sum + b.items.length, 0)} total items`);
            return buckets;

        } catch (error: any) {
            console.error('[Zee5Service] Homepage fetch error:', error.message);
            if (error.response) {
                console.error('[Zee5Service]   Status:', error.response.status);
            }
            return [];
        }
    }

    /**
     * Search content by filtering through cached homepage data.
     * Since gwapi.zee5.com doesn't expose a public search endpoint,
     * we search through the homepage collection items.
     */
    static async searchContent(query: string): Promise<Zee5SearchResult[]> {
        try {
            const buckets = await this.getHomepageContent();
            const q = query.toLowerCase().trim();
            const results: Zee5SearchResult[] = [];
            const seenIds = new Set<string>();

            for (const bucket of buckets) {
                for (const item of bucket.items) {
                    if (seenIds.has(item.id)) continue;

                    // Match against title, description, tags, genre
                    const searchable = [
                        item.title,
                        item.description || '',
                        (item.tags || []).join(' '),
                        item.genre || '',
                        item.assetSubtype || '',
                        bucket.title,
                    ].join(' ').toLowerCase();

                    if (searchable.includes(q)) {
                        seenIds.add(item.id);
                        results.push({
                            id: item.id,
                            title: item.title,
                            imageUrl: item.imageUrl,
                            contentType: item.assetType !== undefined ? String(item.assetType) : 'unknown',
                            url: item.slug ? `${ZEE5_BASE}/${item.slug}` : '',
                            description: item.description,
                            duration: item.duration,
                            isDrm: item.isDrm,
                            businessType: item.businessType,
                        });
                    }
                }
            }

            console.log(`[Zee5Service] Search "${query}": ${results.length} results from homepage cache`);
            return results;
        } catch (error) {
            console.error('[Zee5Service] Search error:', (error as Error).message);
            return [];
        }
    }

    /**
     * ⭐ KEY DISCOVERY: Get SIGNED playback URLs from ZEE5's singlePlayback API.
     * 
     * This is the critical endpoint that ZEE5's web player uses to get CDN-authorized
     * stream URLs. Each call generates a fresh device_id (UUID) to simulate a new guest
     * user, which gives us fresh signed tokens every time.
     * 
     * Endpoint: POST spapi.zee5.com/singlePlayback/getDetails/secure
     * Returns: assetDetails.video_url.mpd (signed DASH URL with req_id)
     *          keyOsDetails.hls_token (signed HLS URL)
     *          keyOsDetails.video_token (signed DASH URL)
     *          keyOsDetails.sdrm + keyOsDetails.nl (DRM license tokens)
     */
    static async getSignedPlaybackUrls(
        contentId: string,
        showId?: string,
        country: string = 'IN'
    ): Promise<{
        signedDashUrl?: string;
        signedHlsUrl?: string;
        hlsToken?: string;
        videoToken?: string;
        drmSdrm?: string;
        drmNl?: string;
        drmLicenseUrl?: string;
        entitlement?: any;
        title?: string;
        isDrm?: boolean;
    } | null> {
        try {
            // 1. Get platform token (cached)
            const platformToken = await this.getPlatformToken();
            if (!platformToken) {
                console.error('[Zee5Service] Cannot get signed URLs: no platform token');
                return null;
            }

            // 2. Generate a fresh device_id for this "new user" session
            const deviceId = randomUUID();
            const fingerprint = generateZee5Fingerprint(contentId + deviceId);

            console.log(`[Zee5Service] ⭐ SinglePlayback: contentId=${contentId}, deviceId=${deviceId}`);

            // 3. Build the singlePlayback URL with query params
            const params = new URLSearchParams({
                content_id: contentId,
                device_id: deviceId,
                platform_name: 'desktop_web',
                translation: 'en',
                user_language: 'en,hi',
                country,
                app_version: '2.51.26',
                user_type: 'guest',
                check_parental_control: 'false',
                ppid: deviceId,
                version: '15',
            });
            // Include show_id if available (helps for episodes)
            if (showId) {
                params.set('show_id', showId);
            }

            // 4. POST request body contains guest token and access token
            const body = JSON.stringify({
                'X-Z5-Guest-Token': deviceId,
                'x-access-token': platformToken,
            });

            const response = await axios.post(
                `${ZEE5_SP_API}/singlePlayback/getDetails/secure?${params.toString()}`,
                body,
                {
                    headers: {
                        ...fingerprint.headers,
                        'Content-Type': 'application/json',
                        'Origin': ZEE5_BASE,
                        'Referer': `${ZEE5_BASE}/`,
                    },
                    timeout: 15000,
                }
            );

            const data = response.data;

            // Check for errors
            if (data.error_msg) {
                console.error(`[Zee5Service] SinglePlayback error: ${data.error_msg} (code: ${data.error_code})`);
                return null;
            }

            const kos = data.keyOsDetails || {};
            const asset = data.assetDetails || {};
            const ent = data.entitlement || {};
            const videoUrl = asset.video_url || {};

            // Extract signed URLs
            const signedDashUrl = typeof videoUrl === 'object' ? (videoUrl.mpd || '') : '';
            const signedHlsUrl = typeof videoUrl === 'object' ? (videoUrl.m3u8 || '') : '';
            const hlsToken = kos.hls_token || '';
            const videoToken = kos.video_token || '';

            // Try to derive HLS URL from DASH URL if not directly available
            let derivedHlsUrl = signedHlsUrl || hlsToken;
            if (!derivedHlsUrl && signedDashUrl) {
                // Replace /dash/ with /hls/ and manifest.mpd with index.m3u8
                derivedHlsUrl = signedDashUrl
                    .replace('/dash/', '/hls/')
                    .replace(/manifest[^/]*\.mpd/, 'index.m3u8');
            }

            console.log(`[Zee5Service]   ✅ Title: ${asset.title}`);
            console.log(`[Zee5Service]   ✅ DRM: ${asset.is_drm}`);
            console.log(`[Zee5Service]   ✅ Signed DASH: ${signedDashUrl ? signedDashUrl.substring(0, 80) + '...' : 'none'}`);
            console.log(`[Zee5Service]   ✅ Signed HLS: ${derivedHlsUrl ? derivedHlsUrl.substring(0, 80) + '...' : 'none'}`);
            console.log(`[Zee5Service]   ✅ Entitlement: isAVOD=${ent.isAVOD}, isPremium=${ent.isPremiumPlayback}`);

            return {
                signedDashUrl: signedDashUrl || undefined,
                signedHlsUrl: derivedHlsUrl || undefined,
                hlsToken: hlsToken || undefined,
                videoToken: videoToken || undefined,
                drmSdrm: kos.sdrm || undefined,
                drmNl: kos.nl || undefined,
                drmLicenseUrl: kos.sdrm ? `${ZEE5_SP_API}/widevine/getLicense` : undefined,
                entitlement: ent,
                title: asset.title,
                isDrm: asset.is_drm === 1 || asset.is_drm === '1',
            };

        } catch (error: any) {
            console.error('[Zee5Service] SinglePlayback error:', error.message);
            if (error.response) {
                console.error('[Zee5Service]   Status:', error.response.status);
            }
            return null;
        }
    }

    /**
     * Fetch content details via Zee5's gateway API.
     * Requires a valid platform token (auto-fetched if not provided).
     */
    static async getContentDetails(
        contentId: string,
        platformToken?: string,
        country: string = 'IN'
    ): Promise<Zee5ContentInfo | null> {
        try {
            // Auto-fetch platform token if not provided
            if (!platformToken) {
                console.log('[Zee5Service] No platform token — fetching...');
                platformToken = await this.getPlatformToken() || undefined;
                if (!platformToken) {
                    console.error('[Zee5Service] Failed to obtain platform token');
                    return null;
                }
            }

            const apiUrl = `${ZEE5_GW_API}/content/details/${contentId}?country=${country}&translation=en&languages=en,hi`;

            const fingerprint = generateZee5Fingerprint(contentId + Date.now());

            console.log(`[Zee5Service] API content details: ${contentId}`);

            const response = await axios.get(apiUrl, {
                headers: {
                    ...fingerprint.headers,
                    'x-access-token': platformToken,
                    'Accept': 'application/json',
                    'Origin': ZEE5_BASE,
                    'Referer': `${ZEE5_BASE}/`,
                },
                timeout: 10000,
            });

            const data = response.data;
            if (!data) return null;

            const id = data.id || contentId;

            // Resolve list_image filename
            let listImageFilename = '';
            if (data.list_image) {
                listImageFilename = data.list_image;
            } else if (data.image_url && typeof data.image_url === 'object' && data.image_url.list) {
                const parts = data.image_url.list.split('/');
                listImageFilename = parts[parts.length - 1];
            } else if (data.image) {
                try {
                    const imgs = typeof data.image === 'string' ? JSON.parse(data.image) : data.image;
                    listImageFilename = imgs.list || imgs.cover || imgs.portrait || Object.values(imgs).find(v => typeof v === 'string') || '';
                } catch {
                    // ignore
                }
            }

            // Resolve imageUrl (horizontal thumbnail 270x152)
            let imageUrl = '';
            if (data.image_url && typeof data.image_url === 'object' && data.image_url.list) {
                imageUrl = data.image_url.list;
            } else if (listImageFilename && id) {
                imageUrl = `https://akamaividz.zee5.com/resources/${id}/list/270x152/${listImageFilename}`;
            } else if (data.image_url && typeof data.image_url === 'string') {
                imageUrl = data.image_url;
            }

            // Resolve HLS stream URLs
            const hlsUrls = Array.isArray(data.hls)
                ? data.hls.map((u: string) => this.resolveStreamUrl(u))
                : [];

            // Resolve DASH stream URLs
            const dashUrls = Array.isArray(data.video)
                ? data.video.map((u: string) => this.resolveStreamUrl(u))
                : [];

            // Build page URL from slug
            const webUrl = data.web_url || data.slug || '';

            // ⭐ Also fetch SIGNED playback URLs from singlePlayback API
            // This gives us CDN-authorized URLs that actually work!
            const showId = data.tvshow?.id || data.season?.show_id || undefined;
            const signed = await this.getSignedPlaybackUrls(contentId, showId, country);

            return {
                id: data.id || contentId,
                title: data.title || data.original_title || 'Unknown',
                description: data.description || data.extended?.digital_long_description_web || data.extended?.short_description || data.extended?.content_category || '',
                imageUrl,
                contentType: String(data.asset_type || 'unknown'),
                assetSubtype: data.asset_subtype || '',
                duration: data.duration ? parseInt(data.duration) : undefined,
                isDrm: data.is_drm === 1 || data.is_drm === '1',
                drmKeyId: data.drm_key_id || undefined,
                businessType: data.business_type || '',
                hlsUrls,
                dashUrls,
                // ⭐ Signed URLs from singlePlayback API
                signedDashUrl: signed?.signedDashUrl,
                signedHlsUrl: signed?.signedHlsUrl,
                drmLicenseUrl: signed?.drmLicenseUrl,
                drmCustomData: signed?.drmSdrm,
                drmNl: signed?.drmNl,
                entitlement: signed?.entitlement,
                tags: data.tags || [],
                url: webUrl ? `${ZEE5_BASE}/${webUrl}` : `${ZEE5_BASE}/`,
                rawData: data,
            };
        } catch (error: any) {
            console.error('[Zee5Service] Content details error:', error.message);
            if (error.response) {
                console.error('[Zee5Service]   Status:', error.response.status, 'Body:', JSON.stringify(error.response.data).substring(0, 200));
            }
            return null;
        }
    }

    /**
     * Full pipeline: fetch a Zee5 page → extract platform token → call API for content details.
     * This is the simplest way to get stream URLs for a content page.
     */
    static async getContentFromPage(pageUrl: string, contentId?: string): Promise<Zee5ContentInfo | null> {
        // Extract content ID from URL if not provided
        if (!contentId) {
            const urlParts = pageUrl.split('/');
            contentId = urlParts[urlParts.length - 1] || urlParts[urlParts.length - 2];
            if (!contentId?.startsWith('0-')) {
                contentId = urlParts.find(part => /^0-\d+-/.test(part));
            }
        }

        if (!contentId) {
            console.error('[Zee5Service] Could not extract content ID from URL:', pageUrl);
            return null;
        }

        console.log(`[Zee5Service] Full pipeline: page=${pageUrl}, contentId=${contentId}`);

        // Use cached token if available, otherwise fetch from page
        let token = this.tokenCache && Date.now() < this.tokenCache.expiresAt
            ? this.tokenCache.token
            : null;

        if (!token) {
            // Step 1: Fetch the page to get platform token
            const html = await this.fetchPage(pageUrl);
            if (!html) {
                // Still try with getPlatformToken fallback
                token = await this.getPlatformToken();
            } else {
                // Step 2: Extract platform token from PRELOADED_STATE
                const ctx = this.extractPlatformContext(html);
                if (ctx) {
                    token = ctx.gwapiPlatformToken;
                    this.tokenCache = {
                        token,
                        expiresAt: Date.now() + this.TOKEN_TTL,
                    };
                } else {
                    console.warn('[Zee5Service] Could not extract platform context from page, trying fallback...');
                    token = await this.getPlatformToken();
                }
            }
        }

        if (!token) {
            console.error('[Zee5Service] No platform token available');
            return null;
        }

        // Step 3: Call API with token
        return this.getContentDetails(contentId, token);
    }

    /**
     * Proxy any Zee5 URL with a fresh rotated fingerprint.
     * Returns raw axios response (can be piped for streaming).
     */
    static async proxyRequest(
        url: string,
        seed?: string,
        responseType: 'stream' | 'json' | 'text' = 'stream'
    ) {
        const fingerprint = generateZee5Fingerprint(seed || url + Date.now());

        console.log(`[Zee5Service] Proxying: ${url}`);
        console.log(`[Zee5Service]   Guest: ${fingerprint.guestToken}`);

        return axios({
            method: 'get',
            url,
            headers: fingerprint.headers,
            responseType,
            timeout: 30000,
            maxRedirects: 5,
            validateStatus: (status) => status >= 200 && status < 400 || status === 206,
        });
    }
}
