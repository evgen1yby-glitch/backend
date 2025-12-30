# Настройка SFU (mediasoup) для LuxeMeet

## pm2
```
pm2 start /var/www/golden-meet-pro/backend/sfu/ecosystem.config.cjs
pm2 restart luxemeet-sfu
pm2 logs luxemeet-sfu
```

## ENV (пример)
```
SFU_PORT=4001
SFU_BASE_PATH=/sfu
SFU_IO_PATH=/sfu/socket.io
SFU_CORS_ORIGIN=https://luxemeet.online
# если сервер за NAT — указать публичный IP:
SFU_ANNOUNCED_IP=YOUR_PUBLIC_IP
SFU_RTC_MIN_PORT=40000
SFU_RTC_MAX_PORT=49999
```

## Nginx (должен быть настроен)
```
location /sfu/ {
    proxy_pass http://127.0.0.1:4001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 60s;
    proxy_send_timeout 60s;
}
```

## Фронтенд env
```
VITE_SFU_URL=https://luxemeet.online
VITE_SFU_PATH=/sfu/socket.io
```

## Health
- `GET https://luxemeet.online/sfu/health`

## Примечание
- mediasoup клиент требует современный браузер с поддержкой WebRTC.
- При Node.js <20 выводится предупреждение от зависимостей (awaitqueue), но работа сохраняется; при возможности обновить Node до LTS 20+.

