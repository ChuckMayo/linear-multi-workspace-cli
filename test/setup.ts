// Disable picocolors' ANSI output BEFORE any test module imports it.
// picocolors evaluates `isColorSupported` once at module load time, and it
// treats the presence of `CI` in env as a signal to enable colors. GitHub
// Actions sets `CI=true` before the process starts, so without this setup
// file every snapshot that round-trips through `picocolors` would diverge
// from the locally-captured (un-colored) snapshot. Setting NO_COLOR in a
// per-file `beforeAll` is too late — picocolors has already cached the
// decision by then.
process.env.NO_COLOR = '1'
