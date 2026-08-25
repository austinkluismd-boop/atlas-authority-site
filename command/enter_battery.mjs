/* enter_battery.mjs — the browser battery for the console door (OPS-32).
 *
 * Evolved 2026-08-25, the day the door was wired to the LIVE concierge
 * (OPS-31 deployed 08-24; the gate mints cookies). The old battery asserted
 * the door's honest "backend not deployed" refusal — that state no longer
 * exists on the committed page, so the battery now proves the wired walk:
 * a real card, presented to a real (local, throwaway-keyed) concierge,
 * becomes cookies and a console redirect in a real browser. The dead-
 * backend and bad-card refusals stay, because those states still exist.
 *
 *   python3 -m http.server 8901 --bind 127.0.0.1     # from the repo root
 *   (local concierge on 8902: THROWAWAY signing secret + gate key, with
 *    CORS_ALLOW_ORIGIN=http://127.0.0.1:8901 and cookie domain "host-only")
 *   ATLAS_TEST_LINK="<a card link whose base is /command/enter/>" \
 *   node command/enter_battery.mjs
 *
 * The link is minted from a THROWAWAY key (people.py card, test signing
 * secret) — never the estate's. PLAYWRIGHT_CHROMIUM overrides the browser.
 */
import { chromium } from 'playwright';

const LINK = process.env.ATLAS_TEST_LINK;
const BASE = process.env.ATLAS_TEST_BASE || 'http://127.0.0.1:8901/command/enter/';
const API  = process.env.CONCIERGE_API   || 'http://127.0.0.1:8902';
const LIVE_API = 'https://api.atlas-authority.com';
if (!LINK) { console.error('ATLAS_TEST_LINK required — see header.'); process.exit(2); }
const FRAG = (LINK.match(/#(atlas=[A-Za-z0-9_-]+)/) || [])[1];
if (!FRAG) { console.error('ATLAS_TEST_LINK carries no #atlas= fragment.'); process.exit(2); }
const R = []; const ok = (n, c, d='') => R.push([c ? 'PASS' : 'FAIL', n, d]);
const launch = {};
if (process.env.PLAYWRIGHT_CHROMIUM) launch.executablePath = process.env.PLAYWRIGHT_CHROMIUM;
const b = await chromium.launch(launch);
const ctx = await b.newContext();
const page = await ctx.newPage();
let collect = true;
const errs = [], reqs = [];
page.on('pageerror', e => { if (collect) errs.push(e.message); });
page.on('console', m => { if (collect && m.type() === 'error') errs.push(m.text()); });
page.on('request', r => { if (collect) reqs.push(r.url()); });
const rewire = api => page.evaluate(a => { CONCIERGE_API = a; }, api);
const state = () => page.locator('#state').innerText();

// 1 — no card: honest ask, zero requests beyond the page's own origin.
await page.goto(BASE, { waitUntil: 'networkidle' });
const origin = new URL(BASE).origin;
ok('door renders', (await page.locator('h1').textContent()).includes("practice's own people"));
ok('no card -> honest ask', (await state()).includes('No card presented'));
ok('page load makes zero non-origin requests', reqs.every(u => u.startsWith(origin)),
   reqs.filter(u => !u.startsWith(origin)).join(','));

// 2 — the committed page carries the LIVE concierge origin (the arming truth).
ok('door is wired to the live concierge',
   (await page.evaluate(() => CONCIERGE_API)) === LIVE_API);

// 3 — the wired walk: card -> local concierge -> cookies -> console redirect.
await rewire(API);
await page.evaluate(f => { location.hash = f; }, FRAG);
await page.waitForFunction(() =>
  document.getElementById('state').innerText.includes('Welcome back') ||
  document.getElementById('state').className.includes('err'), null, { timeout: 6000 });
const walk = await state();
ok('card accepted and welcomed by name', walk.includes('Welcome back'), walk.slice(0, 90));
ok('fragment stripped from the address bar', !page.url().includes('atlas='));
ok('keyring stored for the console',
   !!(await page.evaluate(() => localStorage.getItem('atlas.keyring'))));
const jar = await ctx.cookies(API + '/command/');
const names = jar.map(c => c.name).sort().join(',');
ok('the gate set all three CloudFront cookies',
   ['CloudFront-Key-Pair-Id', 'CloudFront-Policy', 'CloudFront-Signature']
     .every(n => jar.some(c => c.name === n)), names);
ok('cookies are HttpOnly + gate-scoped', jar.length > 0 &&
   jar.every(c => c.httpOnly && c.path === '/command'), names);
await page.waitForURL('**/command/', { timeout: 4000 });
collect = false;             // the console's own load is console_battery's business
ok('door redirected into the console', page.url().endsWith('/command/'));
ok('zero console errors on the door', errs.length === 0, errs.join(' | '));
ok('door spoke ONLY to its page + its concierge',
   reqs.every(u => u.startsWith(origin) || u.startsWith(API)),
   reqs.filter(u => !(u.startsWith(origin) || u.startsWith(API))).join(','));

// 4 — a forged card refuses kindly (valid shape, wrong signature -> 401).
await page.goto(BASE, { waitUntil: 'load' });
await page.evaluate(() => localStorage.clear());
await page.goto(BASE, { waitUntil: 'load' });
await rewire(API);
const forged = await page.evaluate(() => {
  const b64 = s => btoa(s).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const tok = `${b64(JSON.stringify({alg:'HS256',typ:'JWT'}))}.${b64(JSON.stringify({sub:'person:x',tenant_id:'t',role:'viewer',exp:exp,tv:1}))}.${b64('not-a-signature')}`;
  return b64(JSON.stringify({v:1,id:'x',name:'X',exp:exp,keys:{t:tok}}));
});
await page.evaluate(f => { location.hash = 'atlas=' + f; }, forged);
await page.waitForFunction(() =>
  document.getElementById('state').className.includes('err'), null, { timeout: 6000 });
ok('forged card -> honest retirement message', (await state()).includes('no longer valid'));

// 5 — a dead backend states unreachability, never a fake success.
await page.evaluate(() => localStorage.clear());
await page.goto(BASE, { waitUntil: 'load' });
await rewire('http://127.0.0.1:9');
await page.evaluate(f => { location.hash = f; }, FRAG);
await page.waitForFunction(() =>
  document.getElementById('state').className.includes('err'), null, { timeout: 9000 });
ok('dead backend -> honest unreachability', (await state()).includes('Could not reach'));

// 6 — garbage and expiry refuse kindly (unchanged from the null era).
await page.evaluate(() => localStorage.clear());
await page.goto(BASE + '#atlas=not-a-keyring', { waitUntil: 'load' });
await page.waitForTimeout(150);
ok('garbage refused kindly', (await state()).includes('could not be read'));
const expired = await page.evaluate(() => {
  const b64 = s => btoa(s).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const tok = `${b64(JSON.stringify({alg:'HS256'}))}.${b64(JSON.stringify({sub:'person:x',tenant_id:'t',role:'viewer',exp:1,tv:1}))}.sig`;
  return b64(JSON.stringify({v:1,id:'x',name:'X',exp:1,keys:{t:tok}}));
});
await page.goto(BASE + '#atlas=' + expired, { waitUntil: 'load' });
await page.waitForTimeout(150);
ok('expired refused with the reason', (await state()).includes('expired'));

// 7 — paste path refuses non-links.
await page.evaluate(() => localStorage.clear());
await page.goto(BASE, { waitUntil: 'load' });
await page.fill('#paste', 'nonsense with no marker');
await page.click('#go');
ok('paste without a marker refused', (await state()).includes("doesn't look like"));

await b.close();
let f = 0; for (const [s, n, d] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${d ? '  — ' + d : ''}`); }
console.log(`\n${R.length - f}/${R.length} door checks pass`);
process.exit(f ? 1 : 0);
