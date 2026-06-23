@echo off
REM Opens ONE Windows Terminal window:
REM   Tab 1 = FEATURES (left) | FIXES (right) split panes
REM   Tab 2 = Expo / Metro (mobile features)
REM Each pane runs its own _pp-*.bat helper (kept next to this file).

REM Locate Windows Terminal. Prefer it on PATH; otherwise use the Store app's
REM launcher stub directly (this machine's PATH is missing %LOCALAPPDATA%\...\WindowsApps).
set "WT=%LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe"
where wt >nul 2>nul && set "WT=wt"
if /i not "%WT%"=="wt" if not exist "%WT%" (
  echo.
  echo Windows Terminal ^(wt.exe^) could not be found.
  echo Install "Windows Terminal" from the Microsoft Store, then run this again.
  echo.
  pause
  exit /b 1
)

"%WT%" new-tab --title "Claude: FEATURES + FIXES" cmd /k %~dp0_pp-features.bat ; split-pane -V --title "FIXES" cmd /k %~dp0_pp-fixes.bat ; new-tab --title "Expo (mobile features)" cmd /k %~dp0_pp-expo.bat
