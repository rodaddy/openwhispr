# share-service

A small Node 24 HTTP service that publishes a single rTech Whisper note as a
read-only public page. The app calls its `/api/shares` routes with a bearer
token; visitors read `/n/:token`. Pages are self-contained (inline CSS, no
external requests), `noindex`, and never cached.

## Environment

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `SHARE_PORT` | no | `8095` | listen port |
| `SHARE_DB_PATH` | yes | — | SQLite file holding the shares |
| `SHARE_BEARER` | yes | — | app bearer token, at least 32 characters |
| `SHARE_PUBLIC_BASE` | no | `https://share.rtech-consulting.com` | origin used to build share URLs |

Startup throws naming the variable (never its value) when one is missing or too
short.

## Routes

| Method | Path | Auth | Result |
| --- | --- | --- | --- |
| `POST` | `/api/shares` | bearer | 201 `{token, url}`; body `{note_id, title, markdown}`. One share per `note_id` — a second create replaces the content and keeps the token. |
| `PUT` | `/api/shares/:token` | bearer | 200 `{token, url}`; 404 unknown token |
| `POST` | `/api/shares/:token/rotate` | bearer | 200 new `{token, url}`; 404 unknown token |
| `DELETE` | `/api/shares/:token` | bearer | 204; 404 unknown token |
| `GET` | `/n/:token` | public | 200 HTML page; 404 "This link is not available." |
| `GET` | `/healthz` | public | 200 `{ok:true}` |

JSON bodies are capped at 1 MB (413). Markdown renders with `html: false`, so
raw HTML is escaped and `javascript:`/`data:`/`file:`/`vbscript:` links are
dropped.

## Local run

```bash
npm ci
SHARE_DB_PATH=./share.sqlite SHARE_BEARER=<32+ chars> npm start
npm run check   # typecheck + tests
```

## Deploy

Not in this lane. Building and deploying the image (and the public hostname) is
lane S3 of openwhispr#63.
