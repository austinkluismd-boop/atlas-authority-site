/* injection_battery.mjs — hostile data, rendered.
 *
 * Three sources of text this console does not control: the engine export, a
 * model's answer, and an access link someone was sent. Each is poisoned here
 * and the page must render it as TEXT — no execution, no injected element, no
 * attribute breakout. Plus the CORS boundary: a console served from an origin
 * the concierge does not know cannot reach it at all.
 *
 *   POISON_BASE   a console served with a poisoned engine export (see below)
 *   ATLAS_TEST_LINK   an access link for the ALLOWED origin
 *   CONCIERGE_API     a concierge whose CORS origin is the allowed one
 *
 * Build the poisoned copy by copying the repo to a temp dir and writing XSS
 * payloads into command/data/engine-export.json string fields, then serving
 * it on a DIFFERENT port than the allowed origin.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
const R=[]; const ok=(n,c,d='')=>R.push([c?'PASS':'FAIL',n,d]);
const BASE = process.env.POISON_BASE || 'http://127.0.0.1:8903/command/';
const ALLOWED_LINK = process.env.ATLAS_TEST_LINK;
if (!ALLOWED_LINK) { console.error('ATLAS_TEST_LINK is required'); process.exit(2); }
const API = process.env.CONCIERGE_API || 'http://127.0.0.1:8902';
const LINK = ALLOWED_LINK.replace(new URL(ALLOWED_LINK).host, new URL(BASE).host);
const launch = {};
if (process.env.PLAYWRIGHT_CHROMIUM) launch.executablePath = process.env.PLAYWRIGHT_CHROMIUM;
const b = await chromium.launch(launch);
const page = await (await b.newContext()).newPage();
const errs=[]; page.on('pageerror',e=>errs.push(e.message));
let dialog=false; page.on('dialog',async d=>{dialog=true; await d.dismiss();});

// 1 — hostile ENGINE data
await page.goto(LINK, { waitUntil:'networkidle' });
await page.evaluate(() => selectTenant('tsa-cuzalina'));
await page.waitForTimeout(800);
ok('no script executed from engine data', !(await page.evaluate(() => window.__pwned)));
ok('no injected <script> element', (await page.locator('#s-metrics script, #s-work script, #s-activate script').count()) === 0);
ok('no injected <img> from a metric name', (await page.locator('#metrics-grid img').count()) === 0);
const metrics = await page.locator('#metrics-grid').innerText();
ok('the payload renders as literal text', metrics.includes('<img src=x'), metrics.slice(0,80));
// attribute-breakout attempt
await page.hover('#metrics-grid .mrow').catch(()=>{});
await page.waitForTimeout(200);
ok('no execution from an attribute breakout', !(await page.evaluate(() => window.__pwned)));
ok('no dialog was raised', !dialog);

// 2a — a console served from an UNEXPECTED origin cannot reach the concierge.
//      (The harness allows 127.0.0.1:8901; this page is 8903.)
await page.evaluate(api => { CONFIG.conciergeApi = api; render(); }, API);
await page.evaluate(() => selectTenant('tsa-cuzalina'));
await page.waitForTimeout(300);
await page.fill('#chat-q', 'XSSPLEASE');
await page.click('#chat-go');
await page.waitForTimeout(2000);
const blocked = await page.locator('#chat-log').innerText();
ok('a foreign origin is refused by CORS, not served',
   /could not reach|failed to fetch/i.test(blocked), blocked.slice(0,90));
ok('the refusal says nothing changed', /nothing was changed/i.test(blocked));

// 2b — hostile MODEL answer, from the ALLOWED origin
const page2 = await (await b.newContext()).newPage();
let pwned2 = false;
page2.on('pageerror', e => errs.push('p2: ' + e.message));
await page2.goto(ALLOWED_LINK, { waitUntil:'networkidle' });
await page2.evaluate(api => { CONFIG.conciergeApi = api; render(); }, API);
await page2.evaluate(() => selectTenant('tsa-cuzalina'));
await page2.waitForTimeout(300);
await page2.fill('#chat-q', 'XSSPLEASE');
await page2.click('#chat-go');
await page2.waitForFunction(() => /done\.|Could not/.test(
  document.querySelector('#chat-log .msg.at .body')?.textContent || ''), null, {timeout:15000});
await page2.waitForTimeout(400);
ok('no script executed from a model answer', !(await page2.evaluate(() => window.__pwned)));
ok('no injected element in the chat log',
   (await page2.locator('#chat-log img, #chat-log script').count()) === 0);
const chat = await page2.locator('#chat-log').innerText();
ok('the model payload renders as literal text',
   chat.includes('<img') && chat.includes('onerror'), chat.slice(0,140));

// 3 — hostile keyring name
const evil = await page.evaluate(() => {
  const head = btoa(JSON.stringify({alg:'HS256',typ:'JWT'})).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const body = btoa(JSON.stringify({sub:'person:x',tenant_id:'tsa-cuzalina',role:'viewer',
    exp: Math.floor(Date.now()/1000)+9999, tv:1})).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const ring = {v:1,id:'x',name:'<img src=q onerror="window.__pwned=1">',exp:9999999999,
                keys:{'tsa-cuzalina':`${head}.${body}.sig`}};
  return btoa(JSON.stringify(ring)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
});
await page.goto(BASE + '#atlas=' + evil, { waitUntil:'networkidle' });
await page.waitForTimeout(500);
ok('no script executed from a crafted access link', !(await page.evaluate(() => window.__pwned)));
const who = await page.locator('#who-current').textContent();
ok('the hostile name renders as text', who.includes('<IMG') || who.includes('<img'), who);

ok('zero page errors', errs.length===0, errs.join(' | '));
await b.close();
let f=0; for(const [s,n,d] of R){ if(s==='FAIL')f++; console.log(`${s}  ${n}${d?'  — '+d:''}`); }
console.log(`\n${R.length-f}/${R.length} injection checks pass`);
process.exit(f?1:0);
