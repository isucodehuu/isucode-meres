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

// Egy-egy hibás szerverválasz a Node beépített fetch-ében (undici) néha elkapatlan kivételt dob, ami az egész
// mérőgépet leállítaná. Ilyenkor csak az adott oldal marad ki; a többi mérés folytatódik.
process.on('uncaughtException', (e) => console.error('[mérés] elkapatlan hiba, az oldal kimarad:', e?.message || e));
process.on('unhandledRejection', (e) => console.error('[mérés] elkapatlan ígéret-hiba:', e?.message || e));

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
    const r = await fetch(url, { redirect: opts.redirect ?? 'follow', headers: { 'User-Agent': opts.browser ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' : 'Mozilla/5.0 (IsuCode site check)', 'Accept-Language': 'hu-HU,hu;q=0.9' }, signal: AbortSignal.timeout(20000) });
    return { status: r.status, url: r.url, location: r.headers.get('location'), headers: Object.fromEntries(r.headers), text: opts.body === false ? '' : await r.text() };
  } catch (e) {
    return { status: 0, error: e.cause?.code || e.message };
  }
}

// A látogató számára LÁTHATÓ HTML: HTML-megjegyzések (<!-- -->), szkriptek, sablonok nélkül. Egy
// megjegyzésbe tett vagy JavaScript-sablonban lévő link (pl. href="${url}") a böngészőben nem jelenik meg –
// ha ezt is számolnánk, nem létező hibát írnánk le.
function visibleHtml(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|textarea)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
}

// A böngésző által ténylegesen kirajzolt oldal (a JavaScript lefutása után). Ebből számoljuk a linkeket és a
// kattintható telefonszámokat, mert sok oldal (pl. React, Vue, oldalépítők) a nyers HTML-ben mást mutat.
async function renderedDom(url) {
  try {
    const { stdout } = await run(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--window-size=412,915',
      '--virtual-time-budget=10000', '--user-agent=Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
      '--dump-dom', url], { maxBuffer: 50 * 1024 * 1024, timeout: 60000 });
    return stdout && stdout.length > 200 ? stdout : null;
  } catch {
    return null;
  }
}

function htmlChecks(rawHtml, finalUrl, rendered) {
  const html = rawHtml;
  const vis = visibleHtml(rendered || rawHtml);
  const m = (re) => html.match(re)?.[1]?.trim() ?? null;
  // a darabszámok a látható (lehetőleg kirenderelt) oldalból: ami megjegyzésben vagy szkriptben van, az nem számít
  const count = (re) => (vis.match(re) || []).length;
  const imgs = vis.match(/<img\b[^>]*>/gi) || [];
  const year = new Date().getFullYear();
  const years = [...vis.matchAll(/(?:©|&copy;|copyright)[^<]{0,40}?((?:19|20)\d\d)(?:\s*[-–]\s*((?:19|20)\d\d))?/gi)].map((x) => Number(x[2] || x[1]));
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
    // szövegként kiírt magyar telefonszámok száma a látható oldalon (ha 0, a „nem kattintható telefon” nem írható)
    phonesVisible: [...pageText(vis).matchAll(/[+(]?\d[\d \t\-/().]{6,18}\d/g)].filter((x) => {
      const d = x[0].replace(/\D/g, '');
      return (/^(36|06)/.test(d) && d.length >= 10 && d.length <= 11) || (d.length === 9 && /^(20|30|31|50|70|[2-9]\d)/.test(d)) || (d.length === 8 && /^1/.test(d));
    }).length,
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
    lorem: /lorem ipsum/i.test(vis),
    comingSoon: /hamarosan|feltöltés alatt|fejlesztés alatt|under construction|coming soon/i.test(pageText(vis)),
    rendered: !!rendered,
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

// A weboldalon nyilvánosan szereplő e-mail-címek (mailto-linkek és a szövegben lévők). A levél címzettje csak
// ezek közül kerülhet ki, így a feladatnak nem kell külön lekérnie az oldalt, és nem talál ki címet.
function extractEmails(html) {
  const src = html
    .replace(/&#64;|&#x40;|\[at\]|\(at\)|\s+\[kukac\]\s+|\s*\(kukac\)\s*/gi, '@')
    .replace(/&#46;|&#x2e;|\[dot\]|\(dot\)|\[pont\]|\(pont\)/gi, '.');
  const out = new Set();
  for (const m of src.matchAll(/mailto:([^"'?>\s]+)/gi)) out.add(decodeURIComponent(m[1]).trim().toLowerCase());
  for (const m of src.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) out.add(m[0].toLowerCase());
  return [...out].filter((e) => /^[^@\s]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e) && !/\.(png|jpe?g|gif|webp|svg|css|js)$/.test(e) && !/(sentry|wixpress|example\.|domain\.|email\.com|yourmail|sajat@)/.test(e));
}

function internalLinks(html, base) {
  const out = new Map();
  for (const m of visibleHtml(html).matchAll(/<a\b[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    // kitöltetlen sablonváltozó (${…}, {{…}}) vagy a Cloudflare e-mail-védelme: ezek a böngészőben működnek
    if (/\$\{|\{\{|%7B|^javascript:|\/cdn-cgi\//i.test(m[1])) continue;
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

async function crawl(html, base, rendered) {
  // ha megvan a kirajzolt oldal, abból: így csak a látogató által tényleg látott linkek számítanak
  const links = internalLinks(rendered || html, base);
  // A fontos aloldalak szövege (kapcsolat, szolgáltatások, árak, rólunk, referenciák), legfeljebb 4.
  const norm = (l) => l.url + ' ' + l.label.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const contactRe = /kapcsolat|elerhet|contact|impresszum|imprint|ceginfo|adatok/i;
  const want = /szolgalt|arak|arlista|rolunk|bemutatk|referenc|galeri|munkaink|foglal|idopont/i;
  // először a kapcsolat/impresszum oldalak (itt van az e-mail-cím), utána a többi fontos aloldal
  const pick = [...links.filter((l) => contactRe.test(norm(l))).slice(0, 2), ...links.filter((l) => !contactRe.test(norm(l)) && want.test(norm(l))).slice(0, 3)];
  const pages = [];
  const emails = [];
  for (const l of pick) {
    const r = await get(l.url);
    if (!r.text) continue;
    pages.push({ url: l.url, label: l.label, status: r.status, text: pageText(r.text).slice(0, 5000) });
    for (const e of extractEmails(r.text)) emails.push({ email: e, source: l.url });
  }
  // Nem működő belső linkek (legfeljebb 30 ellenőrzése).
  // „broken” = BIZTOSAN nem létező oldal: két külön kérésre (a második rendes böngészőként, 4 mp múlva) is 404/410.
  // Minden más (403, 429, 5xx, időtúllépés) csak „unsure”: lehet tűzfal, bejelentkezés vagy pillanatnyi hiba –
  // ezekről a levélben nem írunk.
  const broken = [];
  const unsure = [];
  await Promise.all(links.slice(0, 30).map(async (l) => {
    const r = await get(l.url, { body: false });
    if (r.status !== 0 && r.status < 400) return;
    await new Promise((ok) => setTimeout(ok, 4000));
    const r2 = await get(l.url, { browser: true });
    const s1 = r.status || r.error, s2 = r2.status || r2.error;
    if ([404, 410].includes(r.status) && [404, 410].includes(r2.status)) broken.push({ url: l.url, label: l.label, status: r2.status, checks: 2, inRenderedPage: !!rendered });
    else if (r2.status === 0 || r2.status >= 400) unsure.push({ url: l.url, label: l.label, status: [s1, s2] });
  }));
  return { menu: links.slice(0, 40), pages, broken, unsure, linksFrom: rendered ? 'kirajzolt oldal' : 'nyers HTML (nem ellenőrzött)', subEmails: emails };
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
    const rendered = await renderedDom(page.url || url);
    out.html = htmlChecks(page.text, page.url || url, rendered);
    out.text = pageText(page.text).slice(0, 8000);
    const found = extractEmails(page.text).map((e) => ({ email: e, source: page.url || url }));
    try {
      const c = await crawl(page.text, page.url || url, rendered);
      found.push(...c.subEmails);
      delete c.subEmails;
      Object.assign(out, c);
    } catch (e) {
      out.crawlError = String(e.message || e);
    }
    // Szándékosan korlátozott elérés (pl. „telefonszámunk csak regisztrált tagjainknak”): ilyenkor a hiányt
    // NEM írhatjuk le hibaként – a tulajdonos döntése.
    const allText = [out.text || '', ...(out.pages || []).map((p) => p.text)].join('\n');
    out.restrictedNotes = [...new Set((allText.match(/[^\n.!]{0,80}(csak|kizárólag)[^\n.!]{0,60}(regisztrált|bejelentkez|tag(ja|ok|jai)|előfizet)[^\n.!]{0,80}/gi) || []).map((x) => x.trim()))].slice(0, 6);
    // a weboldalon talált e-mail-címek (címenként az első forrás), és hogy a cím domainje fogad-e levelet
    const seen = new Map();
    for (const f of found) if (!seen.has(f.email)) seen.set(f.email, f.source);
    out.emails = [];
    for (const [email, source] of [...seen].slice(0, 8)) {
      const d = email.split('@')[1];
      const mx = d === domain ? out.mx ?? null : await dns.resolveMx(d).then((r) => r.length > 0, () => false);
      out.emails.push({ email, source, sameDomain: d === domain || d.endsWith('.' + domain), acceptsMail: Array.isArray(mx) ? mx.length > 0 : mx });
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
