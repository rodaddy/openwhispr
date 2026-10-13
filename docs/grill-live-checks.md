# Grill live checks

Plan for proving the grill end to end in a real session, per
openwhispr#52.
Everything under test is MERGED
(#47 to
#51) and has never run
live. Results go in `docs/grill-live-results.md` beside this file.

## Go

- Rico's go: given 2026-09-27
- Default grill voice: Skippy (the code default; Rico, 2026-09-27)
- Test calendar blocks: Rico adds and deletes them by hand (the check lane
  writes no calendar events)
- Life Story slot for the real blocks: Fridays 10:30am America/New_York,
  one chapter per week (Rico, 2026-09-27)

## Rules for the run

- Rico is present for every check. Checks run in order; a FAIL does not stop
  the later checks unless the later check depends on it (noted per check).
- A FAIL becomes one Forge issue on openwhispr carrying the check id, what was
  done, and the log line. No code is fixed inside the run.
- Evidence per check: the log line(s) from the app's debug log
  (`~/Library/Application Support/open-whispr/logs/debug-<timestamp>.log`,
  newest file), a screenshot where the proof is on screen, and the SQL row count
  where the proof is in the pipeline database.

## P — Pre-flight

| Id | Check | PASS when |
| --- | --- | --- |
| P1 | OmniVoice on the voice host answers | `curl -s -o /dev/null -w '%{http_code}' http://voice-host.example.internal:8080/` prints a 2xx or 3xx code |
| P2 | social-media-pipeline is running with the internal bearer set and migration `20260927_0025` applied | the app's Pipeline integration card "Test connection" shows ok, and the log has `Pipeline test connection` with `status: ok` |
| P3 | No other copy of the app is running | Activity Monitor shows none before C1 launches |

## C1 — Build and launch from current main

- Do: in a worktree cut from `origin/main` at the commit named in the
  results doc, `npm ci`, then `npm run pack`, then open the `.app` under
  `dist/`.
- PASS: the app opens, and the debug log's `System Info` line shows the
  version from `package.json` at that commit.
- Blocks: every later check.

## C2 — Manual grill

- Do: in chat, pick grill mode, Daily grill, Start grill. Answer three
  questions aloud. End grill.
- PASS, all of:
  - the interviewer asks exactly one question per turn;
  - each question is spoken (status shows Speaking, then Listening);
  - each spoken answer shows Transcribing, then appears as Rico's turn and is
    sent without a click;
  - End grill shows "Grill saved", and a note with the session's turns
    exists in the Grill notes folder.
- Blocks: C5.

## C3 — Voices

- Do: Settings, Grill voices. Start a grill in each voice on the list
  (Skippy plus every added voice); let one question play in each.
- PASS: every voice is heard speaking the question, no "Couldn't speak the
  question" notice appears, and the selected voice persists after an app
  restart.
- Record: Rico's default voice choice goes under Go above before the run
  starts; C3 confirms that voice is selected on a fresh start.

## C4 — Controls

One grill, each control in turn:

| Id | Control | PASS when |
| --- | --- | --- |
| C4a | Pause, then Resume | Pause stops speaking or listening and shows Paused; Resume continues the same question |
| C4b | Skip question | the next question is asked and the skipped one gets no answer turn |
| C4c | Mute voice | the next question appears on screen unspoken and listening still starts |
| C4d | Push to talk | auto-listen stops; dictation hotkey plus Enter sends the answer |
| C4e | End grill while an answer is still transcribing | the note is saved with an "An answer could not be transcribed" line and "Audio kept at <path>", and that audio file exists |

## C5 — Pipeline

- Depends on: C2 passing.
- Do: after the C2 save, open the pipeline database the Pipeline card points
  at.
- PASS, all of:
  - the app log has `Pipeline grill session sent` with the note id and a
    `piecesAdded` count, and no `Pipeline grill session failed`;
  - `workbench_grill_sessions` has one row with `note_id = 'whisper-<id>'`;
  - `workbench_grill_pieces` rows for that note: the count equals
    `piecesAdded`, and each piece's text is a verbatim substring of one of
    Rico's turns in the note;
  - a daily grill logs `Pipeline feed questions read`. Any open feed
    question returned is asked after the day questions; an empty list is a
    PASS here (the pipeline serves `{"questions": []}` until its G4b work).

## C6 — Calendar trigger

- Do: Rico adds a test block titled `Grill` starting two minutes out.
- PASS: the "Grill session" notification with Start grill appears; the click
  starts a daily grill.
- Repeat with the control panel window closed at the block's start. PASS:
  the log has `grill:start queued until a window subscribes`, then
  `grill:start delivered after subscribe` when the window opens, and the
  grill starts.
- Repeat with a block titled `Life Story 3`. PASS: a lifetime grill starts on
  chapter 3.
- Rico deletes the test blocks after C6.

## After every check passes

State 4 of the rtech-consulting handover puts the real Grill and Life Story
blocks back by script. It does not run while any check here is FAIL.
