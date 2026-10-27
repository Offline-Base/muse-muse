// Test (d): a PDF muse. Writes a one-page text PDF (a pottery studio's class schedule) and asks for a product from it.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeBrief } from "@/lib/brief/write";
import { assertBrief, excerpt, MEDIA_DIR, printUsage, ref, saveJson, timed } from "./brief-common";

/** A minimal one-page PDF with Helvetica text lines. */
function textPdf(lines: Array<{ text: string; size: number }>): Buffer {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  let y = 760;
  const ops = lines
    .map(({ text, size }) => {
      const op = `BT /F1 ${size} Tf 56 ${y} Td (${esc(text)}) Tj ET`;
      y -= size + 8;
      return op;
    })
    .join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(ops)} >>\nstream\n${ops}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(body));
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

const pdf = textPdf([
  { text: "Riverbend Clay Studio", size: 22 },
  { text: "Fall class schedule, September to December", size: 13 },
  { text: "", size: 6 },
  { text: "Class                     Day and time            Weeks   Price   Open spots", size: 11 },
  { text: "Wheel throwing basics     Tue 6:00 to 8:00 pm     8       $240    3 of 10", size: 11 },
  { text: "Hand building for adults  Wed 10:00 am to noon    6       $180    0 of 8 (waitlist)", size: 11 },
  { text: "Glazing workshop          Sat 1:00 to 4:00 pm     1       $65     6 of 12", size: 11 },
  { text: "Kids clay club (ages 8+)  Sat 10:00 to 11:30 am   6       $120    2 of 10", size: 11 },
  { text: "Open studio membership    Any day, 9 am to 9 pm   month   $95     unlimited", size: 11 },
  { text: "", size: 6 },
  { text: "All clay and two firings are included. Bring an apron.", size: 11 },
  { text: "Refunds up to 7 days before the first class. Call 555-0142 to book.", size: 11 },
]);
const path = join(MEDIA_DIR, "schedule.pdf");
writeFileSync(path, pdf);
console.log(`wrote ${path} (${pdf.length} bytes)`);

const references = [ref("pdf", "fall-schedule.pdf", "application/pdf", pdf)];
const result = await timed("writeBrief pdf", () =>
  writeBrief({ note: "Make this into something people can browse on their phone and pick a class that fits their week", references }),
);
assertBrief(result.brief);
excerpt(result.brief);
printUsage(result.usage, result.costUsd);
saveJson("brief-pdf", result.brief);
const d = result.brief.inspiration.references[0]?.describes ?? "";
console.log("CHECK pdf read (mentions a class from the PDF):", /wheel|glaz|hand building|kids/i.test(d) ? "ok" : "FAIL");
console.log("full describes:", d);
