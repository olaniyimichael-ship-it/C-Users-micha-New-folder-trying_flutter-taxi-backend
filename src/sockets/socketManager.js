const userSockets = new Map(); // userId -> socketId

function registerUser(userId, socketId) {
  userSockets.set(String(userId), socketId);
}

function unregisterSocket(socketId) {
  for (const [userId, sId] of userSockets.entries()) {
    if (sId === socketId) {
      userSockets.delete(userId);
      break;
    }
  }
}

function getSocketIdByUserId(userId) {
  return userSockets.get(String(userId));
}

module.exports = {
  registerUser,
  unregisterSocket,
  getSocketIdByUserId,
};
