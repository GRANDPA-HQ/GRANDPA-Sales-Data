const path = require("path");
const { chromium } = require("playwright");

(async () => {
  const src = "file://" + path.join(__dirname, "_guide_src.html").replace(/\\/g, "/");
  const out = path.join(__dirname, "사용법_가이드.pdf");
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(src, { waitUntil: "networkidle" });
  await page.pdf({
    path: out,
    format: "A4",
    printBackground: true,
    margin: { top: "0", bottom: "0", left: "0", right: "0" },
  });
  await browser.close();
  console.log("PDF 생성 완료:", out);
})().catch((e) => { console.error(e); process.exit(1); });
