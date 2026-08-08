# Papercuts

> Small frictions logged during work. Fix them in one pass when the list is long.


## Testing

- **`ecb880ac`** `unknown` — writing follow-mode tests for the concertLog async generator with fake timers > the generator reaches its poll sleep only after real fs I/O, so a single advanceTimersByTimeAsync fires nothing and the test hangs indefinitely; the helper needs to keep advancing until pending settles
  <sub>craig · 2026-08-08 14:15 UTC</sub>

---
_Generated 2026-08-08 14:15:55 UTC by `papercut`. DB: `/Users/craig/Code/sleekslush/orchestron/papercuts.sqlite`_
