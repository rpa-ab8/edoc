import jwt from "jsonwebtoken";
import type { Env } from "../config/env.js";

export interface AccessTokenPayload {
  sub: string; // user id
  emailVerified: boolean;
  organizationId?: string;
  isSuperAdmin?: boolean;
}

export function signAccessToken(env: Env, payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRES_IN as jwt.SignOptions["expiresIn"],
  });
}

export function verifyAccessToken(env: Env, token: string): AccessTokenPayload {
  return jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload;
}
