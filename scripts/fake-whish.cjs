// Local fake of Whish Pay (v1.4.4) for end-to-end testing (no real creds needed).
// - Implements the Whish endpoints under /itel-service/api
// - Asserts the 4 required headers are present (like real Whish)
// - Exposes a webhook sink + introspection endpoints for the test harness
//
// This is the SUPPORTED way to develop against Whish locally: since v1.4.4 the
// real sandbox rejects localhost/loopback callback and redirect URLs with HTTP
// 403, so a dev machine can no longer complete a round trip against it.
//   WHISH_BASE_URL=http://localhost:4100/itel-service/api
// Control endpoints:
//   /__set-status?s=success|failed|pending|refunded|unknown
//   /__set-envelope?mode=ok|indeterminate|http500
const http = require('node:http');
const crypto = require('node:crypto');

const PORT = 4100;
const REQUIRED_HEADERS = ['channel', 'secret', 'websiteurl', 'user-agent'];
// success | failed | pending | refunded | unknown  (all five v1.4.4 values)
let collectStatus = 'success';
// ok           — normal responses
// indeterminate— `status:false` + code "500": v1.4.4 "pending, do not mark failed"
// http500      — a raw 5xx (e.g. a proxy), body not even JSON
let envelopeMode = 'ok';
const knownExternalIds = new Set();
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
// v1.4.4 envelope, including the additive `actions` / `retrieved` fields.
const ok = (data) => ({
  status: true,
  code: null,
  dialog: null,
  actions: null,
  extra: null,
  retrieved: false,
  data,
});
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
  if (p === '/__set-envelope') {
    envelopeMode = url.searchParams.get('mode') || 'ok';
    return send(res, 200, { envelopeMode });
  }
  if (p === '/__reset') {
    received.length = 0;
    seenHeaders.length = 0;
    collectStatus = 'success';
    envelopeMode = 'ok';
    knownExternalIds.clear();
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

    // Simulated upstream trouble. Both shapes mean "outcome unknown" to the
    // client, which must NOT mark the payment failed.
    if (envelopeMode === 'http500') {
      res.writeHead(502, { 'content-type': 'text/html' });
      return res.end('<html><body>502 Bad Gateway</body></html>');
    }
    if (envelopeMode === 'indeterminate') {
      return send(res, 200, fail('500', 'service temporarily unavailable'));
    }

    if (p.endsWith('/payment/whish') && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      // v1.4.4 documents externalId as a String — hold the client to it, the way
      // a strict upstream would.
      if (typeof body.externalId !== 'string') {
        return send(res, 200, fail('request.invalid', 'externalId must be a String'));
      }
      knownExternalIds.add(body.externalId);
      return send(res, 200, ok({ collectUrl: `http://localhost:${PORT}/pay/${body.externalId}` }));
    }
    if (p.endsWith('/payment/collect/status') && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (typeof body.externalId !== 'string') {
        return send(res, 200, fail('request.invalid', 'externalId must be a String'));
      }
      // A status lookup for an id we never minted — the documented v1.4.4 code.
      if (knownExternalIds.size && !knownExternalIds.has(body.externalId)) {
        return send(res, 200, fail('external_id.not_exists', 'unknown externalId'));
      }
      const phone = collectStatus === 'success' ? '96170902894' : null;
      return send(res, 200, ok({ collectStatus, payerPhoneNumber: phone }));
    }
    if (p.endsWith('/payment/whish/refund') && req.method === 'POST') {
      // v1.4.3+. Not implemented by the platform (it needs egress IP
      // whitelisting); answered here so a manual probe gets a truthful reply.
      return send(res, 200, { ...ok(null), retrieved: false });
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
