# Popout uses maximum-priority always-on-top

The Popout must be able to float above fullscreen applications (games, other creative tools) — that's PureRef's core use case. We use Electron's highest always-on-top level (`'screen-saver'` or equivalent) rather than the standard level, which can still be covered by other apps' fullscreen mode.

This level is known to behave inconsistently across operating systems (macOS in particular restricts what can appear above fullscreen Spaces), so per-platform testing and a possible fallback level are expected, not a guarantee that one setting works identically everywhere. In practice, v1 targets Windows only — the developer has no macOS/Linux machines to test on — so cross-platform behavior is unverified and explicitly deferred.
