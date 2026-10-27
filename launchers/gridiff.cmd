@echo off
setlocal DisableDelayedExpansion
set "gridiff_arch=%PROCESSOR_ARCHITEW6432%"
if not defined gridiff_arch set "gridiff_arch=%PROCESSOR_ARCHITECTURE%"
if /I "%gridiff_arch%"=="ARM64" (
  echo Gridiff: Windows ARM64 native build is not available. 1>&2
  echo Run bin\windows-x64\gridiff.exe explicitly only if your system supports x64 emulation. 1>&2
  exit /b 1
)
if /I not "%gridiff_arch%"=="AMD64" (
  echo Gridiff: this launcher requires Windows x64. 1>&2
  exit /b 1
)
set "gridiff_binary=%~dp0bin\windows-x64\gridiff.exe"
if not exist "%gridiff_binary%" (
  echo Gridiff: executable is missing. Update the design repository first. 1>&2
  exit /b 1
)
findstr /b /l /c:"version https://git-lfs.github.com/spec/v1" "%gridiff_binary%" >nul 2>nul
if not errorlevel 1 (
  echo Gridiff: executable is still a Git LFS pointer. 1>&2
  echo Run git lfs pull in the design repository. 1>&2
  exit /b 1
)
"%gridiff_binary%" %*
exit /b %errorlevel%
