module.exports = {
  apps: [
    {
      name: 'luxemeet-sfu',
      script: 'server.js',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        SFU_PORT: process.env.SFU_PORT || 4001,
        SFU_BASE_PATH: process.env.SFU_BASE_PATH || '/sfu',
        SFU_IO_PATH: process.env.SFU_IO_PATH || '/sfu/socket.io',
        SFU_CORS_ORIGIN: process.env.SFU_CORS_ORIGIN || process.env.CORS_ORIGIN || '*',
        SFU_ANNOUNCED_IP: process.env.SFU_ANNOUNCED_IP || process.env.SFU_PUBLIC_IP || undefined,
      },
    },
  ],
};

