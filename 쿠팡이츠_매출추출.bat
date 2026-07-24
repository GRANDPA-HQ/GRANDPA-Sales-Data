@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title 쿠팡이츠 매출 추출

echo ============================================
echo    쿠팡이츠 매출 내역 추출기
echo ============================================
echo.

REM --- Node 설치 확인 ---
where node >nul 2>nul
if errorlevel 1 (
  echo [오류] Node.js가 설치되어 있지 않습니다.
  echo https://nodejs.org 에서 설치 후 다시 실행하세요.
  echo.
  pause
  exit /b 1
)

REM --- 최초 1회 자동 설치 (node_modules 없을 때만) ---
if not exist "node_modules\playwright" (
  echo [최초 설정] 필요한 구성요소를 설치합니다. 잠시만 기다려 주세요...
  echo.
  call npm install
  call npx playwright install chromium
  echo.
  echo [설치 완료]
  echo.
)

REM --- 기간 선택 UI 창 띄우기 ---
echo 기간 선택 창을 여는 중입니다...
set "STARTD="
set "ENDD="
for /f "usebackq tokens=1,2 delims=|" %%a in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0date_picker.ps1"`) do (
  set "STARTD=%%a"
  set "ENDD=%%b"
)

REM --- 혹시 값이 비면 오늘 날짜로 (안전장치) ---
if "%STARTD%"=="" (
  for /f %%d in ('powershell -NoProfile -Command "(Get-Date).ToString('yyyy-MM-dd')"') do set "STARTD=%%d"
  set "ENDD=!STARTD!"
)

echo.
echo [선택 기간] !STARTD! ~ !ENDD!
echo.

node export_sales.js --start !STARTD! --end !ENDD!

echo.
echo --------------------------------------------
echo 결과 파일은 output 폴더에 저장되었습니다.
echo --------------------------------------------
echo.

REM 결과 폴더 열기 (원치 않으면 아래 줄 앞에 REM 붙이기)
if exist "output" start "" "output"

pause
endlocal
