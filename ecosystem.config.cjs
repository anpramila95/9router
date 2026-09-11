module.exports = {
  apps: [
    {
      name: "9router",
      script: ".next/standalone/custom-server.js",
      interpreter: "bun",
      env: {
        NODE_ENV: "production",
        PORT: process.env.PORT || "20129"
      },
    },
  ],
};
