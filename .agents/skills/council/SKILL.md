---
name: council
description: Weigh a dark project's big call from several angles before the owner decides. Use when you're the owner with a big call, or one of its angles.
---

# Council

One point of view makes biased calls, and nobody's watching a dark
project to catch them. So the owner's big calls get weighed by a few
angles first. Each angle is one fresh subagent with one job: argue its
side well, once. The owner decides. `factory-workflow` defines the words;
`owner` says which calls are big.

## Angles

Set in `factory.json` under `council`, each with its own model. Put them
on different models: one model playing several angles mostly agrees with
itself.

- **client** speaks for all the clients, not just the one asking: the
  human's words, the `source:feedback` issues, and how the tool actually
  gets called. When the clients are agents, read their skills and scripts
  that call it (agent-org's `verifier` calls `video-capture`, for
  example). Asks: what's the need under the ask? Who else has it? Who
  would this change hurt? Would it fix what they actually ran into, or
  only what they said?
- **maintainer** speaks for whoever keeps it alive: what it costs to
  build, what it adds to the code and docs forever, the simplest version,
  and what could be deleted instead. Says no to anything that grows the
  tool without a client behind it.
- **Extra angles** a project adds, such as a designer for an app with
  real UI, carry their own one-line `brief` in the config.

The owner is the lead: it holds the brief and decides. The old reviewer
role is the lenses and the verifier.

## The owner: running one

1. **Write the question** in at most ten lines: the call, the ask quoted,
   what `CONTEXT.md` and its **Direction** say that matters, the options you see, and links to
   the evidence. No recommendation; the angles shouldn't anchor on yours.
2. **Run every angle at once**, each as a subagent on its configured
   model (`delegate_task` across providers), with the question, this
   skill, and its angle's name.
3. **Plans only: one rebuttal round.** Send each angle the others'
   answers; it may change its recommendation or hold it, in two lines.
4. **Decide.** Pick what serves the clients within what the brief says
   must never break. Going against every angle is allowed, with a reason.
5. **Post** on the issue or PR:

```
Author: owner · <thread id>
> Owner decision: "<the call, one or two sentences>"
Council: client — <its recommendation and why, one line>; maintainer — <same>; <extra> — <same>
Overruled: <angle> — <why, one line>   (only when you went against one)
```

Every angle gets its line, even when it lost. The audit reads them: an
angle that loses every time is either useless or a sign the lead is
biased, and both are worth fixing.

## An angle: answering

You get one question and your angle. Read the evidence it links,
`CONTEXT.md`, and whatever your angle's description above says to read.
Then answer in exactly this shape, under 120 words:

```
Angle: <name>
Take: <one or two sentences from your angle>
Recommend: <one of the options, a new one, or no>
Cost: <what your recommendation costs or risks, one line>
Would change my mind: <one line>
```

Argue your angle, not a balanced view; balancing is the owner's job.
Don't hedge, don't restate the question, don't cover other angles' ground.
You don't post anything on GitHub; the owner does.

## Return

As an angle, the template is your whole output. As the owner, the council
is part of your own run; nothing extra to return.
