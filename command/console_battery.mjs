/* console_battery.mjs — the browser battery for Atlas Command.
 *
 * The console laws say a console change is not done until a real browser has
 * loaded it: every view renders, zero console errors, zero third-party
 * requests. This file is that check, plus the whole per-person sign-in path.
 *
 *   python3 -m http.server 8901 --bind 127.0.0.1     # from the repo root
 *   ATLAS_TEST_LINK="$(cd ../practice-stack && \
 *      ATLAS_CONSOLE_URL=http://127.0.0.1:8901/command/ \
 *      python3 ops/aws/concierge/people.py card sam --json | \
 *      python3 -c 'import json,sys;print(json.load(sys.stdin)["link"])')" \
 *   node command/console_battery.mjs
 *
 * The link is minted from a THROWAWAY signing key for the test run — never
 * the estate's key, and never committed. Requires Playwright + a Chromium
 * binary (PLAYWRIGHT_CHROMIUM to override the path).
 */
import { chromium } from 'playwright';

const LINK = process.env.ATLAS_TEST_LINK;
const BASE = process.env.ATLAS_TEST_BASE || 'http://127.0.0.1:8901/command/';
if (!LINK) { console.error('ATLAS_TEST_LINK is required — see the header.'); process.exit(2); }
const results = [];
const ok = (n, c, d='') => { results.push([c?'PASS':'FAIL', n, d]); };

const openWho = async (page) => {
  await page.evaluate(() => {
    document.querySelector('#tsel-menu').classList.remove('open');
    document.querySelector('#who-menu').classList.add('open');
  });
  await page.waitForTimeout(60);
};
const launch = {};
if (process.env.PLAYWRIGHT_CHROMIUM) launch.executablePath = process.env.PLAYWRIGHT_CHROMIUM;
const b = await chromium.launch(launch);
const ctx = await b.newContext();
const page = await ctx.newPage();
const errors = [], requests = [];
page.on('console', m => { if (m.type()==='error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('pageerror: '+e.message));
page.on('request', r => requests.push(r.url()));

// 1 — public view: no session, zero third-party requests
await page.goto(BASE, { waitUntil:'networkidle' });
ok('public view loads', await page.locator('#who-current').textContent() === 'PUBLIC VIEW');
const origin = new URL(BASE).origin;
const thirdParty = requests.filter(u => !u.startsWith(origin));
ok('zero third-party requests at view time', thirdParty.length===0, thirdParty.join(','));
ok('ask panel invites sign-in',
   (await page.locator('#ask-panel').innerText()).includes('opens when you sign in'));
ok('ask input disabled when signed out', await page.locator('#ask-q').isDisabled());

// 2 — the magic link signs you in and disappears from the address bar
requests.length = 0;
await page.goto(LINK, { waitUntil:'networkidle' });
ok('link signs the person in', (await page.locator('#who-current').textContent()) === 'SAM');
ok('keyring stripped from the address bar', !page.url().includes('atlas='), page.url());
ok('no request carried the token', requests.every(u => !u.includes('atlas=')));
const stored = await page.evaluate(() => localStorage.getItem('atlas.keyring'));
ok('keyring stored in this browser only', !!stored && stored.includes('"id":"sam"'));

// 3 — identity + role surfaced honestly
await openWho(page);
const whoTxt = await page.locator('#who-menu').innerText();
ok('access panel names every practice + role',
   ['Tulsa Surgical Arts','Oklahoma Surgical Arts','Bella Roma Med Spa','TSA Wellness']
     .every(n => whoTxt.includes(n)) && whoTxt.includes('marketing'), whoTxt.slice(0,120));
await page.evaluate(() => document.querySelector('#who-menu').classList.remove('open'));

// 4 — every component view renders with the session live
for (const slug of ['estate','tsa-cuzalina','osa','bella-roma','tsa-wellness']) {
  await page.evaluate(s => selectTenant(s), slug);
  await page.waitForTimeout(120);
  const ask = await page.locator('#ask-panel').innerText();
  const shown = await page.locator('#tsel-current').textContent();
  ok(`view ${slug} renders`, shown.length>0 && ask.includes('Atlas Concierge'));
  if (slug !== 'estate') {
    ok(`view ${slug} states the role`, ask.includes('marketing'), ask.slice(0,90));
  }
}
await page.evaluate(() => selectTenant('tsa-cuzalina'));
const askTxt = await page.locator('#ask-panel').innerText();
ok('backend absence stated, no fake chat', askTxt.includes('not deployed yet'));
ok('ask input still disabled without a backend', await page.locator('#ask-q').isDisabled());

// 5 — selector badges the person's own practices
await page.click('#tsel-btn');
const menu = await page.locator('#tsel-menu').innerText();
ok('selector badges your access', (menu.match(/your access/gi)||[]).length === 4, menu.slice(0,150));
await page.keyboard.press('Escape');

// 6 — sign out clears the browser
await openWho(page);
await page.click('#who-out');
ok('sign out returns to public view',
   (await page.locator('#who-current').textContent()) === 'PUBLIC VIEW');
ok('sign out clears storage',
   (await page.evaluate(() => localStorage.getItem('atlas.keyring'))) === null);

// 7 — a garbage link is refused with a human sentence, not a crash
await page.goto(BASE + '#atlas=not-a-real-keyring', { waitUntil:'networkidle' });
await openWho(page);
ok('garbage link refused kindly',
   (await page.locator('#who-menu').innerText()).includes('could not be read'));
ok('still public view after a bad link',
   (await page.locator('#who-current').textContent()) === 'PUBLIC VIEW');

// 8 — an expired keyring is refused
const expired = await page.evaluate(() => {
  const head = btoa(JSON.stringify({alg:'HS256',typ:'JWT'})).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const body = btoa(JSON.stringify({sub:'person:sam',tenant_id:'osa',role:'viewer',exp:1,tv:1}))
    .replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const ring = {v:1,id:'sam',name:'Sam',exp:1,keys:{osa:`${head}.${body}.sig`}};
  return btoa(JSON.stringify(ring)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
});
await page.goto(BASE + '#atlas=' + expired, { waitUntil:'networkidle' });
await openWho(page);
ok('expired link refused with the reason',
   (await page.locator('#who-menu').innerText()).includes('expired'));

ok('zero console errors across the battery', errors.length===0, errors.join(' | '));

await b.close();
let fails = 0;
for (const [st,n,d] of results) { if (st==='FAIL') fails++; console.log(`${st}  ${n}${d?'  — '+d:''}`); }
console.log(`\n${results.length - fails}/${results.length} checks pass`);
process.exit(fails ? 1 : 0);