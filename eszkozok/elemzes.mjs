// Weboldal-elemzés a megkeresésekhez (GitHub Actionben fut, ahol van szabad internet és Chrome).
// Bemenet: jeloltek/ÉÉÉÉ-HH-NN.json ({"sites":[{"website":"https://…"}]} vagy [{"website":…}])
// Kimenet: elemzes/ÉÉÉÉ-HH-NN/<domain>.json + <domain>-mobil.jpg + <domain>-gep.jpg
// Mér: Lighthouse mobil és asztali (teljesítmény, SEO, akadálymentesség, bevált gyakorlatok, betöltési idők),
// képernyőkép mobilon és gépen, HTTPS/SSL, átirányítás, alap SEO-elemek, robots/sitemap, technológia, stb.
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import dns from 'node:dns/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const [input, outDir, shardArg = '0/1'] = process.argv.slice(2);
const [shard, shards] = shardArg.split('/').map(Number);
const raw = JSON.parse(fs.readFileSync(input, 'utf8'));
const sites = (Array.isArray(raw) ? raw : raw.sites ?? raw.leads ?? []).map((s) => (typeof s === 'string' ? s : s.website)).filter(Boolean);
fs.mkdirSync(outDir, { recursive: true });
const domainOf = (u) => new URL(u).hostname.replace(/^www\./, '');
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';

async function lighthouse(url, preset) {
  const args = [
    url, '--quiet', '--output=json', '--output-path=stdout', `--chrome-path=${CHROME}`,
    '--chrome-flags=--headless=new --no-sandbox --disable-gpu', '--max-wait-for-load=45000',
    '--only-categories=performance,seo,accessibility,best-practices', '--locale=hu',
  ];
  if (preset === 'desktop') args.push('--preset=desktop');
  try {
    const { stdout } = await run('lighthouse', args, { maxBuffer: 200 * 1024 * 1024, timeout: 150000 });
    return JSON.parse(stdout);
  } catch (e) {
    return { error: (String(e.stderr || '').trim().split('\n').slice(-3).join(' ') || String(e.message || e)).slice(0, 400) };
  }
}

function summarize(lh) {
  if (!lh || lh.error || !lh.categories) return { error: lh?.error || 'Lighthouse nem futott le' };
  const a = lh.audits;
  const score = (k) => (lh.categories[k]?.score == null ? null : Math.round(lh.categories[k].score * 100));
  const dv = (k) => a[k]?.displayValue ?? null;
  // A nem teljesített fontos auditok, magyarul (a --locale=hu miatt), a megtakarítással együtt.
  const failed = Object.values(a)
    .filter((x) => x.score !== null && x.score < 0.9 && ['binary', 'numeric', 'metricSavings'].includes(x.scoreDisplayMode) && !['largest-contentful-paint', 'first-contentful-paint', 'speed-index', 'total-blocking-time', 'cumulative-layout-shift', 'interactive', 'max-potential-fid'].includes(x.id))
    .map((x) => ({ id: x.id, title: x.title, value: x.displayValue ?? null }))
    .slice(0, 40);
  return {
    scores: { performance: score('performance'), seo: score('seo'), accessibility: score('accessibility'), bestPractices: score('best-practices') },
    metrics: { fcp: dv('first-contentful-paint'), lcp: dv('largest-contentful-paint'), speedIndex: dv('speed-index'), tbt: dv('total-blocking-time'), cls: dv('cumulative-layout-shift') },
    pageWeight: dv('total-byte-weight'),
    failed,
    screenshot: a['final-screenshot']?.details?.data ?? null,
  };
}

function saveShot(dataUrl, file) {
  if (!dataUrl) return null;
  fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
  return path.basename(file);
}

function sslInfo(host) {
  return new Promise((resolve) => {
    const s = tls.connect({ host, port: 443, servername: host, timeout: 10000 }, () => {
      const c = s.getPeerCertificate();
      resolve({ ok: s.authorized, error: s.authorizationError ? String(s.authorizationError) : null, validTo: c?.valid_to ?? null, issuer: c?.issuer?.O ?? null });
      s.end();
    });
    s.on('error', (e) => resolve({ ok: false, error: e.code || e.message }));
    s.on('timeout', () => (s.destroy(), resolve({ ok: false, error: 'timeout' })));
  });
}

async function get(url, opts = {}) {
  try {
    const r = await fetch(url, { redirect: opts.redirect ?? 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (IsuCode site check)' }, signal: AbortSignal.timeout(20000) });
    return { status: r.status, url: r.url, location: r.headers.get('location'), headers: Object.fromEntries(r.headers), text: opts.body === false ? '' : await r.text() };
  } catch (e) {
    return { status: 0, error: e.cause?.code || e.message };
  }
}

function htmlChecks(html, finalUrl) {
  const m = (re) => html.match(re)?.[1]?.trim() ?? null;
  const count = (re) => (html.match(re) || []).length;
  const imgs = html.match(/<img\b[^>]*>/gi) || [];
  const year = new Date().getFullYear();
  const years = [...html.matchAll(/(?:©|&copy;|copyright)[^<]{0,40}?((?:19|20)\d\d)(?:\s*[-–]\s*((?:19|20)\d\d))?/gi)].map((x) => Number(x[2] || x[1]));
  const gen = m(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)/i) || m(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']generator/i);
  const tech = [
    /wp-content|wordpress/i.test(html) && 'WordPress', /webnode/i.test(html + finalUrl) && 'Webnode', /wix\.com|wixstatic/i.test(html) && 'Wix',
    /hupont/i.test(html + finalUrl) && 'HuPont', /unas\.(hu|eu)|unascdn/i.test(html) && 'UNAS', /shoprenter/i.test(html) && 'Shoprenter', /joomla/i.test(html) && 'Joomla',
    /squarespace/i.test(html) && 'Squarespace', /elementor/i.test(html) && 'Elementor', /jquery[.-]?1\.\d/i.test(html) && 'régi jQuery 1.x', /<table[^>]+width=/i.test(html) && 'táblázatos elrendezés',
    /\.swf|shockwave/i.test(html) && 'Flash',
  ].filter(Boolean);
  return {
    title: m(/<title[^>]*>([^<]*)<\/title>/i),
    metaDescription: m(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i) ?? m(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description/i),
    viewport: m(/<meta[^>]+name=["']viewport["'][^>]+content=["']([^"']*)/i),
    h1Count: count(/<h1[\s>]/gi),
    images: imgs.length,
    imagesWithoutAlt: imgs.filter((i) => !/\balt=["'][^"']+/i.test(i)).length,
    copyrightYears: years,
    copyrightOutdated: years.length ? Math.max(...years) < year - 1 : null,
    generator: gen,
    tech,
    telLinks: count(/href=["']tel:/gi),
    mailtoLinks: count(/href=["']mailto:/gi),
    forms: count(/<form[\s>]/gi),
    bookingWidget: /booked4|bookio|salonic|szalonom|calendly|simplybook|booksy|fresha|treatwell|idopontfoglal|időpontfoglal/i.test(html),
    mapEmbed: /google\.com\/maps|maps\.googleapis|openstreetmap/i.test(html),
    facebookLink: /facebook\.com\//i.test(html),
    schemaOrg: /application\/ld\+json/i.test(html),
    localBusinessSchema: /"@type"\s*:\s*"(LocalBusiness|Dentist|AutoRepair|BeautySalon|Restaurant|LegalService|AccountingService|HomeAndConstructionBusiness|LodgingBusiness|[A-Za-z]*Business)"/i.test(html),
    ogTags: /property=["']og:/i.test(html),
    favicon: /rel=["'][^"']*icon/i.test(html),
    analytics: /gtag\(|googletagmanager|google-analytics|fbq\(/i.test(html),
    cookieBanner: /cookie|süti/i.test(html),
    mixedContent: /(src|href)=["']http:\/\/(?!localhost)/i.test(html) && finalUrl.startsWith('https'),
    placeholderLinks: count(/href=["']#["']/gi),
    lorem: /lorem ipsum/i.test(html),
    comingSoon: /hamarosan|feltöltés alatt|fejlesztés alatt|under construction|coming soon/i.test(html),
    htmlKb: Math.round(Buffer.byteLength(html) / 1024),
  };
}


// A látható szöveg (menük, címek, bekezdések) és a belső linkek kigyűjtése, hogy a levél konkrét lehessen.
function pageText(html) {
  return html
    .replace(/<(script|style|noscript|svg|template)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/header|\/footer)[^>]*>/gi, '\n')
    .replace(/<h([1-6])[^>]*>/gi, (_, n) => `\n${'#'.repeat(Number(n))} `)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)))
    .replace(/[ \t\u00a0]+/g, ' ').replace(/\n\s*/g, '\n').replace(/\n{2,}/g, '\n').trim();
}

function internalLinks(html, base) {
  const out = new Map();
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      const u = new URL(m[1], base);
      if (u.hostname !== new URL(base).hostname || !/^https?:$/.test(u.protocol) || /\.(jpe?g|png|gif|webp|pdf|zip)$/i.test(u.pathname)) continue;
      u.hash = '';
      const label = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (!out.has(u.href)) out.set(u.href, label);
    } catch { /* hibás link */ }
  }
  return [...out].map(([url, label]) => ({ url, label }));
}

async function crawl(html, base) {
  const links = internalLinks(html, base);
  // A fontos aloldalak szövege (kapcsolat, szolgáltatások, árak, rólunk, referenciák), legfeljebb 4.
  const want = /kapcsolat|elerhet|contact|szolgalt|arak|arlista|rolunk|bemutatk|referenc|galeri|munkaink|foglal|idopont/i;
  const pick = links.filter((l) => want.test(l.url + ' ' + l.label.normalize('NFD').replace(/[\u0300-\u036f]/g, ''))).slice(0, 4);
  const pages = [];
  for (const l of pick) {
    const r = await get(l.url);
    if (r.text) pages.push({ url: l.url, label: l.label, status: r.status, text: pageText(r.text).slice(0, 5000) });
  }
  // Nem működő belső linkek (legfeljebb 30 ellenőrzése).
  const broken = [];
  await Promise.all(links.slice(0, 30).map(async (l) => {
    const r = await get(l.url, { body: false });
    if (r.status === 0 || r.status >= 400) broken.push({ url: l.url, label: l.label, status: r.status || r.error });
  }));
  return { menu: links.slice(0, 40), pages, broken };
}

async function analyze(website) {
  const url = website.startsWith('http') ? website : `https://${website}`;
  const domain = domainOf(url);
  const host = new URL(url).hostname;
  const out = { website: url, domain, checkedAt: new Date().toISOString() };
  const [page, httpRedirect, robots, sitemap, ssl] = await Promise.all([
    get(url),
    get(`http://${host}/`, { redirect: 'manual', body: false }),
    get(`https://${host}/robots.txt`),
    get(`https://${host}/sitemap.xml`, { body: false }),
    sslInfo(host),
  ]);
  out.http = { status: page.status, finalUrl: page.url ?? null, error: page.error ?? null, server: page.headers?.server ?? null };
  out.https = { ssl, httpRedirectsToHttps: /^https:/i.test(httpRedirect.location || '') };
  // Fogad-e levelet a domain (MX rekord)? Ha nincs, az ezen a domainen lévő e-mail-cím visszapattanna.
  out.mx = await dns.resolveMx(domain).then((r) => r.map((x) => x.exchange).slice(0, 3), () => []);
  out.robotsTxt = robots.status === 200 && !/<html/i.test(robots.text || '');
  out.sitemapXml = sitemap.status === 200;
  if (page.text) {
    out.html = htmlChecks(page.text, page.url || url);
    out.text = pageText(page.text).slice(0, 8000);
    try {
      Object.assign(out, await crawl(page.text, page.url || url));
    } catch (e) {
      out.crawlError = String(e.message || e);
    }
  }
  const target = page.url || url;
  const mobile = summarize(await lighthouse(target, 'mobile'));
  const desktop = summarize(await lighthouse(target, 'desktop'));
  out.mobileScreenshot = saveShot(mobile.screenshot, path.join(outDir, `${domain}-mobil.jpg`));
  out.desktopScreenshot = saveShot(desktop.screenshot, path.join(outDir, `${domain}-gep.jpg`));
  delete mobile.screenshot;
  delete desktop.screenshot;
  out.mobile = mobile;
  out.desktop = { scores: desktop.scores, metrics: desktop.metrics, pageWeight: desktop.pageWeight, error: desktop.error };
  if (!mobile.failed?.length && desktop.failed?.length) out.desktop.failed = desktop.failed;
  fs.writeFileSync(path.join(outDir, `${domain}.json`), JSON.stringify(out, null, 2));
  console.log(`${domain}: mobil ${mobile.scores?.performance ?? '–'} / SEO ${mobile.scores?.seo ?? '–'}`);
}

// Egyszerre egy oldal (a párhuzamos mérés elrontja a mobilmérést); a gyorsaságot a több gépre osztás adja (shard).
const queue = [...new Set(sites)].filter((_, i) => i % shards === shard);
for (const s of queue) {
  try {
    await analyze(s);
  } catch (e) {
    console.log(`${s}: hiba ${e.message}`);
  }
}
