# Git for Windows runtime staging directory

Official Windows builds stage the pinned 64-bit PortableGit distribution here before `electron-builder` runs. The staged tree must contain `usr/bin/bash.exe` and `cmd/git.exe`; packaging and smoke tests fail when either executable is absent.

The binary distribution is intentionally produced by the release job rather than checked into Git. Its version and SHA-256 values must match `component-manifest.json` under `ThirdPartyNotices/Git-for-Windows`.
