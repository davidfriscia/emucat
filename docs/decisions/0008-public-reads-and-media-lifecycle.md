# 0008: Public reads, and the lifecycle of media files

**Status:** Accepted

## Explicit shapes on every public response

Public queries name each column they read, and mappers build each response field by field. A column added to a
table later therefore cannot reach the public by accident. The response schemas are strict too, so the web app
rejects a response with an unexpected field, and tests assert that sentinel values in private columns never appear.

Card images come from the existing `public_catalog_card_media` view, as [0004](0004-schema-invariants.md) intends.
The rest of the detail page's gallery, and the image files themselves, come from queries that require both a public
VM and published media.

A private VM answers exactly like a missing one, so its existence is not revealed.

## Serving files through the API

Images are always served by a route that checks the database first, because the storage directory holds private
media beside published. Direct static serving would have made every unpublished file one guessed URL away.

Public responses use `Cache-Control: no-cache`, which allows storing but requires revalidation. Long-lived caching
would be faster, but privatizing an image has to take effect at once. Storage keys are checked before use, and a key
that could reach outside the storage root is refused even though keys only come from the database.

## Deleting media

A delete touches a database row and two files, which cannot share a transaction. The order was chosen by what each
failure leaves behind:

| Order                               | If the second step fails                                    |
| ----------------------------------- | ----------------------------------------------------------- |
| Commit the delete, then the files   | Orphaned files that nothing lists, and which may be private |
| Files, then the delete (**chosen**) | A listed item with missing files, which a retry can finish  |

The row is deleted inside an open transaction, then the files are removed, then it commits. A file error rolls the row
back, so it stays listed and the delete can be retried, since removing an absent file succeeds. If only one of two
files went, the item shows a placeholder until then. A file that another row still refers to is left alone.

## Selecting the main image

Every change to a VM's main selection locks the VM row first. Concurrent changes then run one at a time, in one lock
order, so they cannot deadlock on the unique index that allows one main item per VM.

Selecting private media is allowed, and the administration page says what it will do: the public keeps seeing the
placeholder until it is published. Forbidding it would make "set up the main image, then publish" impossible.

## Consequences

- Every image request costs a database query. That is the price of the privacy guarantee, and caching can be added
  with revalidation if it ever matters.
- No ETag exists yet, so revalidation always transfers the file.
- Uploads create files before rows, for the same reason as above in reverse. See [0019](0019-media-processing-and-storage.md).
