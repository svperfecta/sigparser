-- Rate limiting for the MCP sign-in form. D1 (not KV) so increments are atomic and
-- strongly consistent: parallel guesses cannot all read a stale count.
CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);
