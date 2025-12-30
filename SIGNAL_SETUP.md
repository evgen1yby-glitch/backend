# Настройка сигнального сервера LuxeMeet (WebRTC)

## pm2
```
pm2 start /var/www/golden-meet-pro/backend/signal/ecosystem.config.cjs
pm2 restart luxemeet-signal
pm2 logs luxemeet-signal
```

## ENV (пример)
```
# сигнальный сервер
SIGNAL_PORT=3010
SIGNAL_BASE_PATH=/signal
SIGNAL_IO_PATH=/signal/socket.io
SIGNAL_CORS_ORIGIN=https://luxemeet.online
```

## Nginx (пример location)
```
location /signal/ {
  proxy_pass http://127.0.0.1:3010/;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
}
```

## Фронтенд env
```
VITE_SIGNAL_URL=https://luxemeet.online
VITE_SIGNAL_PATH=/signal/socket.io
```

## TURN
- Развернуть coturn на 443/TCP+TLS (static-auth).
- Экспонировать выдачу кредов через `/api/turn/credentials` в backend (используется фронтендом).

## Health
- `GET https://luxemeet.online/signal/health`

