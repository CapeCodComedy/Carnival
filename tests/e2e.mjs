import { chromium } from 'playwright';
import { execSync } from 'child_process';
import fs from 'fs';

const BASE = 'http://127.0.0.1:8899';
const shots = '/root/carnival2/shots';
fs.mkdirSync(shots, { recursive: true });
const J = async (p, opts) => (await fetch(BASE + p, opts)).json();
const api = (p, body, headers) => J('/api/' + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(headers||{}) }, body: JSON.stringify(body) });
const A = (action, extra) => api('admin-api', { action, ...(extra||{}) }, { 'x-admin-token': 'greenroom' });
const ok = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL ***') + ' · ' + name); if (!cond) process.exitCode = 1; };

execSync('redis-cli flushdb');
const seeded = await A('seed');
ok('seed writes all hold categories', seeded.seeded && seeded.seeded.sponsor === 12 && seeded.seeded.comp === 1 && seeded.seeded.charity === 20 && seeded.seeded.marketing === 16 && seeded.seeded.companion === 4 && seeded.seeded.volunteer === 6);
const led = await A('ledger');
ok('ledger closes the 653 identity from the live store', led.identity && led.identity.closes && led.open === 590);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const errs = [];
const newPhone = async (w=390, h=844) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true });
  const p = await ctx.newPage();
  p.on('pageerror', e => errs.push(String(e).slice(0, 160)));
  await p.goto(BASE + '/');
  await p.fill('#gatePw', 'pitrow'); await p.click('#gateGo');
  await p.waitForTimeout(900);
  return p;
};

/* ---------- two phones: pick on A, watch it go dark on B ---------- */
const phoneA = await newPhone(1280, 900);
const phoneB = await newPhone(1280, 900);
const darkAtBoot = await phoneA.evaluate(() => unavailable.size);
ok('map boots from live store (59 holds dark)', darkAtBoot === 59);
await phoneA.evaluate(() => onSeatClick('H-101'));
await phoneA.evaluate(() => onSeatClick('H-102'));
await phoneA.waitForTimeout(600);
const cart = await phoneA.$eval('#totals', e => e.textContent.replace(/\s+/g, ' '));
ok('cart itemizes tickets + labeled pass-through fee + total', cart.includes('$88') && cart.includes('$6') && cart.includes('$94') && /keep none of it/i.test(cart));
await phoneA.screenshot({ path: shots + '/01-buyer-cart-fee.png' });
await phoneB.evaluate(() => refreshState());
await phoneB.waitForTimeout(700);
const bSees = await phoneB.evaluate(() => unavailable.has('H-101') && unavailable.has('H-102'));
ok('phone B sees A\'s picks go dark (live truth)', bSees);
const bDenied = await phoneB.evaluate(async () => { await onSeatClick('H-101'); return !selected.has('H-101'); });
ok('phone B cannot claim A\'s held seat', bDenied);

/* ---------- the race: both phones, same seat, same instant ---------- */
const [ra, rb] = await Promise.all([
  phoneA.evaluate(() => fetch('/api/claim-seats', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ holder: HOLDER, seats: ['J-107'], action: 'hold' }) }).then(r => r.status)),
  phoneB.evaluate(() => fetch('/api/claim-seats', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ holder: HOLDER, seats: ['J-107'], action: 'hold' }) }).then(r => r.status)),
]);
ok('deliberate race: exactly one winner (200) one loser (409)', [ra, rb].sort().join(',') === '200,409');

/* ---------- pay on A: mock Stripe -> webhook -> success page with QRs ---------- */
await phoneA.click('#checkoutBtn');
await phoneA.waitForURL('**/mock-pay.html**', { timeout: 8000 });
await phoneA.screenshot({ path: shots + '/02-mock-stripe.png' });
await phoneA.click('#pay');
await phoneA.waitForURL('**/success.html**', { timeout: 8000 });
await phoneA.waitForSelector('#done .ticket', { timeout: 8000 });
const tix = await phoneA.$$eval('#done .ticket', els => els.map(e => e.textContent));
ok('success page issues both seat tickets with codes', tix.length === 2 && /H-101/.test(tix.join()) && /CCC-/.test(tix.join()));
const recap = await phoneA.$eval('#recap', e => e.textContent);
ok('success recap itemizes fee separately', /pass-through/.test(recap) && /\$6\.00/.test(recap) && /\$94\.00/.test(recap));
await phoneA.screenshot({ path: shots + '/03-success-tickets.png' });
const code = (tix.join().match(/CCC-[A-Z0-9]{4}-[A-Z0-9]{5}/) || [])[0];

await phoneB.evaluate(() => refreshState());
await phoneB.waitForTimeout(500);
ok('sold seats dark on phone B after payment', await phoneB.evaluate(() => unavailable.has('H-101') && unavailable.has('H-102')));

/* ---------- abandon releases ---------- */
const hold = await api('claim-seats', { holder: 'aband1', seats: ['C-1'], action: 'hold' });
const co = await api('create-checkout', { holder: 'aband1', seats: ['C-1'] });
await J('/test/abandon?sid=' + co.sid);
const st1 = await J('/api/seats-state');
ok('abandoned checkout releases its seat', !st1.unavailable.includes('C-1'));

/* ---------- conflict -> auto-refund path (spec §5.2) ---------- */
const co2 = await api('create-checkout', { holder: 'victim', seats: ['D-101'] });
execSync("redis-cli hdel h:held D-101");                               // simulate the impossible: the hold vanishes mid-payment
await api('claim-seats', { holder: 'thief', seats: ['D-101'], action: 'hold' });
const wh = await J('/test/pay?sid=' + co2.sid);                        // victim's payment lands anyway
const o2 = await J('/api/order-status?sid=' + co2.sid);
ok('conflicted payment refunds automatically, never blind-sells', wh.conflict === 'D-101' && wh.refunded === true && o2.status === 'refunded_conflict');

/* ---------- refund reopens ---------- */
const co3 = await api('create-checkout', { holder: 'refunder', seats: ['E-101'] });
await J('/test/pay?sid=' + co3.sid);
const paidState = await J('/api/seats-state');
ok('paid seat is sold', paidState.unavailable.includes('E-101'));
const ord3 = await J('/api/order-status?sid=' + co3.sid);
await J('/test/refund?pi=pi_mock_' + co3.sid.slice(-8));
const st3 = await J('/api/seats-state');
ok('refund reopens the seat', !st3.unavailable.includes('E-101'));
const sDead = await api('scan', { code: ord3.codes['E-101'] });
ok('door: refunded ticket scans VOID', sDead.verdict === 'VOID' && /refunded/.test(sDead.why));

/* ---------- accessible flow: wc space + companion, $33 + $0 fee ---------- */
const wc = await api('create-checkout', { holder: 'wheels', seats: ['K-WA', 'K-15'], accessible: true });
await J('/test/pay?sid=' + wc.sid);
const wcOrder = await J('/api/order-status?sid=' + wc.sid);
ok('accessible booking: two seats at $33 each, fee waived', wcOrder.status === 'sold' && wcOrder.totalCents === 6600 && wcOrder.feeCents === 0);

/* ---------- one tier per transaction ---------- */
const mixed = await fetch(BASE + '/api/create-checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ holder: 'mixer', seats: ['C-2', 'D-2'] }) });
ok('mixed-tier checkout rejected (spec §6.1)', mixed.status === 400);

/* ---------- door: server-verified single scan ---------- */
const s1 = await api('scan', { code });
const s2 = await api('scan', { code });
const s3 = await api('scan', { code: 'CCC-AAAA-AAAAA' });
ok('door: first scan VALID with seat, re-scan ALREADY IN, tampered VOID',
   s1.verdict === 'VALID' && /H-10/.test(s1.seat) && s2.verdict === 'ALREADY IN' && s3.verdict === 'VOID');
const compR = await A('marksold', { seats: ['C-1'] });
const sComp = await api('scan', { code: compR.codes['C-1'] });
ok('comp ticket scans VALID at the door', sComp.verdict === 'VALID' && sComp.seat === 'C-1');

/* ---------- console ---------- */
const conPage = await browser.newPage();
conPage.on('pageerror', e => errs.push('console: ' + String(e).slice(0, 160)));
await conPage.goto(BASE + '/admin.html');
await conPage.fill('#gatePw', 'greenroom'); await conPage.click('#gateGo');
await conPage.waitForTimeout(1200);
const chip = await conPage.$eval('#countChip', e => e.textContent);
await conPage.click('[data-pane="seats"]'); await conPage.waitForTimeout(600);
const inspect = await conPage.evaluate(async () => { await onSeat('TA-108'); return document.getElementById('seatMsg').textContent; });
ok('console INSPECT names the comp seat', /HOUSE COMP/.test(inspect));
await conPage.screenshot({ path: shots + '/04-console-live.png' });
await conPage.click('[data-pane="dash"]'); await conPage.click('#proveBtn'); await conPage.waitForTimeout(600);
const proof = await conPage.$eval('#ledgerBox', e => e.textContent);
ok('console proves identity from live store', /"closes": true/.test(proof));
await conPage.screenshot({ path: shots + '/05-console-proof.png' });
console.log('console chip:', chip);

/* ---------- hold-TTL law: constants obey hardHold >= session ---------- */
const house = JSON.parse(fs.readFileSync('/root/carnival2/netlify/functions/lib/house.json', 'utf8'));
ok('hold-TTL law encoded: hardHold(' + house.hardHoldSec + ') >= session(' + house.stripeSessionSec + ')', house.hardHoldSec >= house.stripeSessionSec);

await browser.close();
console.log('\npageerrors:', errs.length ? errs : 'none');
console.log('E2E complete.');
