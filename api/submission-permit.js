// GitHub filename: api/submission-permit.js
// The secret is read only on the server. No dependencies or package.json needed.
const { createHmac } = require('node:crypto');
const { isIP } = require('node:net');
const ORIGIN = 'https://ohvault.vercel.app';
const TOKEN = /^[0-9a-f]{64}$/;

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const send = (status, body) => res.status(status).json(body);

  if (req.method !== 'POST') {
    return send(405, { error: 'Method not allowed.' });
  }
  if (req.headers.origin !== ORIGIN) {
    return send(403, { error: 'Origin not allowed.' });
  }

  const secret = process.env.VAULT_PROXY_SECRET;
  if (!secret || secret.length < 16) {
    return send(503, { error: 'Submission service is not configured.' });
  }

  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    return send(400, { error: 'Invalid request.' });
  }
  if (Number(req.headers['content-length']) > 2048) {
    return send(413, { error: 'Request is too large.' });
  }

  let body = req.body;
  try {
    if (Buffer.isBuffer(body)) body = body.toString('utf8');
    if (typeof body === 'string') {
      if (Buffer.byteLength(body) > 2048) {
        return send(413, { error: 'Request is too large.' });
      }
      body = JSON.parse(body);
    }
  } catch {
    return send(400, { error: 'Invalid request.' });
  }

  if (
    !body ||
    !['publish', 'report'].includes(body.action) ||
    typeof body.browser_token !== 'string' ||
    !TOKEN.test(body.browser_token)
  ) {
    return send(400, { error: 'Invalid request.' });
  }

  // Use Vercel's visitor address, never an address from the JSON body.
  const supplied = req.headers['x-vercel-forwarded-for'];
  if (typeof supplied !== 'string' || !isIP(supplied.trim())) {
    return send(503, { error: 'Visitor address could not be verified.' });
  }

  let ip = supplied.trim();
  if (isIP(ip) === 6) {
    ip = new URL('https://[' + ip + ']').hostname.slice(1, -1);
  }

  const hmac = value =>
    createHmac('sha256', secret).update(value).digest('hex');

  const { createHash } = require('node:crypto');
  const now = Math.floor(Date.now() / 1000);

  const payload = Buffer.from(JSON.stringify({
    v: 1,
    a: body.action,
    b: createHash('sha256').update(body.browser_token).digest('hex'),
    i: hmac('ohvault-ip-v1:' + ip),
    iat: now,
    exp: now + 120
  })).toString('base64url');

  return send(200, {
    permit: payload + '.' + hmac('ohvault-permit-v1:' + payload)
  });
};
