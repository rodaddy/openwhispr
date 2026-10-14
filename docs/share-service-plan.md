# Share service plan

Plan for note sharing on our own service instead of `notes.openwhispr.com`.
State: PROPOSED. Nothing here is built. Rico's decisions below were given on
2026-09-28; building starts on his go on this plan.

## Decisions (Rico, 2026-09-28)

| Id | Question | Decision |
| --- | --- | --- |
| D1 | Who can open a link | Anyone with the link (unlisted). Revoke or rotate at any time. |
| D2 | First version scope | Links only: share, copy link, rotate, revoke. Email invites, per-person access, and the visibility menu are removed from the dialog. |
| D3 | Hostname | `share.rtech-consulting.com` |
| D4 | Expiry | None; a link lives until it is revoked or rotated. |
| D5 | Where it runs | Any container host; `apps/share/Dockerfile` builds the image. |

## Today

`src/components/notes/ShareNoteDialog.tsx` depends on OpenWhispr's cloud:
`NoteSharingService` (share settings, rotate token, invites, access grants),
`syncService` (a cloud copy of the note), and `useAuth` (an OpenWhispr account).
The link is `https://notes.openwhispr.com/n/<token>`.

## Design

**Service**: `server/share/` in this repo, Node 24 TypeScript, same layout as
`server/gateway/` (native type stripping, `node --test`). One process, one
replica, SQLite through `node:sqlite` on a persistent volume (a note snapshot
is small; no shared database needed).

| Route | Auth | Does |
| --- | --- | --- |
| `POST /api/shares` `{note_id, title, markdown}` | app bearer | Creates a share, returns `{token, url}` |
| `PUT /api/shares/:token` `{title, markdown}` | app bearer | Replaces the snapshot (re-share after edits) |
| `POST /api/shares/:token/rotate` | app bearer | New token; the old link stops working |
| `DELETE /api/shares/:token` | app bearer | Revokes; the link returns 404 |
| `GET /n/:token` | none | The public page: title and the note rendered from markdown, sanitized, `noindex`, rTech styling |
| `GET /healthz` | none | Liveness |

Tokens are 32 random bytes, URL-safe. The app bearer is one secret, kept in
your secret store; the service reads it from its environment and the app gets it at build time through `scripts/write-build-env.js`
with `SHARE_SERVICE_URL`, like the calendar client. The markdown renderer and
sanitizer are maintained libraries, never hand-rolled.

**App**: a `ShareService` client in `src/services/` replaces the
`NoteSharingService`, `syncService`, and `useAuth` calls in the dialog. The
dialog keeps: Share on or off, Copy link, Rotate link, Stop sharing. The note's
existing `is_shared` and `share_token` columns keep their meaning; the link is
`https://share.rtech-consulting.com/n/<token>`. Sharing again after an edit
updates the same link.

## Lanes

Each lane is one PR with tests, merged before a lane that depends on it.

| Lane | Deliverable | Needs |
| --- | --- | --- |
| S1 | `server/share/` service, routes above, tests against a temp SQLite file, Dockerfile | none |
| S2 | App client and dialog rewrite, tests for the client against a fake server | S1 contract |
| S3 | Deploy the container, store the token as a secret, and point DNS for the share hostname at it | S1 |
| S4 | Live check: share a real note, open the link from a phone, rotate, revoke, confirm 404 | S2, S3 |

## Not in this plan

Email invites and per-person access (D2), expiring links (D4), cross-machine
note sync (the local-first decision), and OpenWhispr account sign-in.
