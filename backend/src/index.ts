import { loadEnv } from "./config/env.js";
import { buildApp } from "./app.js";
import { prisma } from "./lib/prisma.js";
import { createRedis } from "./lib/redis.js";

const env = loadEnv();
const redis = createRedis(env);
const app = buildApp(env, prisma, redis);

async function shutdown() {
  await app.close();
  await prisma.$disconnect();
  redis.disconnect();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

app
  .listen({ port: env.PORT, host: "0.0.0.0" })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
