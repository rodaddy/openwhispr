# Grill question system plan

Plan for question ids, the question and flow editor, and the feedback loop.
State: PROPOSED. Nothing here is built. Building starts on Rico's approval of
this plan; no agent changes a live question without his approval.

## Decisions (Rico, 2026-09-27)

| Id | Question | Decision |
| --- | --- | --- |
| D1 | Where the editable bank lives | The app's own store (SQLite in rTech Whisper). It is seeded once from the compiled bank. `scripts/sync-grill-bank.mjs` and the verbatim-copy test retire with the seed; the rtech-consulting `docs/playbooks/grill-question-bank.md` becomes an export, not a source. |
| D2 | Flows as data or code | Flow logic stays in code. Counts, order, and each chapter's question set are editable parameters in the store. |
| D3 | When and where the idea agent runs | In social-media-pipeline, weekly and on demand, through its existing Codex subscription route. Counting, ranking, and the approval flow are code; the model only writes proposals. |
| D4 | Where feedback is captured | Both: a closing question at the end of every grill (spoken answer), plus optional good, weak, or retire marks per question in the saved note and the editor. |

## Shape

- Question ids: `gq-<uuid>` for bank questions, assigned at seed or create
  time and never reused. Wording edits keep the id. Feed questions keep
  `fq-<uuid>`. A model follow-up records `follow_up_of: <parent id>`.
- Store tables: `grill_questions` (id, section, chapter, text, position,
  status active or retired, timestamps), `grill_question_history` (id,
  changed_at, field, old value, new value, source rico or agent-proposal),
  `grill_flow_params` (key, value).
- Every interviewer turn sent to the pipeline carries `question_id` and,
  for a follow-up, `follow_up_of`. Only `fq-` ids close feed questions.
- Feedback travels in the session post: the closing-question turn is tagged
  `question_id: "feedback"`, and per-question marks go in a `marks` list
  (question id, mark, optional note). Marks made after the post are sent
  with a re-post of the same `note_id` (the contract is already idempotent).
- The app pushes a bank snapshot to the pipeline on every edit, so the agent
  reads the current wording.
- Proposals: the pipeline serves pending proposals; the app shows them in the
  editor; Rico approves or rejects each; the app applies an approval to its
  store (history source `agent-proposal`) and posts every decision back. A
  rejection is feedback.

## Lanes

Each lane is one issue, one branch, one PR, merged before a lane that
depends on it starts.

| Lane | Repo | Deliverable | Needs |
| --- | --- | --- | --- |
| L1 | rtech-whisper | Store tables and seed from the compiled bank with `gq-` ids; the grill reads questions and flow params from the store; turns carry `question_id` and `follow_up_of`; sync script and verbatim test retired | none |
| L2 | social-media-pipeline | Contract accepts `gq-` ids and `follow_up_of`; each piece stores the question id it answered; bank snapshot endpoint; per-question results endpoint (sessions asked, pieces kept by kind, pieces used in a post, by date range) | none; runs beside L1 |
| L3 | rtech-whisper | Editor: view each flow's questions in order; add, edit, retire, reorder; edit flow params; history view; snapshot push on edit | L1, L2 |
| L4 | rtech-whisper | Feedback: closing question in the grill, per-question marks in the note and editor, `marks` and the feedback turn in the session post | L1 |
| L5 | social-media-pipeline | Store feedback and marks; the idea agent (weekly schedule plus an on-demand route) writes proposals citing the feedback and numbers behind each; proposals and decisions endpoints | L2, L4 |
| L6 | rtech-whisper | Pending proposals in the editor with approve and reject; approval applied to the store; decision posted back | L3, L5 |

The contract changes land in the pipeline's `docs/local-pipeline/grill-contract.md`
with its decision row, in L2 and L5.

## Not in this plan

- Flows as editable data (rejected in D2).
- Any agent change that goes live without Rico's approval.
- The live grill run,
  which is a separate lane.
