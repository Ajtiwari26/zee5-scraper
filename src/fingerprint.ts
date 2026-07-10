import { v4 as uuidv4 } from 'uuid';

// ─── Hash utility (same technique as knot's jiosaavn.service.ts) ─────────────
function hashCode(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = (hash << 5) - hash + char;
        hash |= 0;
    }
    return Math.abs(hash);
}

// ─── Indian IP ranges for X-Forwarded-For rotation ───────────────────────────
// These cover major Indian ISPs so Zee5 sees geo-appropriate traffic
const INDIAN_IP_RANGES = [
    // Reliance Jio (157.32.0.0/11)
    { start: [157, 32, 0, 0], end: [157, 63, 255, 255] },
    // Reliance Jio (49.32.0.0/12)
    { start: [49, 32, 0, 0], end: [49, 47, 255, 255] },
    // Bharti Airtel (122.160.0.0/11)
    { start: [122, 160, 0, 0], end: [122, 191, 255, 255] },
    // ACT Fibernet (49.204.0.0/14)
    { start: [49, 204, 0, 0], end: [49, 207, 255, 255] },
    // BSNL (117.192.0.0/12)
    { start: [117, 192, 0, 0], end: [117, 207, 255, 255] },
    // Vodafone-Idea (106.192.0.0/12)
    { start: [106, 192, 0, 0], end: [106, 207, 255, 255] },
];

function getRandomIP(seed?: string): string {
    let rangeIndex: number;
    let r1: number, r2: number, r3: number, r4: number;

    if (seed) {
        const hash = hashCode(seed);
        rangeIndex = hash % INDIAN_IP_RANGES.length;
        const range = INDIAN_IP_RANGES[rangeIndex];

        const span1 = range.end[0] - range.start[0] + 1;
        const span2 = range.end[1] - range.start[1] + 1;
        const span3 = range.end[2] - range.start[2] + 1;
        const span4 = range.end[3] - range.start[3] + 1;

        r1 = range.start[0] + (hash % span1);
        r2 = range.start[1] + ((hash >> 4) % span2);
        r3 = range.start[2] + ((hash >> 8) % span3);
        r4 = range.start[3] + ((hash >> 12) % span4);
    } else {
        rangeIndex = Math.floor(Math.random() * INDIAN_IP_RANGES.length);
        const range = INDIAN_IP_RANGES[rangeIndex];

        const span1 = range.end[0] - range.start[0] + 1;
        const span2 = range.end[1] - range.start[1] + 1;
        const span3 = range.end[2] - range.start[2] + 1;
        const span4 = range.end[3] - range.start[3] + 1;

        r1 = range.start[0] + Math.floor(Math.random() * span1);
        r2 = range.start[1] + Math.floor(Math.random() * span2);
        r3 = range.start[2] + Math.floor(Math.random() * span3);
        r4 = range.start[3] + Math.floor(Math.random() * span4);
    }

    return `${r1}.${r2}.${r3}.${r4}`;
}

// ─── User-Agent pool (realistic, recent browser strings) ─────────────────────
const USER_AGENTS_POOL = [
    // Chrome Android (various devices)
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 14; SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 13; Pixel 7a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 14; OnePlus 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36',
    // Chrome Desktop Windows
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    // Chrome Desktop macOS
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    // Safari iOS
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
    // Firefox
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0',
];

// ─── Chrome sec-ch-ua versions ───────────────────────────────────────────────
const CHROME_VERSIONS = [
    { full: '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"', version: '149' },
    { full: '"Google Chrome";v="148", "Chromium";v="148", "Not=A?Brand";v="8"', version: '148' },
    { full: '"Google Chrome";v="147", "Chromium";v="147", "Not/A)Brand";v="8"', version: '147' },
    { full: '"Google Chrome";v="146", "Chromium";v="146", "Not=A?Brand";v="8"', version: '146' },
];

// ─── Zee5 content language combos ────────────────────────────────────────────
const CONTENT_LANGUAGES = [
    'en,hi', 'en,gu,hi', 'en,ta,hi', 'en,te,hi', 'en,mr,hi',
    'en,bn,hi', 'en,kn,hi', 'en', 'hi,en',
];

// ─── Fingerprint interface ───────────────────────────────────────────────────
export interface Zee5Fingerprint {
    headers: Record<string, string>;
    cookies: string;
    guestToken: string;
}

/**
 * Generates a unique fingerprint per request/seed to avoid rate limiting.
 * Rotates: guest token (UUID), user-agent, IP, sec-ch-ua, content-language
 * 
 * This mirrors the pattern from knot's jiosaavn.service.ts getRotatedHeaders()
 * but adapted for Zee5's Akamai Bot Manager + guest token system.
 */
export function generateZee5Fingerprint(seed?: string): Zee5Fingerprint {
    const hash = seed ? hashCode(seed) : Math.floor(Math.random() * 1000000);

    // Pick a user-agent deterministically from seed
    const userAgent = USER_AGENTS_POOL[hash % USER_AGENTS_POOL.length];
    const isChrome = userAgent.includes('Chrome') && !userAgent.includes('Firefox');
    const isMobile = userAgent.includes('Mobile');
    const isAndroid = userAgent.includes('Android');
    const isWindows = userAgent.includes('Windows');
    const isMac = userAgent.includes('Macintosh');

    // Generate a fresh guest token UUID (new identity every call)
    const guestToken = uuidv4();

    // Pick IP for forwarding headers
    const ip = getRandomIP(seed);

    // Pick content language
    const contentLang = CONTENT_LANGUAGES[hash % CONTENT_LANGUAGES.length];

    // Build request headers
    const headers: Record<string, string> = {
        'User-Agent': userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'en-GB,en;q=0.9,hi-IN;q=0.8,hi;q=0.7,en-US;q=0.6',
        'Connection': 'keep-alive',
        'Referer': 'https://www.zee5.com/',
        // IP forwarding headers — same technique as knot jiosaavn
        'X-Forwarded-For': ip,
        'X-Real-IP': ip,
        'client-ip': ip,
    };

    // Add Chrome client hints (Zee5 checks these for bot detection)
    if (isChrome) {
        const chromeVer = CHROME_VERSIONS[hash % CHROME_VERSIONS.length];
        headers['sec-ch-ua'] = chromeVer.full;
        headers['sec-ch-ua-mobile'] = isMobile ? '?1' : '?0';

        if (isAndroid) {
            headers['sec-ch-ua-platform'] = '"Android"';
        } else if (isWindows) {
            headers['sec-ch-ua-platform'] = '"Windows"';
        } else if (isMac) {
            headers['sec-ch-ua-platform'] = '"macOS"';
        }

        headers['sec-fetch-dest'] = 'empty';
        headers['sec-fetch-mode'] = 'navigate';
        headers['sec-fetch-site'] = 'same-origin';
        headers['upgrade-insecure-requests'] = '1';
    }

    // Build minimal essential cookies
    // Note: bm_sv and ak_bmsc are set server-side by Akamai — we don't need to fake them
    const cookieParts = [
        `guestToken=${guestToken}`,
        `user-type=guest`,
        `display-language=en`,
        `content-language=${contentLang}`,
        `previousConsumptionPageLanguage=`,
    ];
    const cookieString = cookieParts.join('; ');
    headers['Cookie'] = cookieString;

    return { headers, cookies: cookieString, guestToken };
}

/**
 * Convenience function — returns just the headers dict.
 * Drop-in equivalent to knot's getRotatedHeaders() for JioSaavn.
 */
export function getZee5RotatedHeaders(seed?: string): Record<string, string> {
    return generateZee5Fingerprint(seed).headers;
}
