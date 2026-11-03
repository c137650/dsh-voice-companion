@echo off
setlocal
title Voice Bridge
rem Start only the voice bridge on http://127.0.0.1:8765.
rem Models load lazily on the first /api/stt or /api/tts call.

set "REPO_ROOT=%~dp0.."
set "VENV=%REPO_ROOT%\venv-speech\Scripts\python.exe"
rem Fall back to the Anaconda tts0 env (torch + funasr + speech-to-speech).
if not exist "%VENV%" set "VENV=E:\anaconda\envs\tts0\python.exe"

if not exist "%VENV%" (
    echo [ERROR] no python interpreter found for the bridge
    echo         looked for: %REPO_ROOT%\venv-speech\Scripts\python.exe
    echo                     E:\anaconda\envs\tts0\python.exe
    pause
    exit /b 1
)

cd /d "%~dp0"
if not exist "%REPO_ROOT%\models\silero-vad\silero_vad_v4.jit" (
    echo [WARN] silero-vad model missing: %REPO_ROOT%\models\silero-vad\silero_vad_v4.jit
)
if not exist "%REPO_ROOT%\models\funasr" (
    echo [WARN] funasr model dir missing: %REPO_ROOT%\models\funasr
)
echo Starting voice bridge on http://127.0.0.1:8765 ...
echo (models load lazily on first STT/TTS call; first TTS warms up 10-60s)
"%VENV%" -m uvicorn voice_bridge:app --host 127.0.0.1 --port 8765

pause

