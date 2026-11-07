# 0025: The hand-written decoders are limited by input, by allocation and by time

**Status:** Accepted. Replaces the last paragraph of [0019](0019-media-processing-and-storage.md), which left the time a request spends decoding PPM or BMP covered only by the size limit.

**The gap.** `sharp` runs off the main thread with its own timeout. The two decoders [0019](0019-media-processing-and-storage.md) added run on the event loop, and synchronous code cannot be
interrupted, so nothing limited their time. Text PPM is the worst of them: millions of small numbers, one at a time.

**Generators, rather than a worker.** A decoder yields every so often, and whoever runs it decides what that means. `decodeWithDeadline` gives the event loop a turn at each yield, and stops at the deadline.
A worker thread that can be terminated was the other option, and would interrupt anything at all. It would also mean a separate entry point, a second build output, and copying each image across a
thread boundary, for two decoders that are simple loops and that only ever hold the CPU for one slice at a time. No new process or service is involved, as was wanted. `decodePpm` and `decodeBmp` still exist, finishing in
one go, for code that has already bounded the work.

**Limits, in the order they apply:**

1. **The file's size,** before it is read: `MEDIA_MAX_UPLOAD_BYTES` for an upload.
2. **Dimensions and pixels,** from the header, before anything else happens: the existing `MEDIA_MAX_DIMENSION` and `MEDIA_MAX_PIXELS`.
3. **Whether the file can hold what its header claims,** before allocating. This was the real defect: a PPM of a few bytes could claim the maximum number of pixels, and get a buffer of that size, before being found
   to be short. The check came after the allocation for binary PPM, and did not exist for text PPM, where each sample needs at least two bytes.
4. **Time:** `MEDIA_PROCESSING_TIMEOUT_SECONDS`, covering the read and the decoding, as one deadline. Running out is a 503, which an agent retries, because it depends on how busy the server is. A malformed file is a
   422, which it does not.

**Consequences.** A large PPM takes slightly longer in total, in exchange for not blocking anything else. The deadline is checked between slices, so it can be overrun by one slice, which is a few
milliseconds of work.
