module.exports = {
  apps: [
    {
      name: "9router",
      script: ".next/standalone/custom-server.js",
      interpreter: "bun",
      env: {
           NODE_ENV: "production",
           PORT: 20128,
           DATA_DIR: "/home/9router/data"
         }
    },
  ],
};
