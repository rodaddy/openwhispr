export type Config = Readonly<{
  port: number;
  dbPath: string;
  bearer: string;
  publicBase: string;
}>;

const required = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.SHARE_PORT ?? "8095");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("SHARE_PORT is invalid");
  const bearer = required(env, "SHARE_BEARER");
  if (bearer.length < 32) throw new Error("SHARE_BEARER must be at least 32 characters");
  const publicBase = (
    env.SHARE_PUBLIC_BASE?.trim() || "https://share.rtech-consulting.com"
  ).replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s]+$/.test(publicBase)) throw new Error("SHARE_PUBLIC_BASE is invalid");
  return { port, dbPath: required(env, "SHARE_DB_PATH"), bearer, publicBase };
}
