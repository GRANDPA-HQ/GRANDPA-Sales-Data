@echo off
REM ============================================================
REM 쿠팡이츠 매출 자동 추출 - 매일 자동 실행용 (작업 스케줄러 등록)
REM   - 창 없이 조용히 어제 하루치를 뽑아 output 폴더에 저장/로그
REM   - 최초 로그인은 반드시 "쿠팡이츠_매출추출.bat" 을 먼저 1회 실행해 두세요.
REM ============================================================
cd /d "%~dp0"

if not exist "node_modules\playwright" (
  call npm install
  call npx playwright install chromium
)

if not exist "output" mkdir "output"

node export_sales.js --days 1 >> "output\run_log.txt" 2>&1
