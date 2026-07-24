/**
 * Supabase 자동 적재 모듈
 *   우선순위 1) DATABASE_URL 이 있으면 Postgres 직접 연결(pg)로 트랜잭션 UPSERT
 *   우선순위 2) SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY 면 REST API 로 UPSERT
 *   둘 다 없으면 건너뜀 (CSV 만 저장)
 *
 *  - tb_sales_order 를 (platform, external_order_id) 기준으로 UPSERT
 *  - tb_sales_order_item 은 해당 주문의 기존 품목을 지우고 다시 넣어 중복 방지
 */
const fs = require("fs");
const path = require("path");

// .env 파일을 process.env 로 로드 (dotenv 없이 간단 파서)
function loadEnv(dir) {
  const p = path.join(dir, ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf-8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

/**
 * @param {Array} orderRows      tb_sales_order 에 넣을 행들
 * @param {Array} itemsByExtId   [{ ext: "platform|external_order_id", items: [...] }]
 */
async function syncToSupabase(orderRows, itemsByExtId) {
  if (!orderRows.length) { console.log("[DB] 적재할 주문 없음"); return; }
  if (process.env.DATABASE_URL) return syncViaPg(orderRows, itemsByExtId);
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) return syncViaRest(orderRows, itemsByExtId);
  console.log("[DB] 환경변수(.env) 없음 → 적재 건너뜀 (CSV만 저장)");
}

// ── 방식 1: Postgres 직접 연결 (DATABASE_URL) ──
async function syncViaPg(orderRows, itemsByExtId) {
  let Client;
  try { ({ Client } = require("pg")); }
  catch (e) { console.log("[DB] pg 모듈이 없습니다. `npm install pg` 후 다시 실행하세요."); return; }

  const itemsMap = {};
  for (const { ext, items } of itemsByExtId) itemsMap[ext] = items;

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, // Supabase 는 SSL 필요
  });

  try {
    await client.connect();
    await client.query("begin");
    let n = 0;
    for (const r of orderRows) {
      const res = await client.query(
        `insert into tb_sales_order
           (platform, external_order_id, order_number, order_datetime, status,
            total_amount, settlement_amount, discount_amount, commission_amount, raw)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
         on conflict (platform, external_order_id) do update set
           order_number      = excluded.order_number,
           order_datetime    = excluded.order_datetime,
           status            = excluded.status,
           total_amount      = excluded.total_amount,
           settlement_amount = excluded.settlement_amount,
           discount_amount   = excluded.discount_amount,
           commission_amount = excluded.commission_amount,
           raw               = excluded.raw
         returning id`,
        [r.platform, r.external_order_id, r.order_number, r.order_datetime, r.status,
         r.total_amount, r.settlement_amount, r.discount_amount, r.commission_amount, JSON.stringify(r.raw)]
      );
      const oid = res.rows[0].id;
      await client.query("delete from tb_sales_order_item where order_id=$1", [oid]);
      const items = itemsMap[`${r.platform}|${r.external_order_id}`] || [];
      for (const it of items) {
        await client.query(
          `insert into tb_sales_order_item
             (order_id, raw_name, quantity, unit_price, subtotal, is_canceled, options)
           values ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
          [oid, it.raw_name, it.quantity, it.unit_price, it.subtotal, it.is_canceled,
           it.options == null ? null : JSON.stringify(it.options)]
        );
      }
      n++;
    }
    await client.query("commit");
    console.log(`[DB] 주문 ${n}건 적재 완료 (DATABASE_URL)`);
  } catch (e) {
    try { await client.query("rollback"); } catch (_) {}
    console.log(`[DB] 적재 실패: ${e.message}`);
  } finally {
    await client.end().catch(() => {});
  }
}

// ── 방식 2: Supabase REST API (SUPABASE_URL + SERVICE_ROLE_KEY) ──
async function syncViaRest(orderRows, itemsByExtId) {
  const base = process.env.SUPABASE_URL.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  let saved;
  try {
    const res = await fetch(`${base}/rest/v1/tb_sales_order?on_conflict=platform,external_order_id`, {
      method: "POST",
      headers: { ...headers, Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(orderRows),
    });
    if (!res.ok) { console.log(`[DB] 주문 적재 실패 status=${res.status}: ${(await res.text()).slice(0, 400)}`); return; }
    saved = await res.json();
  } catch (e) { console.log(`[DB] 연결 오류: ${e.message}`); return; }

  const idByExt = {};
  for (const r of saved) idByExt[`${r.platform}|${r.external_order_id}`] = r.id;
  const ids = saved.map((r) => r.id);
  if (ids.length) {
    try {
      await fetch(`${base}/rest/v1/tb_sales_order_item?order_id=in.(${ids.join(",")})`, { method: "DELETE", headers });
    } catch (e) { /* 무시 */ }
    const itemRows = [];
    for (const { ext, items } of itemsByExtId) {
      const oid = idByExt[ext];
      if (!oid) continue;
      for (const it of items) itemRows.push({ ...it, order_id: oid });
    }
    if (itemRows.length) {
      try {
        const ires = await fetch(`${base}/rest/v1/tb_sales_order_item`, { method: "POST", headers, body: JSON.stringify(itemRows) });
        if (!ires.ok) console.log(`[DB] 품목 적재 실패 status=${ires.status}: ${(await ires.text()).slice(0, 400)}`);
      } catch (e) { console.log(`[DB] 품목 연결 오류: ${e.message}`); }
    }
  }
  console.log(`[DB] 주문 ${saved.length}건 적재 완료 (REST)`);
}

module.exports = { loadEnv, syncToSupabase };
