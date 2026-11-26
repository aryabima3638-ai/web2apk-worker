const sessions = new Map();

function set(userId, state) {
  sessions.set(userId, state);
}

function get(userId) {
  return sessions.get(userId);
}

function clear(userId) {
  sessions.delete(userId);
}

module.exports = { set, get, clear };
