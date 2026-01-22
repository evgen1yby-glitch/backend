import express from 'express';
import http from 'http';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { Server as SocketIOServer } from 'socket.io';
import { createWorker } from 'mediasoup';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

const PORT = parseInt(process.env.SFU_PORT || '4001', 10);
const ALLOWED_ORIGIN = process.env.SFU_CORS_ORIGIN || process.env.CORS_ORIGIN || '*';
const BASE_PATH = process.env.SFU_BASE_PATH || '/sfu';
const IO_PATH = process.env.SFU_IO_PATH || `${BASE_PATH}/socket.io`;
const ANNOUNCED_IP = process.env.SFU_ANNOUNCED_IP || process.env.SFU_PUBLIC_IP || undefined;

// Mediasoup workers pool for scalability (100+ participants)
const workers = [];
let nextWorkerIdx = 0;
const NUM_WORKERS = parseInt(process.env.SFU_NUM_WORKERS || '4', 10); // Use multiple workers for 100+ participants
const rooms = new Map(); // roomId -> { router, peers: Map<peerId, { transports: Set, producers: Set, consumers: Set }>, workerIdx }

async function createMediasoupWorkers() {
  const numCpus = require('os').cpus().length;
  const workersToCreate = Math.min(NUM_WORKERS, numCpus);
  
  console.log(`🚀 Creating ${workersToCreate} mediasoup workers (CPUs: ${numCpus})`);
  
  for (let i = 0; i < workersToCreate; i++) {
    const worker = await createWorker({
      logLevel: 'warn',
      rtcMinPort: parseInt(process.env.SFU_RTC_MIN_PORT || '40000', 10) + (i * 2500),
      rtcMaxPort: parseInt(process.env.SFU_RTC_MIN_PORT || '40000', 10) + ((i + 1) * 2500) - 1,
    });
    
    worker.on('died', () => {
      console.error(`❌ Mediasoup worker ${i} died, restarting...`);
      workers[i] = null;
      // Auto-restart worker
      setTimeout(() => restartWorker(i), 2000);
    });
    
    workers.push(worker);
    console.log(`✅ Mediasoup worker ${i} created (ports: ${40000 + i * 2500}-${40000 + (i + 1) * 2500 - 1})`);
  }
}

async function restartWorker(idx) {
  try {
    const worker = await createWorker({
      logLevel: 'warn',
      rtcMinPort: 40000 + (idx * 2500),
      rtcMaxPort: 40000 + ((idx + 1) * 2500) - 1,
    });
    workers[idx] = worker;
    console.log(`✅ Mediasoup worker ${idx} restarted`);
  } catch (e) {
    console.error(`❌ Failed to restart worker ${idx}:`, e);
  }
}

function getNextWorker() {
  // Round-robin worker selection
  const worker = workers[nextWorkerIdx];
  nextWorkerIdx = (nextWorkerIdx + 1) % workers.length;
  return { worker, workerIdx: nextWorkerIdx };
}

async function getOrCreateRoom(roomId) {
  if (rooms.has(roomId)) return rooms.get(roomId);
  
  // Codecs optimized for large conferences (100+ participants)
  const mediaCodecs = [
    {
      kind: 'audio',
      mimeType: 'audio/opus',
      clockRate: 48000,
      channels: 2,
      parameters: {
        useinbandfec: 1,
        usedtx: 1, // Discontinuous transmission for bandwidth saving
        maxaveragebitrate: 32000, // Limit audio bitrate
      },
    },
    {
      kind: 'video',
      mimeType: 'video/VP8',
      clockRate: 90000,
      parameters: {
        'x-google-start-bitrate': 300, // Lower start bitrate for many participants
      },
    },
    {
      kind: 'video',
      mimeType: 'video/VP9',
      clockRate: 90000,
      parameters: {
        'profile-id': 2,
        'x-google-start-bitrate': 300,
      },
    },
    {
      kind: 'video',
      mimeType: 'video/H264',
      clockRate: 90000,
      parameters: {
        'packetization-mode': 1,
        'profile-level-id': '42e01f',
        'level-asymmetry-allowed': 1,
        'x-google-start-bitrate': 300,
      },
    },
  ];
  
  const { worker, workerIdx } = getNextWorker();
  const router = await worker.createRouter({ mediaCodecs });
  
  const room = {
    router,
    peers: new Map(),
    workerIdx,
    createdAt: Date.now(),
  };
  rooms.set(roomId, room);
  console.log(`🏠 Room ${roomId} created on worker ${workerIdx}`);
  return room;
}

function getTransportConfig(isProducer = false) {
  return {
    listenIps: [
      { ip: '0.0.0.0', announcedIp: ANNOUNCED_IP },
    ],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    // Lower bitrate for large conferences - will be adjusted per consumer
    initialAvailableOutgoingBitrate: isProducer ? 800_000 : 600_000,
    // Limit number of streams per transport
    maxIncomingBitrate: 1_500_000,
    // Enable SCTP for data channels
    enableSctp: true,
    numSctpStreams: { OS: 1024, MIS: 1024 },
  };
}

function createPeer(room, peerId) {
  if (!room.peers.has(peerId)) {
    room.peers.set(peerId, {
      transports: new Set(),
      producers: new Set(),
      consumers: new Set(),
      name: 'Участник', // Храним имя участника
    });
  }
  return room.peers.get(peerId);
}

const app = express();
app.use(express.json());
app.use(cors({ origin: ALLOWED_ORIGIN, credentials: true }));
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: false,
}));

const server = http.createServer(app);
const io = new SocketIOServer(server, {
  path: IO_PATH,
  cors: {
    origin: ALLOWED_ORIGIN,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

io.on('connection', (socket) => {
  let currentRoomId = null;
  let currentPeerId = socket.id;
  let currentPeerName = 'Участник'; // Храним имя текущего участника

  socket.on('join', async ({ roomId, name }) => {
    try {
      if (!roomId) {
        socket.emit('error', { message: 'roomId required' });
        return;
      }
      currentRoomId = roomId;
      currentPeerName = name || currentPeerName;
      const room = await getOrCreateRoom(roomId);
      const peer = createPeer(room, currentPeerId);
      peer.name = currentPeerName; // Сохраняем имя в структуре peer
      socket.join(roomId);
      
      // Уведомляем других участников о присоединении
      socket.to(roomId).emit('peer-joined', { 
        peerId: currentPeerId, 
        name: currentPeerName 
      });
      
      socket.emit('joined', { roomId, peerId: currentPeerId });
    } catch (e) {
      console.error('join error', e);
      socket.emit('error', { message: 'join failed' });
    }
  });

  socket.on('create-transport', async (_, callback) => {
    try {
      if (!currentRoomId) return callback({ error: 'no room' });
      const room = rooms.get(currentRoomId);
      const transport = await room.router.createWebRtcTransport(getTransportConfig());
      createPeer(room, currentPeerId).transports.add(transport);

      transport.on('dtlsstatechange', (state) => {
        if (state === 'closed') transport.close();
      });
      transport.on('icestatechange', (state) => {
        if (state === 'failed' || state === 'disconnected') {
          console.warn('ICE state', state);
        }
      });

      callback({
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      });
    } catch (e) {
      console.error('create-transport error', e);
      callback({ error: 'create-transport failed' });
    }
  });

  socket.on('connect-transport', async ({ transportId, dtlsParameters }, callback) => {
    try {
      if (!currentRoomId) return callback({ error: 'no room' });
      const room = rooms.get(currentRoomId);
      const peer = room.peers.get(currentPeerId);
      const transport = [...peer.transports].find((t) => t.id === transportId);
      if (!transport) return callback({ error: 'transport not found' });
      await transport.connect({ dtlsParameters });
      callback({ connected: true });
    } catch (e) {
      console.error('connect-transport error', e);
      callback({ error: 'connect-transport failed' });
    }
  });

  socket.on('produce', async ({ transportId, kind, rtpParameters }, callback) => {
    try {
      if (!currentRoomId) return callback({ error: 'no room' });
      const room = rooms.get(currentRoomId);
      const peer = room.peers.get(currentPeerId);
      const transport = [...peer.transports].find((t) => t.id === transportId);
      if (!transport) return callback({ error: 'transport not found' });
      const producer = await transport.produce({ kind, rtpParameters });
      peer.producers.add(producer);

      // уведомить других участников о новом продюсере
      console.log(`📤 Broadcasting new-producer: ${producer.id} (${kind}) from ${currentPeerId} (${currentPeerName})`);
      socket.to(currentRoomId).emit('new-producer', {
        producerId: producer.id,
        peerId: currentPeerId,
        kind,
        name: currentPeerName, // КРИТИЧНО: передаем имя участника
      });

      producer.on('transportclose', () => {
        peer.producers.delete(producer);
      });

      callback({ id: producer.id });
    } catch (e) {
      console.error('produce error', e);
      callback({ error: 'produce failed' });
    }
  });

  socket.on('consume', async ({ producerId, rtpCapabilities, transportId }, callback) => {
    try {
      if (!currentRoomId) return callback({ error: 'no room' });
      const room = rooms.get(currentRoomId);
      if (!room.router.canConsume({ producerId, rtpCapabilities })) {
        return callback({ error: 'cannot consume' });
      }
      const peer = room.peers.get(currentPeerId);
      
      // КРИТИЧНО: Используем transportId из запроса, если передан
      let transport;
      if (transportId) {
        transport = [...peer.transports].find((t) => t.id === transportId);
        if (!transport) {
          console.error(`❌ Transport ${transportId} not found for peer ${currentPeerId}`);
          return callback({ error: 'transport not found' });
        }
      } else {
        // Fallback: ищем recv транспорт (второй транспорт этого пира)
        transport = [...peer.transports][peer.transports.size > 1 ? 1 : 0];
        if (!transport) {
          console.error(`❌ No recv transport found for peer ${currentPeerId}`);
          return callback({ error: 'no transport' });
        }
      }
      
      console.log(`📥 Consuming producer ${producerId} on transport ${transport.id} for peer ${currentPeerId}`);
      
      const consumer = await transport.consume({
        producerId,
        rtpCapabilities,
        paused: false,
      });
      peer.consumers.add(consumer);

      consumer.on('transportclose', () => {
        peer.consumers.delete(consumer);
      });
      consumer.on('producerclose', () => {
        peer.consumers.delete(consumer);
        socket.emit('producer-closed', { producerId });
      });

      console.log(`✅ Consumer created: ${consumer.id} (kind: ${consumer.kind}) for producer ${producerId}`);
      
      callback({
        id: consumer.id,
        producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
      });
    } catch (e) {
      console.error('consume error', e);
      callback({ error: 'consume failed' });
    }
  });

  // Обработка обновления имени участника
  socket.on('update-name', ({ name }) => {
    if (name && name.trim()) {
      currentPeerName = name.trim();
      
      // Сохраняем имя в структуре peer
      if (currentRoomId) {
        const room = rooms.get(currentRoomId);
        if (room) {
          const peer = room.peers.get(currentPeerId);
          if (peer) {
            peer.name = currentPeerName;
          }
        }
        
        // Уведомляем других участников об обновлении имени
        socket.to(currentRoomId).emit('peer-name-updated', {
          peerId: currentPeerId,
          name: currentPeerName,
        });
      }
    }
  });

  // Обработка сообщений чата
  socket.on('chat-message', ({ message, senderName }) => {
    if (!currentRoomId) {
      console.warn(`⚠️ chat-message: peer ${currentPeerId} not in room`);
      return;
    }
    
    if (!message || !message.trim()) {
      console.warn(`⚠️ chat-message: empty message from ${currentPeerId}`);
      return; // Игнорируем пустые сообщения
    }
    
    // Создаем сообщение с ID и timestamp
    const chatMessage = {
      id: uuidv4(),
      senderName: senderName || currentPeerName,
      message: message.trim(),
      timestamp: new Date().toISOString(),
      peerId: currentPeerId,
    };
    
    const room = rooms.get(currentRoomId);
    const roomSize = room ? room.peers.size : 0;
    
    console.log(`💬 Chat message from ${currentPeerId} (${chatMessage.senderName}) to room ${currentRoomId} (${roomSize} peers): ${chatMessage.message.substring(0, 50)}...`);
    
    // Транслируем сообщение всем участникам комнаты (включая отправителя для синхронизации)
    io.to(currentRoomId).emit('chat-message', chatMessage);
    
    console.log(`✅ Chat message broadcasted to room ${currentRoomId}`);
  });

  socket.on('get-producers', (_, callback) => {
    if (!currentRoomId) {
      console.log(`⚠️ get-producers: peer ${currentPeerId} not in room`);
      return callback({ producers: [] });
    }
    const room = rooms.get(currentRoomId);
    const list = [];
    
    // КРИТИЧНО: Получаем имена участников из структуры peer
    // НЕ фильтруем свои producers - пусть фронтенд сам решает
    room.peers.forEach((peer, peerId) => {
      peer.producers.forEach((producer) => {
        list.push({ 
          producerId: producer.id, 
          peerId, 
          kind: producer.kind,
          name: peer.name || 'Участник', // Используем сохраненное имя
        });
      });
    });
    
    console.log(`📋 get-producers: room ${currentRoomId} has ${room.peers.size} peers, returning ${list.length} producers for peer ${currentPeerId}`);
    console.log(`   Producers breakdown:`, list.map(p => `${p.peerId}:${p.kind}(${p.name})`).join(', '));
    
    callback({ producers: list });
  });

  socket.on('disconnect', () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;
    const peer = room.peers.get(currentPeerId);
    if (peer) {
      peer.producers.forEach((p) => p.close());
      peer.consumers.forEach((c) => c.close());
      peer.transports.forEach((t) => t.close());
      room.peers.delete(currentPeerId);
    }
    socket.to(currentRoomId).emit('peer-left', { 
      peerId: currentPeerId,
      name: currentPeerName, // Передаем имя для логирования
    });
    if (room.peers.size === 0) {
      rooms.delete(currentRoomId);
      console.log('Room cleared', currentRoomId);
    }
  });
});

app.get(`${BASE_PATH}/health`, (_req, res) => {
  res.json({
    status: 'ok',
    service: 'luxemeet-sfu',
    rooms: rooms.size,
  });
});

// bootstrap
(async () => {
  await createMediasoupWorkers();
  server.listen(PORT, () => {
    console.log(`🚀 LuxeMeet SFU listening on ${PORT}`);
    console.log(`🌐 CORS origin: ${ALLOWED_ORIGIN}`);
    console.log(`🌐 IO path: ${IO_PATH}`);
    console.log(`👥 Workers: ${workers.length} (optimized for 100+ participants)`);
    if (ANNOUNCED_IP) console.log(`🌐 announced IP: ${ANNOUNCED_IP}`);
  });
})();

