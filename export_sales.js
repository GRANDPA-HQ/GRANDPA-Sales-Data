/**
 * 쿠팡이츠 사장님 포털 - 매출 내역 자동 추출 (JSON -> CSV) : Node.js 버전
 *
 * 동작 방식 (봇 차단 회피 X, 실제 로그인 브라우저를 그대로 구동):
 *   1) Playwright가 '전용 크롬 프로필'로 브라우저를 띄운다.
 *   2) 첫 실행 때는 사람이 직접 로그인 -> 세션이 프로필에 저장됨.
 *   3) 이후 매일 실행하면 저장된 세션으로 자동 로그인 상태가 되고,
 *      매출관리 API(condition)를 페이지 안에서 호출해 전체 주문을 받아온다.
 *   4) 원본 JSON을 그대로 덤프(dump)하고, 표 형태 CSV로도 저장한다.
 *
 * 준비:
 *   npm install
 *   npx playwright install chromium
 *
 * 실행:
 *   node export_sales.js                 # 어제 하루치
 *   node export_sales.js --days 7        # 최근 7일
 *   node export_sales.js --start 2026-07-01 --end 2026-07-24
 *   node export_sales.js --headless      # 창 없이 (첫 로그인 이후에만 권장)
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { chromium } = require("playwright");
const { loadEnv, syncToSupabase } = require("./supabase");

// ─────────────────────────────────────────────────────────────
// 설정
// ─────────────────────────────────────────────────────────────
const STORE_ID = 132379; // 매장 ID (URL 뒤 숫자)
const BASE = "https://store.coupangeats.com";
const ORDERS_URL = `${BASE}/merchant/management/orders/${STORE_ID}`;
const API_URL = `${BASE}/api/v1/merchant/web/order/condition`;

const SCRIPT_DIR = __dirname;
const PROFILE_DIR = path.join(SCRIPT_DIR, "coupang_profile"); // 로그인 세션 저장
const OUT_DIR = path.join(SCRIPT_DIR, "output"); // JSON/CSV 저장
const PAGE_SIZE = 10; // 한 페이지당 주문 수 (앱과 동일, 상한이 있어 크게 못 함)
const PAGE_DELAY_MS = 30000; // 페이지 사이 대기 (속도 제한 10056 회피)

// ─────────────────────────────────────────────────────────────
// 인자 파싱
// ─────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { days: null, start: null, end: null, headless: false, today: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--days") a.days = parseInt(argv[++i], 10);
    else if (k === "--start") a.start = argv[++i];
    else if (k === "--end") a.end = argv[++i];
    else if (k === "--headless") a.headless = true;
    else if (k === "--today") a.today = true;
  }
  return a;
}

// ─────────────────────────────────────────────────────────────
// 날짜 → epoch(ms). 하루 시작(00:00:00.000) / 끝(23:59:59.999)
// ─────────────────────────────────────────────────────────────
function dayStartMs(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
}
function dayEndMs(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();
}
function parseDate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function fmtDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function parseRange(args) {
  let s, e;
  if (args.today) {
    s = new Date();
    e = new Date();
  } else if (args.start && args.end) {
    s = parseDate(args.start);
    e = parseDate(args.end);
  } else if (args.days) {
    e = new Date();
    s = new Date();
    s.setDate(e.getDate() - (args.days - 1));
  } else {
    // 기본: 어제 하루
    e = new Date();
    e.setDate(e.getDate() - 1);
    s = new Date(e);
  }
  return [s, e];
}

// ─────────────────────────────────────────────────────────────
// 페이지 컨텍스트 안에서 condition API 호출
// (커스텀 헤더 x-request-meta 등을 붙여야 방화벽 통과)
// ─────────────────────────────────────────────────────────────
// 한 페이지(pageNumber)만 호출해서 { status, data } 반환
async function fetchOnePage(page, args, pageNumber) {
  return await page.evaluate(async ({ apiUrl, storeId, startDate, endDate, pageSize, pageNumber }) => {
    const uuid = () => crypto.randomUUID();
    const meta = btoa(
      JSON.stringify({
        o: location.origin, ua: navigator.userAgent, r: location.href,
        t: Date.now(), sr: `${screen.width}x${screen.height}`, l: "ko-KR",
      })
    );
    const headers = {
      accept: "application/json",
      "accept-language": "ko-KR",
      "content-type": "application/json;charset=UTF-8",
      "x-event-type": "page_view",
      "x-page-id": uuid(),
      "x-page-type": "orders",
      "x-request-meta": meta,
      "x-requested-with": "XMLHttpRequest",
      "x-trace-id": uuid(),
    };
    let status = 0, data = null;
    try {
      const res = await fetch(apiUrl, {
        method: "POST", credentials: "include", headers,
        body: JSON.stringify({ pageNumber, pageSize, storeId, startDate, endDate }),
      });
      status = res.status;
      const text = await res.text();
      try { data = JSON.parse(text); } catch (e) { data = null; }
    } catch (e) { status = -1; }
    return { status, data };
  }, { apiUrl: API_URL, storeId: STORE_ID, startDate: args.startMs, endDate: args.endMs, pageSize: PAGE_SIZE, pageNumber });
}

// 유효한 응답인지 (속도 제한/오류 시 200이어도 orderPageVo가 없다)
function isValid(r) {
  return r && r.status === 200 && r.data && r.data.orderPageVo != null;
}

// 한 페이지 요청. 속도 제한(10056)에 걸리면 30초 쉬고 다시 시도.
async function fetchPageWithRetry(page, args, pageNumber, tries) {
  for (let i = 1; i <= tries; i++) {
    const r = await fetchOnePage(page, args, pageNumber);
    if (isValid(r)) return r.data;
    const msg = r && r.data && r.data.error ? r.data.error.message : `status=${r ? r.status : "?"}`;
    if (i < tries) {
      console.log(`   요청 제한 감지 (${msg}) → 30초 대기 후 재시도 (${i}/${tries})`);
      await page.waitForTimeout(PAGE_DELAY_MS);
    } else {
      console.log(`   실패: ${msg}`);
    }
  }
  return null;
}

// 전체 주문 수집: 페이지마다 30초 간격으로 천천히 (속도 제한 회피)
async function fetchAllOrders(page, args) {
  const first = await fetchPageWithRetry(page, args, 0, 4);
  if (!first) {
    return { error: true, status: "제한", text: "요청 제한으로 데이터를 받지 못했습니다." };
  }
  const summary = {
    totalSalePrice: first.totalSalePrice,
    totalOrderCount: first.totalOrderCount,
    totalCancelledOrderCount: first.totalCancelledOrderCount,
    avgOrderAmount: first.avgOrderAmount,
  };
  let all = (first.orderPageVo.content || []).slice();
  const total = first.orderPageVo.totalElements != null ? first.orderPageVo.totalElements : all.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  console.log(`총 ${total}건 (${totalPages}페이지). 페이지당 30초 간격으로 수집합니다...`);
  console.log(`  [1/${totalPages}] ${all.length}건 수집`);

  let pageNumber = 1;
  while (all.length < total && pageNumber <= 500) {
    await page.waitForTimeout(PAGE_DELAY_MS); // 다음 페이지 전 30초 대기
    const d = await fetchPageWithRetry(page, args, pageNumber, 4);
    if (!d) break;
    const content = d.orderPageVo.content || [];
    if (content.length === 0) break;
    all = all.concat(content);
    console.log(`  [${pageNumber + 1}/${totalPages}] 누적 ${all.length}건`);
    pageNumber += 1;
  }
  return { error: false, summary, orders: all };
}

// ─────────────────────────────────────────────────────────────
// 주문 1건 → CSV 한 행으로 평탄화
// ─────────────────────────────────────────────────────────────
function msToStr(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// CSV에 내보낼 컬럼 (원하는 것만 남김)
const CSV_COLUMNS = ["주문일시", "주문번호", "메뉴", "주문금액"];

// 주문일시: 엑셀이 날짜로 인식하는 하이픈 형식, 분까지 (예: 2026-07-23 19:53)
function fmtDateTimeMin(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function flattenOrder(o) {
  const items = o.items || [];
  const menu = items.map((it) => `${it.name || ""} x${it.quantity || 0}`).join(", ");
  const settle = o.orderSettlement || {};
  return {
    주문일시: fmtDateTimeMin(o.createdAt),
    주문번호: o.abbrOrderId || "",
    주문ID: o.orderId != null ? String(o.orderId) : "",
    상태: o.status || "",
    유형: o.type || "",
    메뉴: menu,
    주문금액: o.totalAmount ?? "",
    실지급액: o.actuallyAmount ?? "",
    판매가: o.salePrice ?? "",
    할인액: o.discountPrice ?? "",
    취소금액: o.canceledAmount ?? "",
    수수료합계: settle.commissionTotal ?? "",
    수수료VAT: settle.commissionVat ?? "",
    부분취소: o.partialCanceled ?? "",
    리뷰평점: o.reviewRating ?? "",
    취소일시: msToStr(o.canceledAt),
    요청사항: (o.note || "").trim(),
  };
}

// CSV 셀 이스케이프 (쉼표/따옴표/줄바꿈 처리)
function csvCell(v) {
  const s = v == null ? "" : String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function toCsv(rows) {
  const lines = [CSV_COLUMNS.join(",")];
  for (const r of rows) lines.push(CSV_COLUMNS.map((c) => csvCell(r[c])).join(","));
  return lines.join("\r\n");
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans); }));
}

// ─────────────────────────────────────────────────────────────
// 메인
// ─────────────────────────────────────────────────────────────
(async () => {
  loadEnv(__dirname); // .env 로드 (Supabase 설정)
  const args = parseArgs(process.argv);
  const [startD, endD] = parseRange(args);
  args.startMs = dayStartMs(startD);
  args.endMs = dayEndMs(endD);
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
  await page.goto(ORDERS_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  // 로그인 여부 확인: 로그인 화면으로 튕겼으면 사람이 직접 로그인
  if (page.url().includes("login") || page.url().includes("auth")) {
    console.log("\n[로그인 필요] 브라우저 창에서 직접 로그인해 주세요.");
    await ask("로그인 완료 후 매출관리 페이지가 보이면 여기서 Enter를 누르세요... ");
    await page.goto(ORDERS_URL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
  }

  // ── 봇 차단(Akamai) 통과를 위한 워밍업 ──
  // 앱이 스스로 첫 매출조회 요청을 보내면 Akamai 검증이 끝난다.
  // 그 요청이 끝난 뒤에야 우리가 직접 호출해도 200으로 통과된다.
  console.log("브라우저 준비 중... (봇 차단 통과 대기)");
  await page
    .waitForResponse((r) => r.url().includes("/order/condition"), { timeout: 20000 })
    .catch(() => null);
  await page.waitForTimeout(2500);

  const result = await fetchAllOrders(page, args);
  await ctx.close();

  if (result.error) {
    console.log(`\n[실패] status=${result.status} : ${result.text}`);
    console.log("→ 세션이 만료됐을 수 있습니다. 창을 띄운 채(--headless 없이) 다시 로그인하세요.");
    process.exit(1);
  }

  const summary = result.summary || {};
  const orders = result.orders || [];
  const stamp = `${fmtDate(startD)}_${fmtDate(endD)}`;

  // 1) 원본 JSON 덤프
  const rawPath = path.join(OUT_DIR, `coupangeats_raw_${stamp}.json`);
  fs.writeFileSync(rawPath, JSON.stringify({ summary, orders }, null, 2), "utf-8");

  // 2) CSV 저장 (엑셀 한글 깨짐 방지: UTF-8 BOM)
  const csvPath = path.join(OUT_DIR, `coupangeats_sales_${stamp}.csv`);
  fs.writeFileSync(csvPath, "﻿" + toCsv(orders.map(flattenOrder)), "utf-8");

  const won = (n) => (n == null ? 0 : n).toLocaleString("ko-KR");
  console.log(
    `\n[요약] 매출 ${won(summary.totalSalePrice)}원 / ` +
    `주문 ${summary.totalOrderCount}건 / ` +
    `평균 ${won(Math.round(summary.avgOrderAmount || 0))}원`
  );
  console.log(`[주문 수집] ${orders.length}건`);
  console.log(`[JSON] ${rawPath}`);
  console.log(`[CSV ] ${csvPath}`);

  // 3) Supabase 자동 적재 (.env 설정 시)
  await pushToSupabase(orders);
})().catch((e) => {
  console.error("오류:", e);
  process.exit(1);
});

// ─────────────────────────────────────────────────────────────
// Supabase 적재: 주문/품목을 스키마에 맞게 변환 후 UPSERT
// ─────────────────────────────────────────────────────────────
async function pushToSupabase(orders) {
  const platform = "coupang_eats";
  const extId = (o) => o.uniqueOrderId || String(o.orderId);
  const orderRows = orders.map((o) => {
    const settle = o.orderSettlement || {};
    return {
      platform,
      external_order_id: extId(o),
      order_number: o.abbrOrderId || null,
      order_datetime: o.createdAt ? new Date(o.createdAt).toISOString() : null,
      status: o.status || "UNKNOWN",
      total_amount: o.totalAmount ?? null,
      settlement_amount: o.actuallyAmount ?? null,
      discount_amount: o.discountPrice ?? 0,
      commission_amount: settle.commissionTotal ?? 0,
      raw: o,
    };
  });
  const itemsByExtId = orders.map((o) => ({
    ext: `${platform}|${extId(o)}`,
    items: (o.items || []).map((it) => ({
      raw_name: it.name || "",
      quantity: it.quantity ?? 0,
      unit_price: it.unitSalePrice ?? null,
      subtotal: it.subTotalPrice ?? null,
      is_canceled: false,
      options: it.itemOptions ?? null,
    })),
  }));
  await syncToSupabase(orderRows, itemsByExtId);
}
