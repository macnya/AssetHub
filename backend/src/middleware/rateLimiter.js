const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');

// WHY THIS ISN'T KEYED BY IP ALONE
//
// It was, and every branch sits behind one NAT address — so five typos from
// anyone at Head Office locked out everyone at Head Office for fifteen
// minutes. The limit has to distinguish "this person keeps getting their own
// password wrong" from "this office is being attacked".
//
// Keying on email + IP does that. Keying on email alone would be worse: anyone
// could lock a colleague out of their account on purpose just by guessing at
// their address a few times.
//
// ipKeyGenerator is the library's own helper. A raw req.ip is unsafe for IPv6,
// where an attacker controls a whole /64 and could otherwise get a fresh key
// per request.
const perAccountLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    return `${ipKeyGenerator(req.ip)}|${email}`;
  },
  message: {
    error: 'Too many failed attempts for this account. Please try again in 15 minutes, or ask an IT Admin to reset your password.',
  },
});

// Second, looser net. The per-account limit above would let someone sit on one
// connection and try five passwords against each of hundreds of addresses in
// turn. This caps the whole office at a rate no honest person reaches — a
// branch of ten people mistyping twice each is still well inside it.
const perIpLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: {
    error: 'Too many failed sign-in attempts from this network. Please try again in 15 minutes.',
  },
});

// Applied in order: the broad net first, then the per-account one.
const loginLimiter = [perIpLoginLimiter, perAccountLoginLimiter];

// Changing a password takes the current one, so it accepts a guess and needs
// limiting too — but the caller is already authenticated, so it keys on who
// they are rather than where they are. Sharing an office should not mean
// sharing a limit.
const changePasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => (req.user ? `user:${req.user.id}` : ipKeyGenerator(req.ip)),
  message: {
    error: 'Too many attempts. Please try again in 15 minutes.',
  },
});

// perIpLoginLimiter is exported on its own for the service-token endpoint,
// which is keyed by caller rather than by account: there is no email to key on
// until the request has already been trusted.
module.exports = { loginLimiter, perIpLoginLimiter, changePasswordLimiter };