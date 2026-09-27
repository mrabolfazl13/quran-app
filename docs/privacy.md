# Privacy

No accounts, no telemetry, no analytics, no crash reporting, no ad SDKs, no
sign-in, no sync, no push. The app has no reason to reach the network and, at
runtime, does not.

## What is stored, and where

Everything lives in one SQLite file inside the app's private data directory
(Windows: `%LOCALAPPDATA%\<app>\`; Android: app-private storage). Owner: the
user's device only.

Personal data: memorisation targets and attempt history (the most intimate
record in this app — it describes exactly which verses a person forgets), notes
and reflections, bookmarks, reading positions and history, settings, confusion
groups, learning journeys, daily plans.

Religious content is not personal data: the packs are read-only and excluded
from backups.

## Rules the code must keep

1. No runtime network calls. A feature that needs one is not built rather than
   built with a fallback.
2. No identifiers that could join a device to a person: no advertising id, no
   install fingerprint, no analytics client id.
3. Notes, reflections and attempt text are stored in the clear inside the
   private DB — acceptable for a single-user offline device, and stated here
   rather than implied. On Android the file inherits app-private storage;
   encrypting it is a documented future option, not a current claim.
4. Backup files are plaintext JSON with a checksum. They contain everything the
   user recorded, including notes. The export screen says so, in Persian, and
   the file name carries the date so a stale copy is recognisable.
5. Deleting the app removes the only copy. There is no server to call. The app
   says this before the user's first backup, not after their first loss.
6. Any optional local model runs entirely on-device; nothing is uploaded, and
   no inference result is stored as scripture.

## Data removal

Clearing the app's data directory, or the in-app reset, deletes user tables.
Content packs remain, since they are shipped, not collected.
