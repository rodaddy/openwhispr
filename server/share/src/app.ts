import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import MarkdownIt from "markdown-it";
import type { Config } from "./config.ts";
import type { Share, ShareRepository } from "./store.ts";

type Dependencies = Readonly<{
  config: Config;
  store: ShareRepository;
  newToken?: () => string;
}>;

const MAX_BODY_BYTES = 1_048_576;

/** html:false escapes raw HTML; the default validateLink blocks javascript:/vbscript:/file:/data: */
const markdown = new MarkdownIt({ html: false, linkify: true });

const json = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
};
const fail = (response: ServerResponse, status: number, code: string): void =>
  json(response, status, { error: { code } });

const newTokenDefault = (): string => randomBytes(32).toString("base64url");

function authorized(request: IncomingMessage, config: Config): boolean {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const presented = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(config.bearer);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

async function readJson(
  request: IncomingMessage
): Promise<{ ok: true; value: unknown } | { ok: false; status: number }> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  // Drain the rest of an oversized body rather than destroying the socket, so the
  // client can still read the 413 response instead of seeing ECONNRESET.
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      tooLarge = true;
      chunks.length = 0;
      continue;
    }
    if (!tooLarge) chunks.push(chunk as Buffer);
  }
  if (tooLarge) return { ok: false, status: 413 };
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { ok: false, status: 400 };
  }
}

const isFilled = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const shareUrl = (config: Config, token: string): string => `${config.publicBase}/n/${token}`;
const shareBody = (config: Config, share: Share) => ({
  token: share.token,
  url: shareUrl(config, share.token),
});

const PAGE_CSS = `:root{color-scheme:light}
body{margin:0;padding:3rem 1.25rem;background:#f7f1e3;color:#2b2622;
font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;line-height:1.6}
main{max-width:72ch;margin:0 auto}
h1,h2,h3,h4,h5,h6{color:#7a1f2b;line-height:1.25}
hr,.rule{border:0;border-top:2px solid #c9a227;margin:1.5rem 0}
a{color:#7a1f2b}
code,pre{background:#efe6d2;border-radius:4px}
pre{padding:0.75rem;overflow-x:auto}
blockquote{margin:1rem 0;padding-left:1rem;border-left:3px solid #c9a227;color:#4a423c}
img{max-width:100%}
footer{margin-top:2.5rem;padding-top:1rem;border-top:2px solid #c9a227;
color:#6b625a;font-size:0.875rem}`;

function sharePage(share: Share): string {
  const title = escapeHtml(share.title);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${title}</title>
<style>${PAGE_CSS}</style></head>
<body><main><h1>${title}</h1><hr class="rule">
${markdown.render(share.markdown)}
<footer>Shared from rTech Whisper</footer></main></body></html>
`;
}

const MISSING_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="robots" content="noindex,nofollow">
<title>Not available</title>
<style>${PAGE_CSS}</style></head>
<body><main><h1>This link is not available.</h1></main></body></html>
`;

function html(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-robots-tag": "noindex",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:",
    "referrer-policy": "no-referrer",
  });
  response.end(body);
}

export function createShareServer({ config, store, newToken = newTokenDefault }: Dependencies) {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://local");
    const path = url.pathname;
    if (request.method === "GET" && path === "/healthz") return json(response, 200, { ok: true });

    const page = path.match(/^\/n\/([A-Za-z0-9_-]+)$/);
    if (request.method === "GET" && page) {
      const share = store.findByToken(page[1]);
      return share ? html(response, 200, sharePage(share)) : html(response, 404, MISSING_PAGE);
    }

    if (!path.startsWith("/api/")) return fail(response, 404, "not_found");
    if (!authorized(request, config)) return fail(response, 401, "unauthorized");

    if (request.method === "POST" && path === "/api/shares") {
      const body = await readJson(request);
      if (!body.ok)
        return fail(
          response,
          body.status,
          body.status === 413 ? "payload_too_large" : "bad_request"
        );
      const input = body.value as Record<string, unknown>;
      if (
        !input ||
        !isFilled(input.note_id) ||
        !isFilled(input.title) ||
        typeof input.markdown !== "string"
      )
        return fail(response, 400, "bad_request");
      const share = store.create({
        token: newToken(),
        noteId: input.note_id,
        title: input.title,
        markdown: input.markdown,
      });
      return json(response, 201, shareBody(config, share));
    }

    const rotate = path.match(/^\/api\/shares\/([A-Za-z0-9_-]+)\/rotate$/);
    if (request.method === "POST" && rotate) {
      const share = store.rotate(rotate[1], newToken());
      return share
        ? json(response, 200, shareBody(config, share))
        : fail(response, 404, "not_found");
    }

    const one = path.match(/^\/api\/shares\/([A-Za-z0-9_-]+)$/);
    if (one && request.method === "PUT") {
      const body = await readJson(request);
      if (!body.ok)
        return fail(
          response,
          body.status,
          body.status === 413 ? "payload_too_large" : "bad_request"
        );
      const input = body.value as Record<string, unknown>;
      if (!input || !isFilled(input.title) || typeof input.markdown !== "string")
        return fail(response, 400, "bad_request");
      const share = store.update(one[1], input.title, input.markdown);
      return share
        ? json(response, 200, shareBody(config, share))
        : fail(response, 404, "not_found");
    }
    if (one && request.method === "DELETE") {
      if (!store.remove(one[1])) return fail(response, 404, "not_found");
      response.writeHead(204, { "cache-control": "no-store" });
      return response.end();
    }
    return fail(response, 404, "not_found");
  });
}
