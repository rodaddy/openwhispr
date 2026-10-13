import { isIP } from "node:net";

export type Config = Readonly<{
  host: string;
  port: number;
  dbPath: string;
  trustedProxyIps: ReadonlySet<string>;
  identityHeader: string;
  publicOrigin: string;
  livekitUrl: string;
  livekitInternalUrl: string;
  livekitApiKey: string;
  livekitApiSecret: string;
  sessionTtlSeconds: number;
}>;

const required = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const validUrl = (value: string, protocols: readonly string[], name: string): string => {
  const parsed = new URL(value);
  if (!protocols.includes(parsed.protocol)) throw new Error(`${name} has an invalid protocol`);
  return parsed.origin;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const proxyIps = required(env, "VOICE_TRUSTED_PROXY_IPS")
    .split(",")
    .map((ip) => ip.trim());
  if (proxyIps.some((ip) => isIP(ip) === 0))
    throw new Error("VOICE_TRUSTED_PROXY_IPS must contain exact IP addresses");
  const identityHeader = required(env, "VOICE_IDENTITY_HEADER").toLowerCase();
  if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(identityHeader))
    throw new Error("VOICE_IDENTITY_HEADER is invalid");
  const apiSecret = required(env, "LIVEKIT_API_SECRET");
  if (Buffer.byteLength(apiSecret) < 32 || /^(change|replace|example|secret)/i.test(apiSecret)) {
    throw new Error("LIVEKIT_API_SECRET must be at least 32 bytes and non-placeholder");
  }
  const port = Number(env.VOICE_PORT ?? "8090");
  const ttl = Number(env.VOICE_SESSION_TTL_SECONDS ?? "3600");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("VOICE_PORT is invalid");
  if (!Number.isInteger(ttl) || ttl < 300 || ttl > 86_400)
    throw new Error("VOICE_SESSION_TTL_SECONDS must be 300..86400");
  return {
    host: env.VOICE_HOST?.trim() || "127.0.0.1",
    port,
    dbPath: required(env, "VOICE_DB_PATH"),
    trustedProxyIps: new Set(proxyIps),
    identityHeader,
    publicOrigin: validUrl(required(env, "VOICE_PUBLIC_ORIGIN"), ["https:"], "VOICE_PUBLIC_ORIGIN"),
    livekitUrl: validUrl(required(env, "LIVEKIT_URL"), ["wss:"], "LIVEKIT_URL"),
    livekitInternalUrl: validUrl(
      required(env, "LIVEKIT_INTERNAL_URL"),
      ["http:", "https:"],
      "LIVEKIT_INTERNAL_URL"
    ),
    livekitApiKey: required(env, "LIVEKIT_API_KEY"),
    livekitApiSecret: apiSecret,
    sessionTtlSeconds: ttl,
  };
}
