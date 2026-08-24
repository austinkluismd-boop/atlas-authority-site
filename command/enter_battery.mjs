/* enter_battery.mjs — the browser battery for the console door (OPS-32).
 *
 *   python3 -m http.server 8901 --bind 127.0.0.1     # from the repo root
 *   ATLAS_TEST_LINK="<a card link whose base is /command/enter/>" \
 *   node command/enter_battery.mjs
 *
 * The link is minted from a THROWAWAY key (people.py card, test signing
 * secret) — never the estate's. PLAYWRIGHT_CHROMIUM overrides the browser.
 */
import { chromium } from 'playwright';

const LINK = process.env.ATLAS_TEST_LINK;
const BASE = process.env.ATLAS_TEST_BASE || 'http://127.0.0.1:8901/command/enter/';
if (!LINK) { console.error('ATLAS_TEST_LINK required — see header.'); process.exit(2); }
const R = []; const ok = (n, c, d='') => R.push([c ? 'PASS' : 'FAIL', n, d]);
const launch = {};
if (process.env.PLAYWRIGHT_CHROMIUM) launch.executablePath = process.env.PLAYWRIGHT_CHROMIUM;
const b = await chromium.launch(launch);
const page = await (await b.newContext()).newPage();
const errs = [], reqs = [];
page.on('pageerror', e => errs.push(e.message));
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
page.on('request', r => reqs.push(r.url()));

// 1 — no card: honest ask, zero third-party requests
await page.goto(BASE, { waitUntil: 'networkidle' });
const origin = new URL(BASE).origin;
ok('door renders', (await page.locator('h1').textContent()).includes("practice's own people"));
ok('no card -> honest ask', (await page.locator('#state').innerText()).includes('No card presented'));
ok('zero third-party requests', reqs.every(u => u.startsWith(origin)), reqs.filter(u => !u.startsWith(origin)).join(','));

// 2 — a real card, backend undeployed: card accepted, absence stated, keyring stored + stripped
await page.goto(LINK, { waitUntil: 'networkidle' });
await page.waitForTimeout(200);
const st = await page.locator('#state').innerText();
ok('backend absence stated honestly', st.includes('not deployed'), st.slice(0, 90));
ok("the person is told they did nothing wrong", st.includes('nothing you did was wrong') || st.includes('card is fine'));
ok('fragment stripped from the address bar', !page.url().includes('atlas='));
ok('keyring stored for the console', !!(await page.evaluate(() => localStorage.getItem('atlas.keyring'))));

// 3 — garbage and expiry refuse kindly
await page.goto(BASE + '#atlas=not-a-keyring', { waitUntil: 'networkidle' });
await page.waitForTimeout(150);
ok('garbage refused kindly', (await page.locator('#state').innerText()).includes('could not be read'));
const expired = await page.evaluate(() => {
  const b64 = s => btoa(s).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const tok = `${b64(JSON.stringify({alg:'HS256'}))}.${b64(JSON.stringify({sub:'person:x',tenant_id:'t',role:'viewer',exp:1,tv:1}))}.sig`;
  return b64(JSON.stringify({v:1,id:'x',name:'X',exp:1,keys:{t:tok}}));
});
await page.goto(BASE + '#atlas=' + expired, { waitUntil: 'networkidle' });
await page.waitForTimeout(150);
ok('expired refused with the reason', (await page.locator('#state').innerText()).includes('expired'));

// 4 — paste path
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.fill('#paste', 'nonsense with no marker');
await page.click('#go');
ok('paste without a marker refused', (await page.locator('#state').innerText()).includes("doesn't look like"));

ok('zero console errors', errs.length === 0, errs.join(' | '));
await b.close();
let f = 0; for (const [s, n, d] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${d ? '  — ' + d : ''}`); }
console.log(`\n${R.length - f}/${R.length} door checks pass`);
process.exit(f ? 1 : 0);
