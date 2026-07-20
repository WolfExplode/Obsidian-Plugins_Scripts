@echo off
REM Double-click entry point: runs the PowerShell launcher with execution policy bypassed.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch-obsidian-debug.ps1"
pause
