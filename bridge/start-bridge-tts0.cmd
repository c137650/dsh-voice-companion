@echo off
setlocal
title Voice Bridge (tts0)
rem Start the voice bridge with the Anaconda tts0 interpreter
rem (has CUDA torch 2.10 + funasr + speech-to-speech). Port 8765.

set "PY=E:\anaconda\envs\tts0\python.exe"

if not exist "%PY%" (
    echo [ERROR] tts0 python not found: %PY%
    pause
    exit /b 1
)

cd /d "%~dp0"
echo Starting voice bridge on http://127.0.0.1:8765 using tts0 ...
echo (models load lazily on first STT/TTS call; first TTS warms up 10-60s)
"%PY%" -m uvicorn voice_bridge:app --host 127.0.0.1 --port 8765

pause
