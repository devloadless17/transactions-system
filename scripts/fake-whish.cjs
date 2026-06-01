// Local fake of Whish Pay for end-to-end testing (no real creds needed).
// - Implements the 3 Whish endpoints under /itel-service/api
// - Asserts the 4 required headers are present (like real Whish)
// - Exposes a webhook sink + introspection endpoints for the test harness
const http = require('node:http');
const crypto = require('node:crypto');

const PORT = 4100;
const REQUIRED_HEADERS = ['channel', 'secret', 'websiteurl', 'user-agent'];
let collectStatus = 'success'; // mutable via /__set-status?s=failed|pending|success
const received = []; // webhook deliveries captured at /sink
const seenHeaders = []; // header sets seen on Whish calls (to verify the client)

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b));
  });
}
function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}
const ok = (data) => ({ status: true, code: null, dialog: null, extra: null, data });
const fail = (code, message) => ({ status: false, code, dialog: { message }, data: null });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  // --- introspection / control ---
  if (p === '/__received') return send(res, 200, { received, seenHeaders });
  if (p === '/__set-status') {
    collectStatus = url.searchParams.get('s') || 'success';
    return send(res, 200, { collectStatus });
  }
  if (p === '/__reset') {
    received.length = 0;
    seenHeaders.length = 0;
    collectStatus = 'success';
    return send(res, 200, { reset: true });
  }

  // --- webhook sink (the "company CRM") ---
  if (p === '/sink' && req.method === 'POST') {
    const body = await readBody(req);
    received.push({
      event: req.headers['x-whish-event'] ?? null,
      signature: req.headers['x-whish-signature'] ?? null,
      body,
    });
    return send(res, 200, { received: true });
  }

  // --- Whish API ---
  if (p.startsWith('/itel-service/api/')) {
    const missing = REQUIRED_HEADERS.filter((h) => !req.headers[h]);
    seenHeaders.push({ path: p, present: REQUIRED_HEADERS.filter((h) => !!req.headers[h]), missing });
    if (missing.length) return send(res, 200, fail('MISSING_HEADERS', `missing: ${missing.join(',')}`));

    if (p.endsWith('/payment/whish') && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      return send(res, 200, ok({ collectUrl: `http://localhost:${PORT}/pay/${body.externalId}` }));
    }
    if (p.endsWith('/payment/collect/status') && req.method === 'POST') {
      const phone = collectStatus === 'success' ? '96170902894' : null;
      return send(res, 200, ok({ collectStatus, payerPhoneNumber: phone }));
    }
    if (p.endsWith('/payment/account/balance') && req.method === 'GET') {
      return send(res, 200, ok({ balance: 12345.0 }));
    }
    return send(res, 200, fail('NOT_FOUND', p));
  }

  send(res, 404, { error: 'not found' });
});

server.listen(PORT, () => console.log(`fake-whish listening on http://localhost:${PORT}`));

// expose a tiny signature helper for the harness (not used by the server itself)
module.exports = {
  verify: (secret, body, header) =>
    header === `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`,
};
