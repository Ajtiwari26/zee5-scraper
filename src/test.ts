/**
 * Test script — validates the full Zee5 scraper pipeline.
 * Usage: npm run test
 */
import { generateZee5Fingerprint } from './fingerprint';
import { Zee5Service } from './zee5.service';

async function main() {
    console.log('═══════════════════════════════════════════════════════');
    console.log('  Zee5 Scraper — Test Suite');
    console.log('═══════════════════════════════════════════════════════\n');

    // ─── Test 1: Fingerprint rotation uniqueness ─────────────────────────
    console.log('── Test 1: Fingerprint Rotation ──');
    const fp1 = generateZee5Fingerprint('seed-1');
    const fp2 = generateZee5Fingerprint('seed-2');
    const fp3 = generateZee5Fingerprint(); // random

    console.log(`  FP1 Guest: ${fp1.guestToken}`);
    console.log(`  FP1 UA:    ${fp1.headers['User-Agent'].substring(0, 60)}...`);
    console.log(`  FP1 IP:    ${fp1.headers['X-Forwarded-For']}`);
    console.log(`  FP2 Guest: ${fp2.guestToken}`);
    console.log(`  FP2 IP:    ${fp2.headers['X-Forwarded-For']}`);
    console.log(`  FP3 Guest: ${fp3.guestToken} (random)`);
    console.log(`  All unique: ${fp1.guestToken !== fp2.guestToken && fp2.guestToken !== fp3.guestToken ? '✅' : '❌'}\n`);

    // ─── Test 2: Full pipeline (page → token → API → stream URLs) ───────
    console.log('── Test 2: Full Pipeline (page → stream URLs) ──');
    const testUrl = 'https://www.zee5.com/sports/football/fifa-world-cup/2026/match-clips/0-6-4z5974253/mex-vs-rsa-match-preview/0-1-6z5976588';
    console.log(`  URL: ${testUrl}`);

    const content = await Zee5Service.getContentFromPage(testUrl);
    if (content) {
        console.log(`  ✅ Title: ${content.title}`);
        console.log(`  ID: ${content.id}`);
        console.log(`  Type: ${content.contentType} / ${content.assetSubtype}`);
        console.log(`  Duration: ${content.duration}s`);
        console.log(`  DRM: ${content.isDrm} (key: ${content.drmKeyId || 'none'})`);
        console.log(`  Business: ${content.businessType}`);
        console.log(`  Tags: ${content.tags?.join(', ')}`);
        console.log(`  HLS URLs (${content.hlsUrls?.length || 0}):`);
        content.hlsUrls?.forEach((u, i) => console.log(`    [${i}] ${u}`));
        console.log(`  DASH URLs (${content.dashUrls?.length || 0}):`);
        content.dashUrls?.forEach((u, i) => console.log(`    [${i}] ${u}`));
    } else {
        console.log('  ❌ Full pipeline failed');
    }

    // ─── Test 3: Rapid requests with different fingerprints ──────────────
    console.log('\n── Test 3: Rapid Requests (3x same URL, different fingerprints) ──');
    let successCount = 0;
    for (let i = 0; i < 3; i++) {
        try {
            const html = await Zee5Service.fetchPage(testUrl);
            if (html && html.length > 1000) {
                successCount++;
                const ctx = Zee5Service.extractPlatformContext(html);
                console.log(`  Request ${i + 1}: ✅ (${html.length} chars, token: ${ctx?.gwapiPlatformToken?.substring(0, 30)}...)`);
            } else {
                console.log(`  Request ${i + 1}: ❌ (empty/small response)`);
            }
        } catch (e) {
            console.log(`  Request ${i + 1}: ❌ (${(e as Error).message})`);
        }
    }
    console.log(`  Success rate: ${successCount}/3`);

    console.log('\n═══════════════════════════════════════════════════════');
    console.log('  Tests complete');
    console.log('═══════════════════════════════════════════════════════\n');
}

main().catch(console.error);
