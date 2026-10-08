const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');
const { chromium } = require('playwright');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.set('trust proxy', true);
const PORT = process.env.PORT || 3000;
const OUT = process.env.OUTPUT_DIR || '/data/results';
const API_KEY = process.env.API_KEY || '';
const UNIS = ['CCSU', 'AKTU'];
const sign = (rel) => crypto.createHmac('sha256', API_KEY).update(rel).digest('hex').slice(0, 32);
const tokenOk = (rel, t) => {
  if (!API_KEY || typeof t !== 'string') return false;
  const a = Buffer.from(sign(rel)); const b = Buffer.from(t);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
function requireKey(req, res, next) {
  if (!API_KEY) return res.status(503).json({ ok: false, error: 'API_KEY is not configured on the worker.' });
  const k = Buffer.from(String(req.get('x-api-key') || ''));
  const a = Buffer.from(API_KEY);
  if (k.length !== a.length || !crypto.timingSafeEqual(k, a)) return res.status(401).json({ ok: false, error: 'Invalid API key.' });
  next();
}

app.get('/health', (_req, res) => res.json({ ok: true, status: 'up', time: new Date().toISOString() }));

const safe = (s) => String(s ?? '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').replace(/\s+/g, ' ').trim();
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildName(template, s) {
  const raw = String(template || '{Roll No}_{Name}_{Marksheet Type}').replace(/\{([^}]+)\}/g, (_, k) => {
    const v = s[k.trim()];
    return v === undefined ? '' : String(v);
  });
  return safe(raw).slice(0, 180) || 'result';
}

async function firstVisible(page, selectors = []) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0 && (await loc.isVisible())) return loc;
    } catch (_) { /* try next selector */ }
  }
  return null;
}

async function hasCaptcha(page) {
  return page.evaluate(() => !!document.querySelector(
    'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .g-recaptcha, .h-captcha, ' +
    'img[src*="captcha" i], input[name*="captcha" i], input[id*="captcha" i]'
  ));
}

class CaptchaError extends Error {}

async function processStudent(browser, cfg, s, attempt) {
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 1800 } });
  let page = await context.newPage();
  try {
    await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    if (await hasCaptcha(page)) throw new CaptchaError('CAPTCHA detected on the page. Not bypassed.');

    const roll = await firstVisible(page, cfg.selectors.roll);
    if (!roll) throw new Error('Roll number field not found (check selectors).');
    await roll.fill(s['Roll No']);

    if (cfg.selectors.marksheet) {
      const sel = await firstVisible(page, cfg.selectors.marksheet);
      if (sel) {
        const opts = (await sel.locator('option').allTextContents()).map((t) => t.trim());
        const want = s['Marksheet Type'].trim().toLowerCase();
        const match = opts.find((o) => o.toLowerCase() === want) || opts.find((o) => o.toLowerCase().includes(want));
        if (!match) throw new Error(`Marksheet type "${s['Marksheet Type']}" not found in dropdown.`);
        await sel.selectOption({ label: match });
      }
    }

    if (cfg.selectors.dob) {
      const dob = await firstVisible(page, cfg.selectors.dob);
      if (dob) {
        const type = (await dob.getAttribute('type')) || '';
        const [dd, mm, yyyy] = s['DOB (DD/MM/YYYY)'].split('/');
        await dob.fill(type === 'date' ? `${yyyy}-${mm}-${dd}` : s['DOB (DD/MM/YYYY)']);
      }
    }

    const submit = await firstVisible(page, cfg.selectors.submit);
    if (submit) await submit.click(); else await roll.press('Enter');

    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await sleep(1500);
    const pages = context.pages();
    page = pages[pages.length - 1];

    if (await hasCaptcha(page)) throw new CaptchaError('CAPTCHA required after submit. Not bypassed.');
    const body = (await page.locator('body').innerText().catch(() => '')) || '';
    if (/no\s+(record|result)s?\s+found|invalid\s+(roll|dob|date)|data\s+not\s+found/i.test(body)) {
      throw new Error('Site reported no matching record.');
    }
    if (!cfg.allowRenderedPdf) throw new Error('No direct PDF link and rendered PDF is disabled.');

    const dir = path.join(OUT, cfg.university);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, s._fileName + '.pdf');
    await page.pdf({ path: filePath, format: 'A4', printBackground: true });
    return { filePath, source: 'Rendered Page' };
  } finally {
    await context.close().catch(() => {});
  }
}

async function runPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async (_, w) => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      out[i] = await fn(items[i], w + 1);
    }
  }));
  return out;
}

app.get('/files/:uni/:file', (req, res) => {
  const { uni, file } = req.params;
  if (!UNIS.includes(uni) || !/^[^\\/]+\.pdf$/i.test(file)) return res.status(400).send('Bad request');
  if (!tokenOk(`${uni}/${file}`, req.query.t)) return res.status(403).send('Forbidden');
  const full = path.join(OUT, uni, file);
  if (!fs.existsSync(full)) return res.status(404).send('Not found');
  res.download(full, file);
});

app.get('/zip/:id', (req, res) => {
  const { id } = req.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return res.status(400).send('Bad request');
  if (!tokenOk(`zip/${id}`, req.query.t)) return res.status(403).send('Forbidden');
  const listFile = path.join(OUT, '_batches', id + '.json');
  if (!fs.existsSync(listFile)) return res.status(404).send('Not found');
  const files = JSON.parse(fs.readFileSync(listFile, 'utf8'));
  res.attachment(`results_${id.slice(0, 8)}.zip`);
  const zip = archiver('zip', { zlib: { level: 6 } });
  zip.on('error', () => res.end());
  zip.pipe(res);
  for (const f of files) if (fs.existsSync(f)) zip.file(f, { name: path.basename(f) });
  zip.finalize();
});

app.post('/process', requireKey, async (req, res) => {
  let browser;
  try {
    const { config: cfg, students } = req.body || {};
    if (!cfg || !Array.isArray(students)) throw new Error('Invalid payload: config and students are required.');

    cfg.university = UNIS.includes(String(cfg.university).toUpperCase()) ? String(cfg.university).toUpperCase() : 'CCSU';
    fs.mkdirSync(path.join(OUT, cfg.university), { recursive: true });
    fs.mkdirSync(path.join(OUT, '_batches'), { recursive: true });
    const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
    const batchId = crypto.randomUUID();

    const used = new Set();
    for (const s of students) {
      let name = buildName(cfg.filenameTemplate, s);
      if (used.has(name.toLowerCase())) name += `_row${s.sourceRow}`;
      used.add(name.toLowerCase());
      s._fileName = name;
    }

    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });

    const results = await runPool(students, cfg.concurrency || 3, async (s, workerNo) => {
      const row = {
        'Roll No': s['Roll No'], Name: s.Name, 'Marksheet Type': s['Marksheet Type'],
        'DOB (DD/MM/YYYY)': s['DOB (DD/MM/YYYY)'], 'PDF File Name': s._fileName + '.pdf',
        'PDF File Path': '', 'PDF Source': '', 'Download URL': '', 'Error Message': '', Attempt: 0,
        Worker: `worker-${workerNo}`, 'Processed At': ''
      };
      const done = (o) => ({ ...row, ...o, 'Processed At': new Date().toISOString() });

      if (!s._valid) return done({ Status: 'Skipped', 'PDF File Name': '', 'Error Message': 'Missing: ' + s._missing.join(', ') });

      const target = path.join(OUT, cfg.university, s._fileName + '.pdf');
      const link = `${base}/files/${cfg.university}/${encodeURIComponent(s._fileName + '.pdf')}?t=${sign(cfg.university + '/' + s._fileName + '.pdf')}`;
      if (cfg.skipExisting && fs.existsSync(target)) {
        return done({ Status: 'Already Exists', 'PDF File Path': target, 'PDF Source': 'Existing File', 'Download URL': link });
      }

      let lastErr = '';
      for (let attempt = 1; attempt <= (cfg.maxAttempts || 3); attempt++) {
        try {
          const r = await processStudent(browser, cfg, s, attempt);
          return done({ Status: 'Downloaded', 'PDF File Path': r.filePath, 'PDF Source': r.source, 'Download URL': link, Attempt: attempt });
        } catch (e) {
          lastErr = String(e.message || e);
          if (e instanceof CaptchaError) return done({ Status: 'CAPTCHA Required', 'Error Message': lastErr, Attempt: attempt });
          await sleep(1500 * attempt);
        }
      }
      return done({ Status: 'Failed', 'Error Message': lastErr, Attempt: cfg.maxAttempts || 3 });
    });

    const okPaths = results.filter((r) => r['PDF File Path']).map((r) => r['PDF File Path']);
    fs.writeFileSync(path.join(OUT, '_batches', batchId + '.json'), JSON.stringify(okPaths));
    const zipUrl = `${base}/zip/${batchId}?t=${sign('zip/' + batchId)}`;
    const count = (st) => results.filter((r) => r.Status === st).length;
    res.json({
      ok: true,
      zipUrl,
      summary: {
        total: results.length, downloaded: count('Downloaded'), alreadyExists: count('Already Exists'),
        skipped: count('Skipped'), captcha: count('CAPTCHA Required'), failed: count('Failed')
      },
      results
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

app.listen(PORT, () => console.log(`result-worker listening on :${PORT}`));
