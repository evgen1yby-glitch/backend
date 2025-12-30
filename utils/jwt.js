import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// Парсим время жизни в секундах (поддержка 30s/15m/24h/7d или просто число секунд)
const JWT_EXPIRES_IN_SECONDS = (() => {
  const env = process.env.JWT_EXPIRES_IN || '24h';
  const match = /^(\d+)([smhd])?$/i.exec(env);
  if (!match) return 24 * 3600;
  const value = parseInt(match[1], 10);
  const unit = (match[2] || 's').toLowerCase();
  const mult = { s: 1, m: 60, h: 3600, d: 86400 }[unit] || 1;
  return value * mult;
})();

/**
 * Генерирует JWT токен для доступа к комнате (используется для безопасного доступа)
 */
export function generateRoomToken(roomName, userInfo = {}) {
  const basePayload = {
    room: roomName,
    aud: 'jitsi',
    iss: 'luxemeet',
    sub: userInfo.id || 'anonymous',
    context: {
      user: {
        id: userInfo.id || 'anonymous',
        name: userInfo.name || 'User',
        email: userInfo.email || null,
      },
      features: {
        livestreaming: false,
        recording: false,
        transcription: false,
        'outbound-call': false,
      },
    },
    moderator: userInfo.isModerator || false,
  };

  const payload = { ...basePayload };
  delete payload.exp;
  delete payload.expiresIn;

  // Ставим exp вручную, чтобы не передавать expiresIn в опциях (избегаем конфликта)
  const now = Math.floor(Date.now() / 1000);
  payload.exp = now + JWT_EXPIRES_IN_SECONDS;

  return jwt.sign(payload, JWT_SECRET, {
    algorithm: 'HS256',
  });
}

/**
 * Проверяет JWT токен для доступа к комнате
 */
export function verifyRoomToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    throw new Error('Invalid or expired token');
  }
}

export { JWT_SECRET };

