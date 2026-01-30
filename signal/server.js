import express from 'express';
import http from 'http';
import cors from 'cors';
import helmet from 'helmet';
import { Server as SocketIOServer } from 'socket.io';
import { createRequire } from 'module';
import dotenv from 'dotenv';
import createError from 'http-errors';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

const require = createRequire(import.meta.url);
const pkg = require('./package.json');

const PORT = parseInt(process.env.SIGNAL_PORT || '3010', 10);
const ALLOWED_ORIGIN = process.env.SIGNAL_CORS_ORIGIN || process.env.CORS_ORIGIN || '*';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: ALLOWED_ORIGIN, credentials: true }));
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: false
}));

const server = http.createServer(app);

const io = new SocketIOServer(server, {
  cors: {
    origin: ALLOWED_ORIGIN,
    methods: ['GET', 'POST'],
    credentials: true,
  }
});

// roomId -> { clients: Map<socketId, { userId, name, role }> }
const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { clients: new Map() });
  }
  return rooms.get(roomId);
}

io.on('connection', (socket) => {
  let currentRoomId = null;
  let currentUserId = null;

  socket.on('join', ({ roomId, userId, name, role }) => {
    if (!roomId) {
      socket.emit('error', { message: 'roomId required' });
      return;
    }
    const room = getRoom(roomId);
    currentRoomId = roomId;
    currentUserId = userId || uuidv4();

    room.clients.set(socket.id, { userId: currentUserId, name, role });
    socket.join(roomId);

    socket.to(roomId).emit('peer-joined', {
      socketId: socket.id,
      userId: currentUserId,
      name,
      role,
    });

    const peers = Array.from(room.clients.entries())
      .filter(([id]) => id !== socket.id)
      .map(([id, meta]) => ({
        socketId: id,
        userId: meta.userId,
        name: meta.name,
        role: meta.role,
      }));
    socket.emit('joined', { roomId, selfId: socket.id, peers });
  });

  socket.on('signal', ({ roomId, targetId, data }) => {
    if (!roomId || !targetId || !data) return;
    socket.to(targetId).emit('signal', {
      from: socket.id,
      data,
    });
  });

  socket.on('ice-candidate', ({ targetId, candidate }) => {
    if (!targetId || !candidate) return;
    socket.to(targetId).emit('ice-candidate', {
      from: socket.id,
      candidate,
    });
  });

  socket.on('mute', ({ roomId, muted }) => {
    if (!roomId) return;
    socket.to(roomId).emit('peer-mute', { peerId: socket.id, muted });
  });

  socket.on('hand-raise', ({ roomId, state }) => {
    if (!roomId) return;
    socket.to(roomId).emit('peer-hand-raise', { peerId: socket.id, state });
  });

  socket.on('leave', ({ roomId }) => {
    if (!roomId) return;
    socket.leave(roomId);
    const room = rooms.get(roomId);
    if (room) {
      room.clients.delete(socket.id);
      socket.to(roomId).emit('peer-left', { peerId: socket.id });
      if (room.clients.size === 0) {
        rooms.delete(roomId);
      }
    }
  });

  socket.on('disconnect', () => {
    if (currentRoomId) {
      const room = rooms.get(currentRoomId);
      if (room) {
        room.clients.delete(socket.id);
        socket.to(currentRoomId).emit('peer-left', { peerId: socket.id });
        if (room.clients.size === 0) {
          rooms.delete(currentRoomId);
        }
      }
    }
  });
});

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'luxemeet-signal',
    version: pkg.version,
    rooms: rooms.size,
  });
});

// 404
app.use((_req, _res, next) => next(createError(404)));

// Error handler
app.use((err, _req, res, _next) => {
  res.status(err.status || 500).json({ error: err.message || 'Internal error' });
});

server.listen(PORT, () => {
  console.log(`🚀 LuxeMeet signaling server listening on ${PORT}`);
  console.log(`🌐 CORS origin: ${ALLOWED_ORIGIN}`);
});
