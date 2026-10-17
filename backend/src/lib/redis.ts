import { Redis } from "ioredis";
import type { Env } from "../config/env.js";

export function createRedis(env: Env): Redis {
  return new Redis(env.REDIS_URL);
}
