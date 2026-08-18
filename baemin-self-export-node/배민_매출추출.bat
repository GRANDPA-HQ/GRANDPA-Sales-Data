@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title 배민 주문내역 추출

echo ============================================
echo    배민셀프서비스 주문내역 추출기
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [오류] Node.js가 설치되어 있지 않습니다.
  echo https://nodejs.org 에서 설치 후 다시 실행하세요.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\playwright" (
  echo [최초 설정] 필요한 구성요소를 설치합니다. 잠시만 기다려 주세요...
  echo.
  call npm install
  call npx playwright install chromium
  echo.
  echo [설치 완료]
  echo.
)

echo 기간 선택 창을 여는 중입니다...
set "STARTD="
set "ENDD="
for /f "usebackq tokens=1,2 delims=|" %%a in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0date_picker.ps1"`) do (
  set "STARTD=%%a"
  set "ENDD=%%b"
)

if "%STARTD%"=="" (
  for /f %%d in ('powershell -NoProfile -Command "(Get-Date).ToString('yyyy-MM-dd')"') do set "STARTD=%%d"
  set "ENDD=!STARTD!"
)

echo.
echo [선택 기간] !STARTD! ~ !ENDD!
echo.

node export_baemin.js --start !STARTD! --end !ENDD!

echo.
echo --------------------------------------------
echo 결과 파일은 output 폴더에 저장되었습니다.
echo --------------------------------------------
echo.

if exist "output" start "" "output"

pause
endlocal
