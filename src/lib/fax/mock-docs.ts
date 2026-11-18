import "server-only";
import { LEFT, MARGIN, Sheet } from "@/lib/pdf/layout";

/** 模擬の受信に使う広告の PDF (検証環境だけ。実在の会社名は使わない) */
export async function mockAdPdf(): Promise<Uint8Array> {
  const s = await Sheet.create({ title: "ご案内", subject: "広告 (模擬)", author: "模擬の送信元" });
  s.addPage();
  const lines = [
    ["【法人様限定】光回線 乗り換えキャンペーン", 18],
    ["今だけ 月額料金が 6 か月間 半額！", 14],
    ["工事費 無料・違約金 全額負担", 12],
    ["お問い合わせはフリーダイヤル 0120-000-000 (受付 平日 9:00〜18:00)", 10],
    ["※ 今後のご案内が不要な場合は、この用紙に「不要」とご記入のうえ FAX でご返信ください。", 9],
    ["(これは検証用の模擬の FAX です)", 9],
  ] as const;
  let y = MARGIN + 60;
  for (const [text, size] of lines) {
    s.text(text, LEFT, y, { size, weight: size >= 14 ? "bold" : "regular" });
    y += size * 2.2;
  }
  return s.finish();
}
