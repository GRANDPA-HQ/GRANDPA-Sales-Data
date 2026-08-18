@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title 전체 매출 추출 (쿠팡이츠 -^> 쿠팡포스 -^> 배민)

set "COUPANG_EATS_DIR=%~dp0"
set "COUPANG_POS_DIR=%~dp0coupang-pos-export-node"
set "BAEMIN_DIR=%~dp0baemin-self-export-node"

echo ============================================
echo    전체 매출 자동 추출기
echo    (쿠팡이츠 -^> 쿠팡포스 -^> 배민)
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

REM --- 대상 폴더 확인 ---
if not exist "!COUPANG_POS_DIR!" (
  echo [오류] 쿠팡포스 폴더를 찾을 수 없습니다: !COUPANG_POS_DIR!
  pause
  exit /b 1
)
if not exist "!BAEMIN_DIR!" (
  echo [오류] 배민 폴더를 찾을 수 없습니다: !BAEMIN_DIR!
  pause
  exit /b 1
)

REM --- 기간 선택 UI (한 번 선택해서 세 곳 모두에 적용) ---
echo 기간 선택 창을 띄우는 중입니다...
set "STARTD="
set "ENDD="
for /f "usebackq tokens=1,2 delims=|" %%a in (`powershell -NoProfile -ExecutionPolicy Bypass -File "!COUPANG_EATS_DIR!date_picker.ps1"`) do (
  set "STARTD=%%a"
  set "ENDD=%%b"
)

if "%STARTD%"=="" (
  for /f %%d in ('powershell -NoProfile -Command "(Get-Date).ToString('yyyy-MM-dd')"') do set "STARTD=%%d"
  set "ENDD=!STARTD!"
)

echo.
echo [추출 기간] !STARTD! ~ !ENDD!
echo.

REM ============================================
REM 1) 쿠팡이츠 매출 추출
REM ============================================
echo ============================================
echo  [1/3] 쿠팡이츠 매출 추출 시작
echo ============================================
pushd "!COUPANG_EATS_DIR!"
if not exist "node_modules\playwright" (
  echo [최초 실행] 필요한 구성요소를 설치합니다...
  call npm install
  call npx playwright install chromium
)
node export_sales.js --start !STARTD! --end !ENDD!
if errorlevel 1 (
  echo [오류] 쿠팡이츠 매출 추출 중 오류가 발생했습니다.
  popd
  pause
  exit /b 1
)
popd
echo [1/3] 쿠팡이츠 매출 추출 완료
echo.

REM ============================================
REM 2) 쿠팡포스 매출 추출
REM ============================================
echo ============================================
echo  [2/3] 쿠팡포스 매출 추출 시작
echo ============================================
pushd "!COUPANG_POS_DIR!"
if not exist "node_modules\playwright" (
  echo [최초 실행] 필요한 구성요소를 설치합니다...
  call npm install
  call npx playwright install chromium
)
node export_transactions.js --start !STARTD! --end !ENDD!
if errorlevel 1 (
  echo [오류] 쿠팡포스 매출 추출 중 오류가 발생했습니다.
  popd
  pause
  exit /b 1
)
popd
echo [2/3] 쿠팡포스 매출 추출 완료
echo.

REM ============================================
REM 3) 배민 매출 추출
REM ============================================
echo ============================================
echo  [3/3] 배민 매출 추출 시작
echo ============================================
pushd "!BAEMIN_DIR!"
if not exist "node_modules\playwright" (
  echo [최초 실행] 필요한 구성요소를 설치합니다...
  call npm install
  call npx playwright install chromium
)
node export_baemin.js --start !STARTD! --end !ENDD!
if errorlevel 1 (
  echo [오류] 배민 매출 추출 중 오류가 발생했습니다.
  popd
  pause
  exit /b 1
)
popd
echo [3/3] 배민 매출 추출 완료
echo.

echo ============================================
echo  전체 매출 추출이 모두 완료되었습니다.
echo ============================================
echo.
echo   1^) 쿠팡이츠 output: !COUPANG_EATS_DIR!output
echo   2^) 쿠팡포스 output: !COUPANG_POS_DIR!\output
echo   3^) 배민   output: !BAEMIN_DIR!\output
echo.

if exist "!COUPANG_EATS_DIR!output" start "" "!COUPANG_EATS_DIR!output"
if exist "!COUPANG_POS_DIR!\output" start "" "!COUPANG_POS_DIR!\output"
if exist "!BAEMIN_DIR!\output" start "" "!BAEMIN_DIR!\output"

pause
endlocal
