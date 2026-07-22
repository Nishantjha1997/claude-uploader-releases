# Claude Usage Uploader v2.0.5

Maintenance handover release.

## What changed

- Moves the auto-update manifest from the original maintainer Gist to the new maintainer Gist owned by `tpansuriya-ship-it`.
- Keeps the v2.0.4 reliability fixes intact: side-by-side Windows updates, bundled ccusage, background health task, schedule controls, and safer update confirmation.
- Keeps release packaging smoke-gated so the Windows binary must start successfully before GitHub release assets are published.

## Rollout note

The original Gist is updated one final time to point existing clients to v2.0.5. After clients install v2.0.5, future releases are controlled by:

`https://gist.github.com/tpansuriya-ship-it/efa5db7d25aaa85db78d8bdc402f9903`

