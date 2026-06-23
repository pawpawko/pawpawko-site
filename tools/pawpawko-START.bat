@echo off
REM Opens ONE Windows Terminal window:
REM   Tab 1 = FEATURES (left) | FIXES (right) split panes
REM   Tab 2 = Expo / Metro (mobile features)
REM Each pane runs its own _pp-*.bat helper (kept next to this file).
wt new-tab --title "Claude: FEATURES + FIXES" cmd /k %~dp0_pp-features.bat ; split-pane -V --title "FIXES" cmd /k %~dp0_pp-fixes.bat ; new-tab --title "Expo (mobile features)" cmd /k %~dp0_pp-expo.bat
