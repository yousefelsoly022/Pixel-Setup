const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

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
  req.on('end', () => {
    try { cb(null, JSON.parse(data)); }
    catch (e) { cb(e); }
  });
}

http.createServer((req, res) => {
  // ── GTM Import Proxy ──────────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/gtm/import') {
    parseBody(req, (err, body) => {
      if (err) { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }

      const accountId   = req.headers['x-gtm-account-id'];
      const containerId = req.headers['x-gtm-container-id'];
      const authToken   = req.headers['x-gtm-token'];

      if (!accountId || !containerId || !authToken) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing x-gtm-account-id, x-gtm-container-id, or x-gtm-token headers' }));
        return;
      }

      // Wrap full container JSON as required by the GTM API
      const gtmApiBody = body.exportFormatVersion !== undefined
        ? { containerConfigJSON: JSON.stringify(body) }
        : body;

      const postData = JSON.stringify(gtmApiBody);
      const options = {
        hostname: 'tagmanager.googleapis.com',
        path: `/tagmanager/v2/accounts/${accountId}/containers/${containerId}/versions:import`,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${authToken}`,
          'Content-Type': 'application/json',
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
      apiReq.on('error', e => {
        res.writeHead(502);
        res.end(JSON.stringify({ error: e.message }));
      });
      apiReq.write(postData);
      apiReq.end();
    });
    return;
  }

  // ── URL Scanner Proxy ─────────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/scan-url') {
    parseBody(req, (err, body) => {
      if (err) { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }
      let targetUrl = (body && body.url) ? body.url.trim() : '';
      if (!targetUrl) { res.writeHead(400); res.end(JSON.stringify({ error: 'Missing url' })); return; }
      if (!/^https?:\/\//i.test(targetUrl)) targetUrl = 'https://' + targetUrl;

      const lib = targetUrl.startsWith('https') ? https : http;
      const options = { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EasyTrackScanner/1.0)' } };

      function fetchUrl(url, redirects) {
        if (redirects > 5) { res.writeHead(502); res.end(JSON.stringify({ error: 'Too many redirects' })); return; }
        lib.get(url, options, apiRes => {
          // Follow redirects
          if ([301,302,303,307,308].includes(apiRes.statusCode) && apiRes.headers.location) {
            const loc = apiRes.headers.location;
            const next = loc.startsWith('http') ? loc : new URL(loc, url).href;
            return fetchUrl(next, redirects + 1);
          }
          let html = '';
          apiRes.setEncoding('utf8');
          apiRes.on('data', c => { if (html.length < 600000) html += c; });
          apiRes.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ html, status: apiRes.statusCode, url }));
          });
        }).on('error', e => {
          res.writeHead(502);
          res.end(JSON.stringify({ error: e.message }));
        });
      }
      fetchUrl(targetUrl, 0);
    });
    return;
  }

  // ── Static File Server ────────────────────────────────────
  const urlPath = req.url.split('?')[0];
  let filePath = path.join(ROOT, urlPath === '/' ? '/index.html' : urlPath);

  function serveFile(fp) {
    fs.readFile(fp, (err, data) => {
      if (err) {
        // Try appending .html for extensionless URLs
        if (!path.extname(fp)) {
          return serveFile(fp + '.html');
        }
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const ext = path.extname(fp);
      res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
      res.end(data);
    });
  }
  serveFile(filePath);
}).listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
