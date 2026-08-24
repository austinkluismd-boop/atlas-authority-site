/* attachment_battery.mjs — "here is the photo" must be one drag.
 *
 * Drives the real upload endpoint through a real browser: pick a photo, see
 * it as a chip with a thumbnail, watch an oversized file refused in the
 * browser before it costs a round trip, send it, and get back a change
 * PROPOSAL carrying the file's id — never a claim that anything shipped.
 * Then the important half: a file that claims to be a PNG and is actually
 * HTML is refused by the SERVER on its bytes, says nothing was stored, and
 * executes nothing.
 *
 *   ATLAS_TEST_LINK   an access link for a role that may propose photos
 *   CONCIERGE_API     a running concierge whose CORS origin matches the page
 *   fixtures: shot.png (a real PNG), big.png (>12 MB), evil.png (HTML)
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
const R=[]; const ok=(n,c,d='')=>R.push([c?'PASS':'FAIL',n,d]);
const LINK = process.env.ATLAS_TEST_LINK;
if (!LINK) { console.error('ATLAS_TEST_LINK is required — see the header.'); process.exit(2); }
const API = process.env.CONCIERGE_API || 'http://127.0.0.1:8902';
const launch = {};
if (process.env.PLAYWRIGHT_CHROMIUM) launch.executablePath = process.env.PLAYWRIGHT_CHROMIUM;
const b = await chromium.launch(launch);
const page = await (await b.newContext({viewport:{width:1440,height:1000}})).newPage();
const errs=[]; page.on('pageerror',e=>errs.push(e.message));
/* A deliberate refusal (the disguised-HTML upload) makes the browser log
   "Failed to load resource" for the 4xx. That is the browser's network log,
   not a page fault, and this battery EXPECTS those responses — so resource
   status lines are excluded while page errors and every other console error
   still count. */
page.on('console',m=>{
  if(m.type()!=='error') return;
  if(/Failed to load resource/i.test(m.text())) return;
  errs.push(m.text());
});
await page.goto(LINK,{waitUntil:'networkidle'});
await page.evaluate(a=>{CONFIG.conciergeApi=a; render();}, API);
await page.evaluate(()=>selectTenant('tsa-cuzalina'));
await page.waitForTimeout(400);

ok('the attach button is there', await page.locator('#chat-clip').count() === 1);
ok('attach is enabled for a marketing role', !(await page.locator('#chat-clip').isDisabled()));

// 1 — pick a real photo
await page.setInputFiles('#chat-file', 'shot.png');
await page.waitForTimeout(300);
ok('the file appears as a chip', await page.locator('#chat-files .fchip').count() === 1);
ok('an image gets a thumbnail', await page.locator('#chat-files .fchip img').count() === 1);

// 2 — the console refuses the obviously-wrong ones before sending
await page.setInputFiles('#chat-file', 'big.png');
await page.waitForTimeout(300);
const chips = await page.locator('#chat-files .fchip').allInnerTexts();
ok('an oversized file is refused in the browser',
   chips.some(c => /too big/i.test(c)), chips.join(' | '));
// remove the bad one
const badIdx = chips.findIndex(c => /too big/i.test(c));
await page.locator('#chat-files .fchip .fx').nth(badIdx).click();
await page.waitForTimeout(200);
ok('a chip can be removed', (await page.locator('#chat-files .fchip').count()) === 1);

// 3 — send it: uploads, then the proposal comes back
await page.fill('#chat-q', 'please use this photo on the gallery page');
await page.click('#chat-go');
await page.waitForFunction(() => document.querySelector('.prop-card'), null, {timeout:20000});
await page.waitForTimeout(500);
const log = await page.locator('#chat-log').innerText();
ok('my message shows the attachment', log.includes('shot.png'));
ok('the upload chip resolved', (await page.locator('.tool-chip.done').count()) > 0);
ok('a proposal came back', /change proposal/i.test(log));
ok('the proposal says nothing shipped', /nothing has changed/i.test(log));
ok('the strip is cleared after sending', (await page.locator('#chat-files .fchip').count()) === 0);

// 4 — the server refuses a file that is not what it claims
await page.setInputFiles('#chat-file', 'evil.png');
await page.waitForTimeout(300);
await page.fill('#chat-q', 'and this one');
await page.click('#chat-go');
await page.waitForTimeout(2500);
const log2 = await page.locator('#chat-log').innerText();
ok('disguised html is refused by the server',
   /do not match any accepted type|does not look like a photo/i.test(log2), log2.slice(-220));
ok('the refusal says nothing was stored', /nothing was stored/i.test(log2));
ok('no script ran from the disguised file', !(await page.evaluate(()=>window.__pwned)));

ok('zero console errors', errs.length===0, errs.join(' | '));
await page.locator('#s-ask').screenshot({path:'panel-attach.png'});
await b.close();
let f=0; for(const [s,n,d] of R){ if(s==='FAIL')f++; console.log(`${s}  ${n}${d?'  — '+d:''}`); }
console.log(`\n${R.length-f}/${R.length} attachment checks pass`);
process.exit(f?1:0);
