# 0054. Two navigation levels, and the catalog as the only way into a VM's management

## Context

The header had grown into the only menu: Catalog, Dashboard, Manage, Agents, Registrations, Repositories and Settings
side by side, while a VM's administration was one very long page (metadata, run and verify, restore, version history,
notes and screenshots) with a separate media page. A VM's management could be reached from the header ("Manage", the
catalog management page), from the dashboard, from the public VM page and from links in other pages, and the Admin area
had no structure of its own.

## Decision

The web application has two coordinated navigation levels, defined in one place (`apps/web/src/navigation.ts`):

1. **The header's global areas: Catalog and Admin.** Admin is shown only to administrators. A VM's management
   (`/admin/vms/…`) belongs to the Catalog area, because that is where it is reached from.
2. **A contextual sidebar** for the area that is open:
   - **Admin:** Agents, Registrations, Repositories, Appearance, Application Updates, in that order. `/admin` opens
     the first of them.
   - **A VM's management:** General, Version History, Local copies and restore, Notes, Screenshots, in that order,
     with the VM's name and a way back to the catalog.

**The catalog is the only navigation entry into a VM's management.** An administrator's catalog lists every
registered VM, public or private, with the counts the dashboard used to show. A public VM opens on its public page,
whose **Manage this VM** action leads on; a private VM, which has no public page, opens on its management directly.
No menu, the Admin sidebar included, offers a way in. Contextual links that already name one VM (an operation's
result, a clone's source, an agent's copies) still lead to it: they are part of a workflow, not a menu, and removing
them would only make administrators search the catalog for a VM the page already names.

Each section is a route, so the address, refresh, back and forward, bookmarks and the highlighted entry all agree:

| Section                  | Route                              | What it holds                                                                    |
| ------------------------ | ---------------------------------- | -------------------------------------------------------------------------------- |
| General                  | `/admin/vms/:emulatorType/:vmName` | Visibility, metadata, tags, details, Run and verify                              |
| Version History          | `…/versions`                       | The version tree: details, tags, snapshots, promotion, remaster, restore, clone  |
| Local copies and restore | `…/copies`                         | Agents' copies, restore and replace, removal, history; a VirtualBox VM's machine |
| Notes                    | `…/notes`                          | The VM's Markdown notes                                                          |
| Screenshots              | `…/screenshots`                    | Gallery, cover, order, tags, deletion, synchronization status                    |

The VM is read once by the layout and shared by its sections, as is a VirtualBox VM's machine poll. Choosing **Run**
on a version in the history chooses it in the run panel and opens General, which stays the one place to run.

**Compatibility.** Every earlier address keeps working: `/admin/catalog` leads to the catalog with its filters,
`/admin` to Agents, `/settings` to Appearance for an administrator (a user who is not one keeps a Settings page with
the theme and server facts), `…/media` to Screenshots, and a link to a version on the VM's page (`…#version-<id>`) to
Version History with the same anchor. Public VM addresses (`/vms/:emulatorType/:vmName`) are unchanged.

**Unsaved notes.** The application runs under a data router (`createBrowserRouter`) whose single splat route renders
the declarative routes, only so that the notes editor can ask before any in-application navigation discards its
changes (`useBlocker`). Closing or reloading the tab stays the browser's own question.

## Consequences

- Route guards decide what a page shows; the API decides every request, as before. Hiding Admin is never what keeps
  anyone out: a user who is not an administrator who follows a direct link to an Admin page or a VM's management gets
  "Administrators only" without a single administrative request.
- General no longer loads the version history, the notes or the screenshots, so opening a VM makes fewer requests;
  each section loads what it shows when it is opened.
- A new destination is one entry in `navigation.ts` and one route.
- Below 992 px the sidebar collapses behind a button that names the menu and the current destination; it closes when a
  destination is chosen, on Escape (returning focus to the button) and on back or forward.
