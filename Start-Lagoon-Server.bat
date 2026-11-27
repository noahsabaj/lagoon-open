@echo off
title Lagoon Open LAN Server
cd /d "%~dp0"
py -3 --version >nul 2>&1 && (py -3 lagoon-server.py & goto end)
python --version >nul 2>&1 && (python lagoon-server.py & goto end)
echo Python 3 was not found. Install Python 3 from https://www.python.org/downloads/ and re-run this script.
:end
pause
