// Decides what a failed sync attempt means for a queued offline action.
//
// Deliberately a plain CommonJS module with no imports. It used to live inside
// syncManager.js, which pulls in NetInfo and the API layer, so testing this
// logic meant mocking React Native. Pulled out here it is pure input/output
// and can be tested by Node directly.
//
// THE BUG THIS REPLACED:
// The original was a two-way split — no HTTP response meant "still offline,
// keep the action", and *anything else* meant "permanently failed". Tokens
// last 8 hours, so an officer who queued a day of verifications offline came
// back to a 401 on every item. A 401 has a response, so every queued action
// was marked failed, and nothing in the app ever read that status. A full day
// of fieldwork disappeared with no error shown.
//
// Three outcomes now:
//   retry  — transient. Stop the run, change nothing, try again later.
//   reauth — the session died. Stop, change nothing, ask for a login.
//   reject — the server looked at this payload and refused it. Park it as
//            failed WITH the reason, and surface it in the UI.

const RETRY = 'retry';
const REAUTH = 'reauth';
const REJECT = 'reject';

function classifyError(err) {
  if (!err || !err.response) return RETRY; // network unreachable

  const status = err.response.status;

  if (status === 401 || status === 403) return REAUTH;
  if (status === 408 || status === 429) return RETRY; // timeout / rate limited
  if (status >= 500) return RETRY;                    // server-side, likely temporary

  return REJECT;                                      // 400, 404, 409, 422, ...
}

module.exports = { classifyError, RETRY, REAUTH, REJECT };