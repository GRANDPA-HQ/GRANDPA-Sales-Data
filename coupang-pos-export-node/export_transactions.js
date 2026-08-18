/**
 * 쿠팡 포스(coupangpos.com) - 매출 상세 내역 자동 추출 (엑셀 다운로드 -> CSV)
 *
 * 동작 방식 (봇 차단 회피 X, 실제 로그인 브라우저를 그대로 구동):
 *   1) Playwright가 '전용 크롬 프로필'로 브라우저를 띄운다.
 *   2) 첫 실행 때는 사람이 직접 로그인 -> 세션이 프로필에 저장됨.
 *   3) 이후 실행하면 저장된 세션으로 자동 로그인 상태가 되고,
 *      매출 상세 내역 화면의 "다운로드" 버튼이 호출하는 것과 동일한
 *      makeFile.do API를 페이지 안에서 호출해 엑셀 파일을 받아온다.
 *   4) 받은 엑셀을 그대로 저장하고, 표 형태 CSV로도 변환해 저장한다.
 *
 * 준비:
 *   npm install
 *   npx playwright install chromium
 *
 * 실행:
 *   node export_transactions.js                 # 오늘 하루치 (기본값)
 *   node export_transactions.js --days 7         # 최근 7일
 *   node export_transactions.js --start 2026-07-01 --end 2026-07-24
 *   node export_transactions.js --headless       # 창 없이 (첫 로그인 이후에만 권장)
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { chromium } = require("playwright");
const XLSX = require("xlsx");
const { loadEnv, syncToSupabase } = require("./supabase");

// ─────────────────────────────────────────────────────────────
// 설정
// ─────────────────────────────────────────────────────────────
const BASE = "https://sales.coupangpos.com";
const MAIN_URL = `${BASE}/Service/main#transactionHistory`;
const MAKE_FILE_PATH = "/Service/makeFile.do";

const SCRIPT_DIR = __dirname;
const PROFILE_DIR = path.join(SCRIPT_DIR, "coupos_profile"); // 로그인 세션 저장
const OUT_DIR = path.join(SCRIPT_DIR, "output"); // XLSX/CSV 저장

// ─────────────────────────────────────────────────────────────
// 인자 파싱
// ─────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { days: null, start: null, end: null, headless: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--days") a.days = parseInt(argv[++i], 10);
    else if (k === "--start") a.start = argv[++i];
    else if (k === "--end") a.end = argv[++i];
    else if (k === "--headless") a.headless = true;
  }
  return a;
}

function parseDate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function fmtDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function fmtDateCompact(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function parseRange(args) {
  let s, e;
  if (args.start && args.end) {
    s = parseDate(args.start);
    e = parseDate(args.end);
  } else if (args.days) {
    e = new Date();
    s = new Date();
    s.setDate(e.getDate() - (args.days - 1));
  } else {
    // 기본: 오늘 하루
    s = new Date();
    e = new Date();
  }
  return [s, e];
}

// ─────────────────────────────────────────────────────────────
// 페이지 컨텍스트 안에서 makeFile.do 호출 (다운로드 버튼과 동일 API)
// ─────────────────────────────────────────────────────────────
async function fetchTransactionFile(page, fdate, tdate) {
  return await page.evaluate(
    async ({ path, fdate, tdate }) => {
      try {
        const res = await fetch(
          `${path}?fdate=${fdate}&tdate=${tdate}&pay_type=&type=TransactionExcel`,
          {
            method: "POST",
            credentials: "include",
            headers: { "x-requested-with": "XMLHttpRequest" },
          }
        );
        const status = res.status;
        const buf = await res.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        return { status, base64: btoa(binary), contentType: res.headers.get("content-type") };
      } catch (e) {
        return { status: -1, error: String(e) };
      }
    },
    { path: MAKE_FILE_PATH, fdate, tdate }
  );
}

// xlsx 파일은 zip 포맷이라 항상 "PK"로 시작한다. 로그인 세션이 없으면
// HTML(로그인 페이지)이 내려오므로 이 매직 바이트로 성공 여부를 구분한다.
function isValidXlsxBuffer(buf) {
  return buf && buf.length > 2 && buf[0] === 0x50 && buf[1] === 0x4b;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans); }));
}

// ─────────────────────────────────────────────────────────────
// CSV 변환
// ─────────────────────────────────────────────────────────────
function csvCell(v) {
  const s = v == null ? "" : String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function xlsxBufferToCsv(buf) {
  const wb = XLSX.read(buf, { type: "buffer" });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" });
  const lines = rows.map((row) => row.map(csvCell).join(","));
  return { csv: lines.join("\r\n"), rows };
}

// ─────────────────────────────────────────────────────────────
// 메인
// ─────────────────────────────────────────────────────────────
(async () => {
  loadEnv(__dirname); // .env 로드 (Supabase 설정)
  const args = parseArgs(process.argv);
  const [startD, endD] = parseRange(args);
  const fdate = fmtDateCompact(startD);
  const tdate = fmtDateCompact(endD);
  console.log(`[조회 기간] ${fmtDate(startD)} ~ ${fmtDate(endD)}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: args.headless,
    viewport: { width: 1440, height: 900 },
    locale: "ko-KR",
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(MAIN_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);

  let result = await fetchTransactionFile(page, fdate, tdate);
  let buf = result.base64 ? Buffer.from(result.base64, "base64") : null;

  // 로그인 세션이 없으면 makeFile.do가 로그인 페이지(HTML)를 반환한다.
  if (!isValidXlsxBuffer(buf)) {
    console.log("\n[로그인 필요] 브라우저 창에서 직접 로그인해 주세요.");
    await ask("로그인 완료 후 매출 상세 내역 화면이 보이면 여기서 Enter를 누르세요... ");
    await page.goto(MAIN_URL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);

    result = await fetchTransactionFile(page, fdate, tdate);
    buf = result.base64 ? Buffer.from(result.base64, "base64") : null;
  }

  await ctx.close();

  if (!isValidXlsxBuffer(buf)) {
    console.log(`\n[실패] status=${result.status} ${result.error || ""}`);
    console.log("→ 세션이 만료됐거나 해당 기간에 데이터가 없을 수 있습니다. 창을 띄운 채(--headless 없이) 다시 시도하세요.");
    process.exit(1);
  }

  const stamp = `${fmtDate(startD)}_${fmtDate(endD)}`;

  // 1) 원본 엑셀 저장
  const xlsxPath = path.join(OUT_DIR, `pos_transactions_${stamp}.xlsx`);
  fs.writeFileSync(xlsxPath, buf);

  // 2) CSV 변환 저장 (엑셀 한글 깨짐 방지: UTF-8 BOM)
  const { csv, rows } = xlsxBufferToCsv(buf);
  const csvPath = path.join(OUT_DIR, `pos_transactions_${stamp}.csv`);
  fs.writeFileSync(csvPath, "﻿" + csv, "utf-8");

  const dataRows = rows.slice(1);
  console.log(`\n[주문 수집] ${dataRows.length}건`);
  console.log(`[XLSX] ${xlsxPath}`);
  console.log(`[CSV ] ${csvPath}`);

  // 3) Supabase 자동 적재 (.env 설정 시)
  await pushToSupabase(dataRows);
})().catch((e) => {
  console.error("오류:", e);
  process.exit(1);
});

// "품목" 텍스트에 메뉴와 함께 섞여 나오는 결제 관련 항목(메뉴가 아님) → item 분해에서 제외
const NON_MENU_LABELS = new Set(["추가결제", "선결제금 충전", "선결제금 추가"]);

// "품목" 텍스트를 콤마로 분해하되, 메뉴명 안 괄호 속 콤마(예: "아사이 볼 (No Sugar, Vegan)")는
// 무시한다. 단순 split(",")를 쓰면 괄호 안 콤마에서도 잘려 메뉴명이 반토막 난다.
function splitMenuItems(text) {
  const items = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);

    if (ch === "," && depth === 0) {
      items.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur) items.push(cur);
  return items.map((s) => s.trim()).filter(Boolean);
}

// ─────────────────────────────────────────────────────────────
// Supabase 적재: 거래 1행 = 주문 1건으로 매핑 후 UPSERT
// (원본에 주문 고유 ID가 없어 "판매시간"(초 단위)을 external_order_id로 사용)
// (원본에 품목별 수량이 없어 콤마로 분리한 각 품목을 quantity=1로 저장.
//  단, "추가결제"/"선결제금 충전"은 메뉴가 아니므로 item 목록에서 제외)
// ─────────────────────────────────────────────────────────────
async function pushToSupabase(dataRows) {
  const platform = "coupang_pos";
  const orderRows = [];
  const itemsByExtId = [];
  // 판매시간(초 단위)이 같은 서로 다른 거래가 존재할 수 있어(예: 정상판매/환불이 같은 초에 찍힘),
  // 같은 배치 안에서 external_order_id가 겹치면 -2, -3 ... 접미사를 붙여 구분한다.
  // (겹친 채로 upsert하면 "ON CONFLICT DO UPDATE command cannot affect row a second time" 에러가 남)
  const seenExtIds = new Map();

  for (const r of dataRows) {
    const [saleDate, itemsText, saleTime, type, payMethod, amountStr] = r;
    if (!saleTime) continue;
    const baseExtId = saleTime.replace(/[^0-9]/g, ""); // "2026-07-27 07:13:49" -> "20260727071349"
    const seenCount = (seenExtIds.get(baseExtId) ?? 0) + 1;
    seenExtIds.set(baseExtId, seenCount);
    const extId = seenCount === 1 ? baseExtId : `${baseExtId}-${seenCount}`;
    const amount = Number(amountStr) || 0;
    const isRefund = (type || "").includes("환불");

    orderRows.push({
      platform,
      external_order_id: extId,
      order_number: null,
      order_datetime: `${saleTime.replace(" ", "T")}+09:00`,
      status: type || "UNKNOWN",
      total_amount: amount,
      settlement_amount: null,
      discount_amount: 0,
      commission_amount: 0,
      raw: { 매출일자: saleDate, 품목: itemsText, 판매시간: saleTime, 구분: type, 지불방법: payMethod, 판매금액: amount },
    });

    const itemNames = splitMenuItems(itemsText || "").filter((s) => !NON_MENU_LABELS.has(s));
    itemsByExtId.push({
      ext: `${platform}|${extId}`,
      items: itemNames.map((name) => ({
        raw_name: name,
        quantity: 1,
        unit_price: null,
        subtotal: null,
        is_canceled: isRefund,
        options: null,
      })),
    });
  }

  await syncToSupabase(orderRows, itemsByExtId);
}
