# 0047: An import links the machine it creates, and pages poll at the pace of what they show

**Status:** Accepted. VB3 follow-up. Revises [0046](0046-virtualbox-management.md) on one point: a link no longer
changes only by hand, since an import an administrator asked for can make one.

## Context

After an import, an administrator almost always linked the new machine at once, by hand, with a second dialog.
Separately, the page of a VirtualBox VM was found making about 600 requests in under four minutes: each session
card, ended ones included, polled its screenshot status every 1.5 seconds, and the machine was polled twice, once
for the machine panel and once for the version history.

## Decision

### An import links its machine, as its request said

The import request names the machine the administrator saw linked (`replaceMachineUuid`, or `null`) and whether to
replace it (`replaceSource`). The server refuses the request if that link is no longer the current one, and records
what the import will do: `link` when the VM has no machine, `relink` when the administrator explicitly agreed to
replace it (which requires that machine powered off, now), or nothing, which keeps the current link.

Once the agent reports a successful import, with the one machine it created, the server makes the link in a
transaction of its own, with every check of a link made by hand, and two more: the link must still be the one the
administrator saw, and a replaced machine must still be powered off. The import is recorded as a success first, so a
refused link never undoes it, never deletes the machine and is never a reason to import again. The refusal is kept
on the import (`link_state = 'failed'`, with its code), and `POST …/virtualbox/operations/:id/link` retries the link
alone. A link left `pending` by a restart is made when the agent next says hello, or when it reports the result
again. Nothing ever shuts down or deletes the old machine.

The machine comes from the version imported, so that is its lineage, and the next snapshot must name it as parent:
importing an older version makes that version the parent, not the newest one.

Manual link, relink and unlink are unchanged.

### Polling follows what is on the page

- One poll of a VirtualBox VM's machine serves every panel of its page: 2 s while an import or deletion runs, 30 s
  otherwise. When one finishes, the rest of the page refreshes.
- The run panel polls at 3 s while the machine starts or stops, 10 s while it runs and 30 s while it is powered off.
- Screenshot status is polled every 15 s for a running session, every 2 s only while a capture is pending, and read
  once for an ended session.
- A VirtualBox VM's workspaces and restore options are read once; its versions every 30 s.
- A change of pace only reschedules, and nothing is polled while the browser tab is hidden, the API status badge
  included.

`apps/web/test/virtualbox-management.test.tsx` measures it: the page of a VirtualBox VM with a running session and
three ended ones makes 100 requests in 224 simulated seconds, where it made about 600, and each ended session's
screenshots are read once.

Successful reads are logged at `debug`; changes and WebSocket upgrades at `info`; refusals at `warn` and server
failures at `error`.
