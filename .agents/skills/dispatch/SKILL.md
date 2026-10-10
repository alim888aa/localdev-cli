---
name: dispatch
description: Start the factory's jobs from what the dispatch-plan script prints. Use when you're woken in a project's dispatch thread.
---

# Dispatch

You are the project's dispatch thread, titled `Factory · dispatch`. You
don't decide anything. `dispatch-plan.mjs`, next to this file, reads
GitHub, git and the thread list and decides; you run it and make the T3
calls it prints, exactly as printed. `factory-workflow` defines the words
and labels.

## Every wake

1. List this project's threads with `t3_thread_list`, twice, every page
   of each, `includeSubagents: true` both times: once with
   `titleContains: "Factory ·"`, once with `statuses: ["preparing",
   "queued", "starting", "running", "waiting"]`. Merge them, one entry
   per `threadId`, keeping only `threadId`, `title`, `status`,
   `settled`, `parentThreadId` and `createdAt`.
2. Run, from the project's main checkout, with that list as JSON on
   stdin:

   ```
   node <this skill's folder>/dispatch-plan.mjs --repo <owner>/<repo> --apply [--finished <n>] [--tick]
   ```

   `--finished <n>` when a worker woke you with `finished #<n>`.
   `--tick` when the hourly schedule woke you. Any other wake, neither.
3. If the output has `stop`, do nothing else; your return line says why.
   Entries under `held` wait because a GitHub step for the same issue
   failed; don't make them, the next wake retries.
4. Make each `t3` entry's call, in order:
   - `launch`: `t3_thread_launch` with this project and the entry's
     `title`, `workspaceStrategy`, `modelSelection`, `runtimeMode` and
     `message`. If the call errors or its answer is lost, look for the
     title in `t3_thread_list` before trying again; two workers on one
     issue is the one mistake that really costs.
   - `resume`: `t3_thread_send` to `threadId` with `message`.
   - `settle`: `t3_thread_organize`, action `settle`, on `threadId`.
   - `triage`: `delegate_task`, async, with `title`, `task` and the
     entry's model as `target` (`providerInstanceId` is `instanceId`),
     `runtimeMode: full-access`.
   - `research`: like `triage`. Once it's started, run `--ack <ack>`
     as for `tell-manager`, so it starts once a day.
   - `tell-manager`: `t3_thread_send` to `threadId` with `message`.
     Once it's sent, run `node <this skill's folder>/dispatch-plan.mjs
     --ack <ack>` so the next tick doesn't send it again.

Never add a call the script didn't print, skip one it did, or change an
argument. If the output looks wrong, make no calls
and say so in your return line; the human fixes the script, not you.

## Return

Last line of output, one JSON object, nothing after it:

```
{"job":"dispatch","started":[221],"resumed":[118],"settled":[112],"triage":true,"research":false,"notes":["#220 is blocked with no Blocked by line"]}
```

Copy `notes` from the script. Nothing to do is `{"job":"dispatch"}`.
This thread wakes many times a day; one line per wake keeps it readable.
