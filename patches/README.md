# Fork patches

Local changes carried on top of upstream OpenWhispr. Each patch is a
`git format-patch` output and applies with `git am`.

| Patch | What it does |
|-------|--------------|
| `0001-self-hosted-note-recording.patch` | Self-hosted (OpenAI-compatible, e.g. llama-swap) transcription for Note Recording; chunks POST to `<url>/audio/transcriptions`. |
| `0002-filler-words.patch` | Remove filler words (um, uh, er...) from dictation before cleanup or paste; toggle plus editable list under AI Models. |
| `0003-hybrid-activation-mode.patch` | Hybrid activation mode (Tap / Hold / Both): a tap under 400 ms latches dictation on until the next tap, a longer hold stops on release. |
| `0004-self-hosted-live-preview.patch` | Live transcription preview for the self-hosted route: 1.5 s chunks POST to the endpoint while recording; final paste unchanged. |
| `0005-preview-panel-three-lines.patch` | Preview panel opens at a three-line minimum and grows from there instead of one line per chunk. |
| `0006-press-to-record-latency.patch` | Hotkey press starts recording without the osascript round trips or the hold delay in hybrid mode; a press during processing is replayed instead of dropped. |
| `0007-timing-breakdown-logs.patch` | Debug-level timing breakdowns for recording start and paste. |
| `0008-instant-pill-warm-gate-resident-paste.patch` | Pill and preview panel open at once, the silence-gate AudioContext stays warm, and paste goes through the resident Globe listener instead of a spawned helper. |
| `0009-disable-update-checks.patch` | Fork-only: update checks and the update UI are off (`OPENWHISPR_ENABLE_UPDATES=1` restores them). |
| `0010-instant-transcript-panel.patch` | Live transcript panel appears whole on its first frame instead of staging the entrance; the staged timeline stays behind `LIVE_TRANSCRIPT_INSTANT_ENTRANCE`. |
| `0011-crm-connector.patch` | CRM settings, contact/company selection and creation, and note activity sync with persisted update identity. |
| `0012-forge-ci-runner-routing.patch` | Route the PR test and lockfile checks to Forge's available Docker runner and pin Node from `.nvmrc`. |
| `0013-crm-review-and-validation-fixes.patch` | Preserve CRM activity identity through key/account changes, export stable drafts, fix company resolution and diagnostics, and repair validation dependencies and fixtures. |

## Reapply after pulling upstream

```sh
git fetch github
git checkout -b sync/upstream github/main
scripts/apply-fork-patches.sh
```

`git am` stops on a conflict; fix the file, `git add` it, then
`git am --continue`. Refresh the patch afterwards with
`git format-patch -1 HEAD -o patches` and rename it.
