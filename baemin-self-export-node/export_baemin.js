/**
 * 배민셀프서비스 - 주문내역 자동 추출 (JSON -> CSV) : Node.js
 *
 * 동작 방식 (쿠팡 버전과 동일 철학):
 *   1) Playwright가 '전용 크롬 프로필'로 브라우저를 띄운다.
 *   2) 첫 실행 때는 사람이 직접 로그인 -> 세션이 프로필에 저장됨.
 *   3) 주문내역 페이지를 열면 앱이 스스로 첫 요청을 보내는데,
 *      그때 붙는 서명 헤더(x-e-request)를 가로채 확보한다.
 *   4) 그 서명으로 원하는 기간·모든 페이지를 직접 조회해 전부 받아온다.
 *   5) 원본 JSON 덤프 + CSV(주문일시/주문번호/메뉴/주문금액) 저장.
 *
 * 준비:  npm install  &&  npx playwright install chromium
 * 실행:
 *   node export_baemin.js                 # 어제 하루치
 *   node export_baemin.js --days 7        # 최근 7일
 *   node export_baemin.js --today
 *   node export_baemin.js --start 2026-07-01 --end 2026-07-24
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { chromium } = require("playwright");
const { loadEnv, syncToSupabase } = require("./supabase");

// ─────────────────────────────────────────────────────────────
// 설정
// ─────────────────────────────────────────────────────────────
const SHOP_OWNER_NUMBER = "201907045916"; // 사장님 번호 (앱 요청에서 자동 감지 시 덮어씀)
const ORDER_STATUS = "CLOSED"; // 배달완료
const HISTORY_URL = "https://self.baemin.com/orders/history";
const API_URL = "https://self-api.baemin.com/v4/orders";
const PAGE_LIMIT = 10; // 배민 기본 페이지 크기
const PAGE_DELAY_MS = 800; // 페이지 사이 간격 (넉넉히)

const SCRIPT_DIR = __dirname;
const PROFILE_DIR = path.join(SCRIPT_DIR, "baemin_profile");
const OUT_DIR = path.join(SCRIPT_DIR, "output");

// ─────────────────────────────────────────────────────────────
// 인자 파싱 / 날짜
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
function fmtDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function parseRange(args) {
  let s, e;
  if (args.today) { s = new Date(); e = new Date(); }
  else if (args.start && args.end) { s = new Date(args.start); e = new Date(args.end); }
  else if (args.days) { e = new Date(); s = new Date(); s.setDate(e.getDate() - (args.days - 1)); }
  else { e = new Date(); e.setDate(e.getDate() - 1); s = new Date(e); } // 기본: 어제
  return [fmtDate(s), fmtDate(e)];
}

// ─────────────────────────────────────────────────────────────
// 한 페이지(offset) 조회 — 가로챈 서명 헤더로 직접 호출
// ─────────────────────────────────────────────────────────────
async function fetchPage(page, headers, q, offset) {
  return await page.evaluate(
    async ({ api, headers, offset, limit, startDate, endDate, shopOwner, status }) => {
      const url = `${api}?offset=${offset}&limit=${limit}&startDate=${startDate}&endDate=${endDate}` +
        `&shopOwnerNumber=${shopOwner}&shopNumbers=&orderStatus=${status}`;
      let st = 0, data = null;
      try {
        const res = await fetch(url, { method: "GET", credentials: "include", headers });
        st = res.status;
        data = await res.json();
      } catch (e) { st = -1; }
      return { status: st, data };
    },
    { api: API_URL, headers, offset, limit: PAGE_LIMIT, startDate: q.startDate, endDate: q.endDate, shopOwner: q.shopOwner, status: ORDER_STATUS }
  );
}

// ─────────────────────────────────────────────────────────────
// CSV 변환
// ─────────────────────────────────────────────────────────────
const CSV_COLUMNS = ["주문일시", "주문번호", "메뉴", "주문금액"];

function isoToMin(iso) {
  if (!iso) return "";
  // "2026-07-21T17:26:46" -> "2026-07-21 17:26"
  return String(iso).replace("T", " ").slice(0, 16);
}
function flattenOrder(c) {
  const o = c.order || c;
  const items = o.items || [];
  const menu = items.map((it) => `${it.name || ""} x${it.quantity || 0}`).join(", ")
    || o.itemsSummary || "";
  return {
    주문일시: isoToMin(o.orderDateTime),
    주문번호: o.orderNumber || "",
    메뉴: menu,
    주문금액: o.payAmount != null ? o.payAmount : "",
  };
}
function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(rows) {
  const lines = [CSV_COLUMNS.join(",")];
  for (const r of rows) lines.push(CSV_COLUMNS.map((c) => csvCell(r[c])).join(","));
  return lines.join("\r\n");
}

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a); }));
}

// ─────────────────────────────────────────────────────────────
// 메인
// ─────────────────────────────────────────────────────────────
(async () => {
  loadEnv(__dirname); // .env 로드 (Supabase 설정)
  const args = parseArgs(process.argv);
  const [startDate, endDate] = parseRange(args);
  console.log(`[조회 기간] ${startDate} ~ ${endDate}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: args.headless,
    viewport: { width: 1280, height: 900 },
    locale: "ko-KR",
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());

  // 앱이 보내는 /v4/orders 요청에서 서명 헤더와 사장님번호를 가로챈다
  let captured = null;
  let shopOwner = SHOP_OWNER_NUMBER;
  page.on("request", (req) => {
    const u = req.url();
    if (u.includes("/v4/orders?") && !captured) {
      const h = req.headers();
      if (h["x-e-request"]) {
        captured = {
          "x-e-request": h["x-e-request"],
          "service-channel": h["service-channel"] || "SELF_SERVICE_PC",
          "x-web-version": h["x-web-version"] || "",
          "x-pathname-trace-key": h["x-pathname-trace-key"] || "/orders/history",
          accept: "application/json, text/plain, */*",
        };
        const m = u.match(/shopOwnerNumber=(\d+)/);
        if (m) shopOwner = m[1];
      }
    }
  });

  await page.goto(HISTORY_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  // 로그인 필요 시 사람이 직접 로그인
  if (page.url().includes("login") || page.url().includes("self-auth") || page.url().includes("account")) {
    console.log("\n[로그인 필요] 브라우저 창에서 직접 로그인해 주세요.");
    await ask("로그인 완료 후 주문내역이 보이면 여기서 Enter를 누르세요... ");
    await page.goto(HISTORY_URL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
  }

  // 서명 헤더 확보 대기 (앱의 첫 요청)
  console.log("브라우저 준비 중... (요청 서명 확보)");
  for (let i = 0; i < 30 && !captured; i++) await page.waitForTimeout(500);
  if (!captured) {
    console.log("[실패] 요청 서명을 확보하지 못했습니다. 창을 띄운 채 다시 실행해 주세요.");
    await ctx.close();
    process.exit(1);
  }

  // 전체 페이지 수집
  const q = { startDate, endDate, shopOwner };
  const first = await fetchPage(page, captured, q, 0);
  if (!(first.data && Array.isArray(first.data.contents))) {
    console.log(`[실패] status=${first.status} 응답이 올바르지 않습니다.`);
    await ctx.close();
    process.exit(1);
  }
  const totalSize = first.data.totalSize || 0;
  const totalPay = first.data.totalPayAmount || 0;
  const totalPages = Math.max(1, Math.ceil(totalSize / PAGE_LIMIT));
  let all = first.data.contents.slice();
  console.log(`총 ${totalSize}건 (${totalPages}페이지). 수집 중...`);
  console.log(`  [1/${totalPages}] ${all.length}건`);

  for (let p = 1; p < totalPages && all.length < totalSize; p++) {
    await page.waitForTimeout(PAGE_DELAY_MS);
    const r = await fetchPage(page, captured, q, p * PAGE_LIMIT);
    if (!(r.data && Array.isArray(r.data.contents)) || r.data.contents.length === 0) break;
    all = all.concat(r.data.contents);
    console.log(`  [${p + 1}/${totalPages}] 누적 ${all.length}건`);
  }

  await ctx.close();

  const stamp = `${startDate}_${endDate}`;
  const rawPath = path.join(OUT_DIR, `baemin_raw_${stamp}.json`);
  fs.writeFileSync(rawPath, JSON.stringify({ totalSize, totalPayAmount: totalPay, contents: all }, null, 2), "utf-8");

  const csvPath = path.join(OUT_DIR, `baemin_orders_${stamp}.csv`);
  fs.writeFileSync(csvPath, "﻿" + toCsv(all.map(flattenOrder)), "utf-8");

  const won = (n) => (n == null ? 0 : n).toLocaleString("ko-KR");
  console.log(`\n[요약] 결제금액 ${won(totalPay)}원 / 주문 ${totalSize}건`);
  console.log(`[주문 수집] ${all.length}건`);
  console.log(`[JSON] ${rawPath}`);
  console.log(`[CSV ] ${csvPath}`);

  // Supabase 자동 적재 (.env 설정 시)
  await pushToSupabase(all);
})().catch((e) => { console.error("오류:", e); process.exit(1); });

// ─────────────────────────────────────────────────────────────
// Supabase 적재: 주문/품목을 스키마에 맞게 변환 후 UPSERT
// ─────────────────────────────────────────────────────────────
async function pushToSupabase(contents) {
  const platform = "baemin";
  const orderRows = contents.map((c) => {
    const o = c.order || c;
    return {
      platform,
      external_order_id: o.orderNumber,
      order_number: o.orderNumber || null,
      // orderDateTime 은 KST 로컬시각(타임존 없음) → +09:00 붙여 정확히 저장
      order_datetime: o.orderDateTime ? new Date(o.orderDateTime + "+09:00").toISOString() : null,
      status: o.status || "UNKNOWN",
      total_amount: o.payAmount ?? null,
      settlement_amount: null, // 배민 이 API 응답엔 정산액 없음
      discount_amount: 0,
      commission_amount: 0, // 배민 이 API 응답엔 수수료 없음
      raw: o,
    };
  });
  const itemsByExtId = contents.map((c) => {
    const o = c.order || c;
    return {
      ext: `${platform}|${o.orderNumber}`,
      items: (o.items || []).map((it) => ({
        raw_name: it.name || "",
        quantity: it.quantity ?? 0,
        unit_price: it.totalPrice != null && it.quantity ? Math.round(it.totalPrice / it.quantity) : null,
        subtotal: it.totalPrice ?? null,
        is_canceled: false,
        options: it.options ?? null,
      })),
    };
  });
  await syncToSupabase(orderRows, itemsByExtId);
}
