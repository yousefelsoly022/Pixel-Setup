const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ── Puppeteer (optional — graceful fallback if not installed) ──────────────
let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch (_) {}

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

// ══════════════════════════════════════════════════════════════════════════════
// TRACKING DEFINITIONS
// Each entry describes one platform, how to detect it in network requests,
// and how to extract IDs / event names / parameters from the request URLs.
// ══════════════════════════════════════════════════════════════════════════════
const TRACKING_DEFS = [
  {
    key: 'meta', name: 'Meta Pixel', icon: '👥', color: '#1877F2',
    // URLs that mean the pixel JS is loaded (client-side)
    loadPatterns:  ['connect.facebook.net/signals/fbevents', 'connect.facebook.net/en_US/fbevents'],
    // URLs that carry event hits
    eventPatterns: ['facebook.com/tr'],
    // URLs that indicate Conversions API / server-side
    serverPatterns: ['graph.facebook.com'],
    extractId:    (u) => { const m = u.match(/[?&]id=(\d{10,})/);         return m ? m[1] : null; },
    extractEvent: (u) => { const m = u.match(/[?&]ev=([^&]+)/);           return m ? decodeURIComponent(m[1]) : null; },
    extractParams:(u) => {
      // cd[param_name]=value is URL-encoded as cd%5Bparam_name%5D=value
      const raw = u.match(/cd%5B(.+?)%5D=([^&]*)/g) || [];
      return raw.map(p => { const x = p.match(/cd%5B(.+?)%5D=/); return x ? x[1] : null; }).filter(Boolean);
    },
    requiredParams: { Purchase: ['value','currency'], AddToCart: ['content_ids','content_type'], ViewContent: ['content_ids','content_type'] },
  },
  {
    key: 'gtm', name: 'Google Tag Manager', icon: '📦', color: '#246FDB',
    loadPatterns:  ['googletagmanager.com/gtm.js'],
    eventPatterns: [],
    serverPatterns: ['googletagmanager.com/a?id='],   // GTM server-side container
    extractId: (u) => { const m = u.match(/[?&]id=(GTM-[A-Z0-9]+)/); return m ? m[1] : null; },
  },
  {
    key: 'ga4', name: 'Google Analytics (GA4)', icon: '📊', color: '#E37400',
    loadPatterns:  ['googletagmanager.com/gtag/js?id=G-'],
    eventPatterns: ['google-analytics.com/g/collect', 'analytics.google.com/g/collect'],
    serverPatterns: [],
    extractId:    (u) => { const m = u.match(/[?&]tid=(G-[A-Z0-9]+)/) || u.match(/id=(G-[A-Z0-9]+)/); return m ? m[1] : null; },
    extractEvent: (u) => { const m = u.match(/[?&]en=([^&]+)/);   return m ? decodeURIComponent(m[1]) : null; },
    extractParams:(u) => {
      // GA4 sends params as ep.param or epn.param
      const keys = [];
      (u.match(/[?&]ep\.([^=]+)=/g) || []).forEach(p => { const x = p.match(/ep\.([^=]+)=/); if(x) keys.push(x[1]); });
      (u.match(/[?&]epn\.([^=]+)=/g) || []).forEach(p => { const x = p.match(/epn\.([^=]+)=/); if(x) keys.push(x[1]); });
      return keys;
    },
  },
  {
    key: 'google_ads', name: 'Google Ads', icon: '🎯', color: '#4285F4',
    loadPatterns:  ['googleadservices.com/pagead/conversion_async.js'],
    eventPatterns: ['googleads.g.doubleclick.net/pagead/viewthroughconversion', 'google.com/pagead/1p-conversion'],
    serverPatterns: [],
    extractId: (u) => { const m = u.match(/\/(\d{9,})\//); return m ? 'AW-' + m[1] : null; },
  },
  {
    key: 'tiktok', name: 'TikTok Pixel', icon: '🎵', color: '#010101',
    loadPatterns:  ['analytics.tiktok.com/i18n/pixel/static', 'analytics.tiktok.com/i18n/pixel/events.js'],
    eventPatterns: ['analytics.tiktok.com/i18n/pixel/events'],
    serverPatterns: ['business-api.tiktok.com'],
    extractId:    (u) => { const m = u.match(/sdkid=([A-Z0-9]+)/i) || u.match(/pixel_id=([A-Z0-9]+)/i); return m ? m[1] : null; },
    extractEvent: (u) => { const m = u.match(/[?&]event=([^&]+)/); return m ? decodeURIComponent(m[1]) : null; },
    extractParams:(u) => {
      const raw = u.match(/properties%5B([^\]%]+)(?:%5D)?=/g) || [];
      return raw.map(p => { const x = p.match(/properties%5B([^\]%]+)/); return x ? decodeURIComponent(x[1]) : null; }).filter(Boolean);
    },
    requiredParams: { Purchase: ['value','currency','content_id'], AddToCart: ['content_id','content_type'] },
  },
  {
    key: 'snapchat', name: 'Snapchat Pixel', icon: '👻', color: '#FFFC00',
    loadPatterns:  ['sc-static.net/scevent.min.js'],
    eventPatterns: ['tr.snapchat.com'],
    serverPatterns: [],
    extractId: (u) => { const m = u.match(/pixel_id=([a-f0-9-]{30,})/i); return m ? m[1] : null; },
  },
  {
    key: 'twitter', name: 'X (Twitter) Pixel', icon: '𝕏', color: '#000000',
    loadPatterns:  ['static.ads-twitter.com/uwt.js'],
    eventPatterns: ['t.co/i/adsct', 'analytics.twitter.com/i/adsct'],
    serverPatterns: [],
  },
  {
    key: 'linkedin', name: 'LinkedIn Insight', icon: '💼', color: '#0A66C2',
    loadPatterns:  ['snap.licdn.com/li.lms-analytics'],
    eventPatterns: ['px.ads.linkedin.com'],
    serverPatterns: [],
    extractId: (u) => { const m = u.match(/partner_id=(\d+)/); return m ? m[1] : null; },
  },
];

// ══════════════════════════════════════════════════════════════════════════════
// ANALYSE INTERCEPTED NETWORK REQUESTS
// ══════════════════════════════════════════════════════════════════════════════
function analyzeRequests(requests) {
  const found = {};

  requests.forEach(req => {
    const url = req.url || '';
    TRACKING_DEFS.forEach(def => {
      const allPatterns = [
        ...def.loadPatterns,
        ...(def.eventPatterns  || []),
        ...(def.serverPatterns || []),
      ];
      if (!allPatterns.some(p => url.includes(p))) return;

      if (!found[def.key]) {
        found[def.key] = {
          key:          def.key,
          name:         def.name,
          icon:         def.icon,
          color:        def.color || '#adc6ff',
          ids:          [],
          events:       [],
          isServerSide: false,
          requestCount: 0,
        };
      }

      const entry = found[def.key];
      entry.requestCount++;

      // Server-side indicator
      if ((def.serverPatterns || []).some(p => url.includes(p))) {
        entry.isServerSide = true;
      }

      // Extract pixel / tag ID
      if (def.extractId) {
        const id = def.extractId(url);
        if (id && !entry.ids.includes(id)) entry.ids.push(id);
      }

      // Extract event name + parameters
      if (def.extractEvent) {
        const evName = def.extractEvent(url);
        if (evName) {
          const params = def.extractParams ? def.extractParams(url) : [];
          const existing = entry.events.find(e => e.name === evName);
          if (existing) {
            params.forEach(p => { if (!existing.params.includes(p)) existing.params.push(p); });
          } else {
            entry.events.push({ name: evName, params });
          }
        }
      }
    });
  });

  return Object.values(found);
}

// ══════════════════════════════════════════════════════════════════════════════
// PUPPETEER SCANNER
// Opens the page in a real headless Chrome, intercepts every network request,
// waits for lazy-loaded scripts, then returns HTML + full request log + pixels.
// ══════════════════════════════════════════════════════════════════════════════
async function scanWithPuppeteer(targetUrl) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-zygote',
    ],
  });

  try {
    const page = await browser.newPage();

    // Realistic desktop UA
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    // Collect every outgoing request
    const requests = [];
    await page.setRequestInterception(true);
    page.on('request', req => {
      requests.push({ url: req.url(), method: req.method(), resourceType: req.resourceType() });
      req.continue();
    });

    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    // Extra wait — some pixels fire after user-interaction simulation or setTimeout
    await new Promise(r => setTimeout(r, 2500));

    const html        = await page.content();
    const resolvedUrl = page.url();

    await browser.close();

    const pixels = analyzeRequests(requests);

    return {
      html,
      url:        resolvedUrl,
      pixels,
      method:     'puppeteer',
      reqCount:   requests.length,
    };
  } catch (err) {
    await browser.close();
    throw err;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// HTTP FALLBACK (no Puppeteer)
// ══════════════════════════════════════════════════════════════════════════════
function fetchWithHttp(targetUrl, redirects) {
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    if (redirects > 5) { reject(new Error('Too many redirects')); return; }
    const lib = targetUrl.startsWith('https') ? https : http;
    lib.get(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EasyTrackScanner/1.0)' } }, res => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        const loc  = res.headers.location;
        const next = loc.startsWith('http') ? loc : new URL(loc, targetUrl).href;
        return resolve(fetchWithHttp(next, redirects + 1));
      }
      let html = '';
      res.setEncoding('utf8');
      res.on('data', c => { if (html.length < 800000) html += c; });
      res.on('end', () => resolve({ html, url: targetUrl, pixels: [], method: 'http' }));
    }).on('error', reject);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════════
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

function parseBody(req, cb) {
  let data = '';
  req.on('data', chunk => { data += chunk; });
  req.on('end', () => { try { cb(null, JSON.parse(data)); } catch (e) { cb(e); } });
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

// ══════════════════════════════════════════════════════════════════════════════
// HTTP SERVER
// ══════════════════════════════════════════════════════════════════════════════
http.createServer((req, res) => {

  // ── CORS preflight ──────────────────────────────────────────
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS' });
    res.end();
    return;
  }

  // ── GTM Import Proxy ─────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/gtm/import') {
    parseBody(req, (err, body) => {
      if (err) { sendJSON(res, 400, { error: 'Invalid JSON' }); return; }

      const accountId   = req.headers['x-gtm-account-id'];
      const containerId = req.headers['x-gtm-container-id'];
      const authToken   = req.headers['x-gtm-token'];

      if (!accountId || !containerId || !authToken) {
        sendJSON(res, 400, { error: 'Missing x-gtm-account-id, x-gtm-container-id, or x-gtm-token headers' });
        return;
      }

      const gtmApiBody = body.exportFormatVersion !== undefined
        ? { containerConfigJSON: JSON.stringify(body) }
        : body;

      const postData = JSON.stringify(gtmApiBody);
      const options  = {
        hostname: 'tagmanager.googleapis.com',
        path: `/tagmanager/v2/accounts/${accountId}/containers/${containerId}/versions:import`,
        method: 'POST',
        headers: {
          'Authorization':  `Bearer ${authToken}`,
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
      };

      const apiReq = https.request(options, apiRes => {
        let result = '';
        apiRes.on('data', c => { result += c; });
        apiRes.on('end', () => {
          res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json' });
          res.end(result);
        });
      });
      apiReq.on('error', e => sendJSON(res, 502, { error: e.message }));
      apiReq.write(postData);
      apiReq.end();
    });
    return;
  }

  // ── Pixel Scanner ─────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/scan-url') {
    parseBody(req, async (err, body) => {
      if (err) { sendJSON(res, 400, { error: 'Invalid JSON' }); return; }

      let targetUrl = (body && body.url) ? body.url.trim() : '';
      if (!targetUrl) { sendJSON(res, 400, { error: 'Missing url' }); return; }
      if (!/^https?:\/\//i.test(targetUrl)) targetUrl = 'https://' + targetUrl;

      try {
        let result;
        if (puppeteer) {
          result = await scanWithPuppeteer(targetUrl);
        } else {
          console.warn('[scanner] Puppeteer not available — falling back to HTTP fetch');
          result = await fetchWithHttp(targetUrl);
        }
        sendJSON(res, 200, result);
      } catch (e) {
        console.error('[scanner] Error:', e.message);
        sendJSON(res, 502, { error: e.message });
      }
    });
    return;
  }

  // ── Static File Server ────────────────────────────────────────
  const urlPath = req.url.split('?')[0];
  let filePath  = path.join(ROOT, urlPath === '/' ? '/index.html' : urlPath);

  function serveFile(fp) {
    fs.readFile(fp, (err, data) => {
      if (err) {
        if (!path.extname(fp)) return serveFile(fp + '.html');
        res.writeHead(404); res.end('Not found');
        return;
      }
      const ext = path.extname(fp);
      res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
      res.end(data);
    });
  }
  serveFile(filePath);

}).listen(PORT, () => {
  const mode = puppeteer ? '🟢 Puppeteer (headless Chrome)' : '🟡 HTTP fallback (install puppeteer for full analysis)';
  console.log(`Easy Track server running at http://localhost:${PORT}`);
  console.log(`Scanner mode: ${mode}`);
});
