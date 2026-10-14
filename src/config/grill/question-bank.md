<!--
grill-question-bank provenance
source-repo: unpublished
source-path: unpublished
source-commit: unpublished
sha256: unpublished
Frozen seed for the app's grill question store, copied from the author's
private planning notes. The live bank is the store; edit questions there, not
here.
-->

# Grill question bank

**Status:** WRITTEN 2026-09-26. A draft for Rico to edit.

The grill interviews Rico by voice, one question at a time, and follows each
answer up until it is concrete (Matt Pocock's grill-me pattern). It exists
because the five post types need his own takes and stories, and he will not
produce them unprompted. What it collects is his "approved language": his own
words, which the pipeline later repeats and remixes (Nicolas Cole's digital
brain). It never invents a take for him.

## Sessions

| Session | When | Length | Questions |
| --- | --- | --- | --- |
| Daily grill | 10:00am on Rico's rtech calendar, the first thing his day puts in front of him | 10-15 minutes | 3 or 4 day questions, then standard questions until time runs out |
| Feed grill | inside the daily grill, when feed items are waiting | 1 or 2 questions | one per item tagged `breaking` or `content` (S13) |
| Lifetime grill | one chapter a week to start; the cadence changes once the yield per session is measured | 30 minutes | one chapter, below |

Missed questions carry over to the next session. Two missed daily grills in a
row move the next block earlier and add a second reminder (S11).

## Rules the interviewer follows

1. **One question at a time.** Wait for the whole answer before asking again.
2. **Concrete or ask again.** An answer counts when it has at least one of: a
   specific moment ("last Tuesday, on the call with..."), a role or name, a
   number, or what he would tell a client. If it has none, ask the one
   follow-up that would get it: "What's an example?", "Who was it, roughly?",
   "How many?", or "What would you tell a client who asked?"
3. **Follow the branch, then move on.** Stay on a thread while each answer
   opens something new, for three follow-ups at most, then go to the next
   question.
4. **Agree or disagree is a real question.** For common advice, get his side
   and his reason. "It depends" gets one follow-up: "Depends on what? Pick the
   usual case."
5. **Never supply the answer.** No "would you say that...?" with the opinion
   already in it. Ask open questions.
6. **Client names get flagged, not dropped.** If he names a client, keep the
   words and mark the piece `client-named`. Nothing marked that way becomes a
   post until Rico clears it.
7. **Language is kept as spoken.** Profanity stays in the notes. It is removed
   only from published output (S14).
8. **Stop on time.** Close with: "That's the session. Anything you want on the
   record before we stop?"

## What each answer becomes

Each answer is split into pieces. A piece is one of:

| Kind | What it is | Feeds post type |
| --- | --- | --- |
| story | something that happened, with a moment | lesson, contrarian |
| opinion | his side of a common idea, with the reason | contrarian, newsjack |
| lesson | what he learned, or would do differently | lesson |
| framework | a method he repeats, as steps | framework |
| personality | a detail about him outside the work | any, as a hook |

Every piece keeps his exact words, is tagged `timely` (tied to this week) or
`timeless`, and records the note it came from.

**Pieces are a library, not a queue.** Most pieces will not become this
week's post. Their value is later: a story that colors a post six months out,
or a new opinion that re-angles something he already published (Rico,
2026-09-26). So a session is not judged by the posts it produces. Its yield is
the number of new, concrete pieces that do not repeat one already in the
library, and that yield is what sets the lifetime grill's cadence. The
pipeline pulls matching pieces into any draft on the same topic, and can
propose re-telling a past post when a new piece changes its angle.

## Daily: day questions

Built each morning from yesterday's sources. Read-only, and email is subjects
and recipients only, never bodies.

| Source | Question template |
| --- | --- |
| Calendar or meeting | "You met {who} about {topic}. What surprised you?" |
| Meeting transcript | "In the {meeting}, you said '{short quote}'. Say more: why?" |
| Sent email subject | "You sent '{subject}' to {role}. What was the decision behind it?" |
| Forge work shipped | "You shipped {PR title}. What would you tell a client about why it mattered?" |
| Feed item (S13) | "{source} says {headline}. Agree or disagree, and what are your clients missing?" |

## Daily: standard questions

Asked in rotation after the day questions, so each comes up every few days.

1. What happened yesterday that surprised you?
2. What did you get wrong, or would you do differently?
3. What did a client or prospect say that stuck with you?
4. What common advice about AI or small business did you hear lately? Do you
   agree or disagree?
5. What did you explain more than once this week? Could it be steps?
6. What in the news are your clients missing?
7. What would you ask your LinkedIn audience right now?
8. One thing about you, outside work, that came up this week.

## Lifetime chapters

One 30-minute chapter per session. These are starting questions; the
interviewer follows up with the rules above. After each chapter, list the
lines worth repeating: the "When I was 17..." sentences.

**1. Roots and family.** Where did you grow up? What did your parents do?
What was the house like? Who were you as a kid? What did you get in trouble
for? What did your family expect you to become? What is the first thing you
remember building or taking apart?

**2. First jobs.** What was your first paid job? What did it teach you that
school did not? Who was your first real boss, and what did they get right or
wrong? What job did you quit, and why? When did you first feel good at
something at work?

**3. The trading years.** How did you get into trading and markets? What did
a normal day look like? What was your best call, and your worst? What did
markets teach you about risk and about people? What did you see break, and
why? What made you leave, or change course?

**4. The technical path.** How did you learn to build systems? What was the
first thing you built that people used? Which tools or stacks did you bet on,
and which bets were wrong? What do you know about infrastructure that most
consultants do not? What do you still do by hand, on purpose?

**5. Building rTech and the ventures around it.** Why start rTech? What
was the first client, and how did you get them? What did your other
ventures teach you about building a product? What do you
say no to now that you used to say yes to?

**6. Failures and mistakes.** What is the most expensive mistake you have
made? What did it cost, and what changed after? What project did you kill,
and when should you have killed it? Where did you trust the wrong person or
tool? What would you tell yourself five years ago?

**7. Why "extend and enhance".** When did you decide AI should make people
better at their jobs instead of replacing them? What did you see that made
you sure? What do other AI consultants get wrong? What happens to a small
business that cuts people instead of freeing them up? Tell one story where a
tool made someone better at their work.

**8. Life outside work, and Long Island.** What do you do when you are not
working? What is the Long Island everyone gets wrong? Where do you go to
think? What hobby have you had the longest? What would people be surprised to
learn about you?

**9. People who shaped you.** Who taught you the most, and what exactly? Who
did you learn from by watching them get it wrong? Who do you call when you
are stuck? Whose advice did you ignore, and were you right?

**10. What is next.** What do you want rTech to be in five years? What do you
want to be known for? What are you learning right now? What are you worried
about in AI, honestly? What would make you stop doing this?

## Editing this bank

Rico edits this file directly: reword, add, or drop questions. Grill mode
(G2) reads it as the source of truth. A question that keeps getting weak
answers gets reworded or dropped, not asked louder.
