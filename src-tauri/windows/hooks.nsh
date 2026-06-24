; Tauri NSIS installer hooks.
; Add a Desktop shortcut on install (Tauri only makes a Start Menu one by
; default), and clean it up on uninstall. The shortcut targets the installed
; exe, so it carries the app's embedded icon (the shades-and-phone blob).

!macro NSIS_HOOK_POSTINSTALL
  CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$DESKTOP\${PRODUCTNAME}.lnk"
!macroend
