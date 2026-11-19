import { PDFDocument, PDFName, PDFString, StandardFonts } from "pdf-lib";
/** テスト用の小さな PDF (文字が違えば中身も違う) */
export async function makePdf(text, pages = 1) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) doc.addPage([300, 200]).drawText(`${text} p${i + 1}`, { x: 20, y: 100, size: 12, font });
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}
/** 開くと JavaScript が動く PDF (登録を断ることの確認用) */
export async function makeJsPdf() {
  const doc = await PDFDocument.create(); doc.addPage([100, 100]);
  const js = doc.context.obj({ Type: "Action", S: "JavaScript", JS: PDFString.of("app.alert(1)") });
  doc.catalog.set(PDFName.of("OpenAction"), doc.context.register(js));
  return Buffer.from(await doc.save({ useObjectStreams: true }));
}
