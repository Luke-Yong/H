; NSIS version-resource hooks.
; Runs BEFORE makensis finalizes the installer/uninstaller CRC,
; so the resulting Setup EXE's version strings are part of the signed blob
; and the integrity check passes.

!macro customInstall
  ; (reserved for future post-copy hooks)
!macroend

!macro customUnInstall
  ; (reserved for future post-delete hooks)
!macroend
