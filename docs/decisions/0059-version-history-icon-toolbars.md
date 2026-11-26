# 0059: Version History shows compact cards with icon toolbars, and metadata on demand

**Status:** Accepted. Extends the icon primitives of [0058](0058-browser-local-nested-archives.md) §1 to Version
History and the VM's management sidebar ([0054](0054-navigation.md)). No API, contract, agent, schema or deployment
change.

## Context

Version History ([0039](0039-version-history-is-administrative.md) and later) drew each version as a card with every fact on
permanent display (created, parent, archive size, source agent, promotion, description, verification, local copies)
and up to eleven bordered, coloured text buttons on two or three rows, with permanent paragraphs explaining why an
action was unavailable. On a 1440 × 1000 window a card took 186–237 px and three versions fitted; on a phone a card
took 430–570 px. The red, blue and grey borders gave every action, destructive or not, the same weight as the versions
themselves.

Archive Explorer (0058) had just introduced Lucide and a small set of icon primitives. The second area to adopt them
should reuse them, not grow a second set.

## Decision

### 1. One set of primitives, extended where needed

Version History uses `IconButton`, `Toolbar`, `ToolbarGroup`, `ToolbarSeparator`, `ToolbarSpacer` and `InfoPopover`
from `apps/web/src/components/ui/`. Three additions, all backwards compatible (Archive Explorer passes none of them and
renders as before):

- **`IconButton` and `IconToggleButton`: `disabledReason`.** With `disabled`, a reason makes the button `aria-disabled`
  instead of natively disabled. It stays in the tab order, its reason is its accessible description
  (`aria-describedby`), and its tooltip reads "_Action_ unavailable" then the reason. A click is stopped before any
  handler of the caller's runs, so a disabled action never executes. Without a reason, `disabled` stays the native
  attribute.
- **`IconButton`: `danger`.** A destructive action is neutral at rest and turns to the danger colours only on hover
  and keyboard focus. Its confirmation dialog is unchanged.
- **`InfoPopover`: `tooltip` and `tooltipPlacement`,** so that a panel's button can have a long, unique accessible name
  ("Information about DOS622_202611182136") and a short tooltip ("Version information").
- **`StatusChip`** (new, `ui/StatusChip.tsx`): an icon and a few visible words, never colour alone. The complete
  statement is written once, as a tooltip that assistive technology also reads.

On a narrow screen (under 576 px), every `InfoPopover` panel becomes a sheet fixed to the bottom of the window, so
that it is never clipped by a nested card or a dialog.

### 2. The card

A card is three lines: the identity (expand/collapse chevron, Layers or Camera icon, title, label, Master/Snapshot,
short identifier), a summary (date and time, archive size, status chips, tags), and one toolbar. Everything else is in
the version's **Info** panel: kind, full identifier (selectable), created, promoted, parent (label and identifier, or
"None (root)"), children, source agent, the administrator who made it, tags, description, archive size, file count,
uncompressed size, repository, archive and manifest SHA-256, the publication-time verification, each agent's copy
with its state, deletion details, and every action that is unavailable now with its reason. Nothing the card used to
show was dropped; the archive SHA-256, manifest SHA-256 and "By" were not shown before and come from the same response.

Kept in view: a deletion in progress, and its last failure with **Retry now**.

### 3. Actions

| Group           | Action                          | Icon              | Accessible name (unchanged where it existed)                                                   |
| --------------- | ------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------- |
| Page            | Remaster from local copy        | RefreshCw         | Remaster from local copy                                                                       |
| Run and restore | Restore version                 | HardDriveDownload | Restore _name_ (was "Restore…")                                                                |
|                 | Run volatile                    | Play              | Run _name_ in Remote Volatile                                                                  |
|                 | Run and snapshot                | Camera            | Run _name_ in Remote Snapshot                                                                  |
|                 | Create snapshot from local copy | HardDriveUpload   | Create snapshot of _name_ from the local copy on _agent_ (was "Create snapshot from _agent_…") |
|                 | Import into VirtualBox          | Import            | Import _name_ into VirtualBox                                                                  |
|                 | Create snapshot (VirtualBox)    | Camera            | Create snapshot of _machine_ from _name_                                                       |
| Management      | Edit details                    | Pencil            | Edit details of _name_                                                                         |
|                 | Manage tags                     | Tags              | Tags of _name_                                                                                 |
|                 | Clone VM                        | CopyPlus          | Clone _name_ into a new VM                                                                     |
|                 | View contents                   | FolderOpen        | View the archive contents of _name_                                                            |
| Lifecycle       | Promote to master               | ArrowUpToLine     | Promote _name_ to master                                                                       |
|                 | Delete snapshot                 | Trash2            | Delete _name_                                                                                  |
| Information     | Version information             | Info              | Information about _name_                                                                       |
| Tree            | Collapse / Expand branch        | ChevronDown/Right | Collapse _name_ / Expand _name_                                                                |

`CameraPlus`, suggested for creating a snapshot from a local copy, is not in Lucide 1.69. `HardDriveUpload` is used
instead: the local copy is archived and uploaded as a new version, the mirror of Restore's `HardDriveDownload`.

Every action is shown under exactly the conditions it was before, and calls the same handler, which opens the same
dialog. The conditions for being disabled are unchanged; only their explanation is new where none was shown:

| Action                   | Disabled when (unchanged)                                | Reason given                                     |
| ------------------------ | -------------------------------------------------------- | ------------------------------------------------ |
| Restore                  | Repository disabled, being deleted, or no agent online   | Which of these it is                             |
| Run volatile / snapshot  | Version unavailable                                      | Being deleted, or repository disabled            |
| Clone, View contents     | Version unavailable                                      | Same                                             |
| Delete snapshot          | `deletable.eligible` is false                            | The server's refusal text, as before             |
| Import into VirtualBox   | Unavailable, being deleted, no importer online, or busy  | Which of these it is                             |
| Create snapshot (VBox)   | Unavailable, busy, machine running, or its agent offline | Which of these it is ("Power the machine off …") |
| Remaster from local copy | A remaster is exporting                                  | "A remaster is already in progress."             |

The page is for administrators only, as before; no action is shown to anyone it was hidden from. The API still checks
every request.

### 4. Status

| State                                    | Chip                                         | Tone    |
| ---------------------------------------- | -------------------------------------------- | ------- |
| Verified by the agent when published     | ShieldCheck "Verified when published"        | success |
| Hash recorded, manifest not recorded     | ShieldQuestion "Hash recorded"               | neutral |
| Repository disabled                      | ServerOff "Repository disabled"              | warning |
| Being deleted                            | Trash2 "Being deleted"                       | danger  |
| Local copy, verified                     | Monitor "Local · _agent_"                    | success |
| Local copy, modified                     | ShieldAlert "Local · _agent_ · modified"     | warning |
| Local copy, not verified since reconnect | ShieldAlert "Local · _agent_ · not verified" | warning |
| Working copy                             | MonitorCog "Working copy · _agent_"          | neutral |
| Promoted from a snapshot                 | ArrowUpToLine "Promoted"                     | neutral |
| Linked VirtualBox machine                | Link2 "Linked machine"                       | neutral |
| Several children                         | GitBranch "_n_ branches"                     | neutral |

"Verified when published" is historical: the chip's statement is the old sentence, and the Info panel adds that it
does not say the archive or any copy has been verified since. A copy's own state is a separate chip per agent and is
never merged into the archive's. The tree's data carries no agent connectivity, so no "agent offline" chip is drawn;
offline agents still appear where they did (restore reasons, VirtualBox).

### 5. Header, tree and sidebar

The page header is one line: History icon, "Version History", the count, then Remaster and the page's **Info**, which
holds the paragraph the page used to print. The tree keeps its `tree`/`treeitem`/`group` roles, levels, order and
per-branch expansion; each level is indented 1 rem (0.5 rem on a phone) and joined to its parent by a guide line and
an elbow. The VM sidebar draws a Lucide icon before each label (Settings, History, HardDrive, NotebookPen, Images) and
ArrowLeft before "Back to Catalog". `NavItem.icon` is optional; the Admin sidebar and the header are unchanged.

## Consequences

- On the same 1440 × 1000 window a card is 89–107 px instead of 186–237 px, and all five versions of the test history
  fit instead of three. On a 390 px phone a card is 176–282 px instead of 432–571 px, and the page no longer scrolls sideways by 1 px.
- Accessible names changed for three controls (Restore, Create snapshot from a local copy, Remaster); tests now find
  them by their new names. Disabled actions with a reason report `aria-disabled` rather than `disabled`; tests check
  both and prove a click does nothing.
- `apps/web/e2e/version-history.browser.test.ts` builds the whole application and checks layout, tooltips, Info,
  themes, the narrow layout and that browsing sends no request other than `GET`.
- The conventions are written down in [docs/ui-conventions.md](../ui-conventions.md) for the next areas.
