module.exports = {
  apps: [
    {
      name: 'luxemeet-signal',
      script: 'server.js',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
module.exports = {
  apps: [
    {
      name: 'luxemeet-signal',
      script: 'server.js',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        SIGNAL_PORT: process.env.SIGNAL_PORT || 3010,
        SIGNAL_CORS_ORIGIN: process.env.SIGNAL_CORS_ORIGIN || process.env.CORS_ORIGIN || '*',
      },
    },
  ],
};

