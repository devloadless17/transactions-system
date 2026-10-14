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
//   /__set-refund?mode=ok|refuse|auth|lost|unknown
//   /__mark-refunded?externalId=…   (refunded outside the platform, e.g. in Whish's portal)
//
// Load-test mode (scripts/loadtest-whish.ts), like the real Whish:
//   /__set-status?s=live — each link is `pending` until paid, `success` once
//                          paid, and `failed` once it is FAKE_WHISH_LINK_TTL_MS
//                          old unpaid (default 5 minutes, as Whish).
//   /__pay?externalId=…  — the customer pays: the link is `success`, and the
//                          success callback is called, as Whish does.
//   /__stats             — links minted, paid, and callbacks sent.
//   FAKE_WHISH_LATENCY_MS (env) — added to every Whish API answer.
const http = require('node:http');
const crypto = require('node:crypto');

const PORT = Number(process.env.FAKE_WHISH_PORT ?? 4100);
const LATENCY_MS = Number(process.env.FAKE_WHISH_LATENCY_MS ?? 0);
const LINK_TTL_MS = Number(process.env.FAKE_WHISH_LINK_TTL_MS ?? 5 * 60_000);
// externalId → { mintedAt, paidAt, successCallbackUrl } (load-test mode)
const links = new Map();
const stats = { minted: 0, paid: 0, callbacks: 0, callbackErrors: 0, statusCalls: 0 };
const REQUIRED_HEADERS = ['channel', 'secret', 'websiteurl', 'user-agent'];
// success | failed | pending | refunded | unknown  (all five v1.4.4 values)
let collectStatus = 'success';
// ok           — normal responses
// indeterminate— `status:false` + code "500": v1.4.4 "pending, do not mark failed"
// http500      — a raw 5xx (e.g. a proxy), body not even JSON
let envelopeMode = 'ok';
// How POST /payment/whish/refund answers:
// ok      — refunds it (`status:true`, data null); collect/status then says `refunded`
// refuse  — a definite refusal; nothing is refunded
// auth    — refused as not authorized (`auth.error`, as the live sandbox answers
//           when refunds are not enabled for the account); nothing is refunded
// lost    — refunds it, but replies code "500" (the reply is lost): the client
//           must find the refund through collect/status, never refund again
// unknown — replies code "500" and does NOT refund: the outcome stays unknown
let refundMode = 'ok';
const refundedExternalIds = new Set();
const refundCalls = []; // every refund request body, for tests to count
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
  if (p === '/__received') return send(res, 200, { received, seenHeaders, refundCalls });
  if (p === '/__stats') return send(res, 200, { ...stats, links: links.size });
  if (p === '/__pay') {
    const id = url.searchParams.get('externalId');
    const link = id ? links.get(id) : undefined;
    if (!link) return send(res, 404, { error: 'unknown link' });
    if (Date.now() - link.mintedAt >= LINK_TTL_MS) return send(res, 409, { error: 'expired' });
    link.paidAt = link.paidAt ?? Date.now();
    stats.paid++;
    // Whish calls the success callback (a GET) once the payment succeeds.
    stats.callbacks++;
    fetch(link.successCallbackUrl)
      .then((r) => r.arrayBuffer())
      .catch(() => stats.callbackErrors++);
    return send(res, 200, { paidAt: link.paidAt });
  }
  if (p === '/__mark-refunded') {
    const id = url.searchParams.get('externalId');
    if (id) refundedExternalIds.add(id);
    return send(res, 200, { refunded: id });
  }
  if (p === '/__set-status') {
    collectStatus = url.searchParams.get('s') || 'success';
    return send(res, 200, { collectStatus });
  }
  if (p === '/__set-envelope') {
    envelopeMode = url.searchParams.get('mode') || 'ok';
    return send(res, 200, { envelopeMode });
  }
  if (p === '/__set-refund') {
    refundMode = url.searchParams.get('mode') || 'ok';
    return send(res, 200, { refundMode });
  }
  if (p === '/__reset') {
    received.length = 0;
    seenHeaders.length = 0;
    collectStatus = 'success';
    envelopeMode = 'ok';
    refundMode = 'ok';
    links.clear();
    for (const k of Object.keys(stats)) stats[k] = 0;
    refundedExternalIds.clear();
    refundCalls.length = 0;
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
    if (LATENCY_MS > 0) await new Promise((r) => setTimeout(r, LATENCY_MS));
    const missing = REQUIRED_HEADERS.filter((h) => !req.headers[h]);
    seenHeaders.push({
      path: p,
      present: REQUIRED_HEADERS.filter((h) => !!req.headers[h]),
      missing,
    });
    if (missing.length)
      return send(res, 200, fail('MISSING_HEADERS', `missing: ${missing.join(',')}`));

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
      if (collectStatus === 'live') {
        links.set(body.externalId, {
          mintedAt: Date.now(),
          paidAt: null,
          successCallbackUrl: body.successCallbackUrl,
        });
        stats.minted++;
      }
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
      stats.statusCalls++;
      // A refunded payment stays refunded, whatever the global status says.
      const link = collectStatus === 'live' ? links.get(body.externalId) : undefined;
      const status = refundedExternalIds.has(body.externalId)
        ? 'refunded'
        : link
          ? link.paidAt
            ? 'success'
            : Date.now() - link.mintedAt >= LINK_TTL_MS
              ? 'failed'
              : 'pending'
          : collectStatus;
      const phone = status === 'success' || status === 'refunded' ? '96170902894' : null;
      return send(res, 200, ok({ collectStatus: status, payerPhoneNumber: phone }));
    }
    if (p.endsWith('/payment/whish/refund') && req.method === 'POST') {
      // v1.4.3+. Documented body { currency, externalId, refundReason }; the
      // documented success reply is the envelope with data null.
      const body = JSON.parse((await readBody(req)) || '{}');
      if (typeof body.externalId !== 'string') {
        return send(res, 200, fail('request.invalid', 'externalId must be a String'));
      }
      refundCalls.push(body);
      // refundReason is OPTIONAL (v1.4.4). "Already processed": a duplicate
      // refund replays as a success with `retrieved: true`; an id Whish never
      // minted is `external_id.not_exists`.
      if (refundedExternalIds.has(body.externalId)) {
        return send(res, 200, { ...ok(null), retrieved: true });
      }
      if (knownExternalIds.size && !knownExternalIds.has(body.externalId)) {
        return send(res, 200, fail('external_id.not_exists', 'unknown externalId'));
      }
      if (refundMode === 'refuse') {
        return send(res, 200, fail('payment.not_refundable', 'This payment cannot be refunded'));
      }
      if (refundMode === 'auth') {
        return send(res, 200, fail('auth.error', 'An error has occurred, please try again later.'));
      }
      if (refundMode === 'unknown') {
        return send(res, 200, fail('500', 'service temporarily unavailable'));
      }
      refundedExternalIds.add(body.externalId);
      if (refundMode === 'lost') {
        return send(res, 200, fail('500', 'service temporarily unavailable'));
      }
      return send(res, 200, ok(null));
    }
    if (p.endsWith('/payment/account/balance') && req.method === 'GET') {
      return send(res, 200, ok({ balance: 12345.0 }));
    }
    return send(res, 200, fail('NOT_FOUND', p));
  }

  send(res, 404, { error: 'not found' });
});

// A load test reuses connections; keep them open between its calls.
server.keepAliveTimeout = 65_000;
server.listen(PORT, () => console.log(`fake-whish listening on http://localhost:${PORT}`));

// expose a tiny signature helper for the harness (not used by the server itself)
module.exports = {
  verify: (secret, body, header) =>
    header === `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`,
};
