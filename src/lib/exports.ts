import type { Citation, EvidenceDocument, FactRecord } from "@/lib/types";
import { readCanonicalByteRange, readCitationContext } from "@/lib/evidence";

function download(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function buildApprovedExportRows(
  facts: FactRecord[],
  citations: Citation[],
  documents: EvidenceDocument[]
) {
  const citationMap = new Map(citations.map((citation) => [citation.id, citation]));
  const documentMap = new Map(documents.map((document) => [document.id, document]));
  return facts
    .filter((fact) => fact.status === "approved")
    .flatMap((fact) => {
      const citation = citationMap.get(fact.citationIds[0]);
      const source = citation ? documentMap.get(citation.documentId) : undefined;
      if (
        !citation ||
        !source ||
        citation.canonicalArtifactSha256 !== source.canonicalSha256 ||
        citation.originalFileSha256 !== source.originalSha256
      ) {
        return [];
      }
      try {
        if (
          readCanonicalByteRange(
            source.canonicalText,
            citation.canonicalByteStart,
            citation.canonicalByteEnd
          ) !== citation.exactQuote
        ) {
          return [];
        }
      } catch {
        return [];
      }
      const context = readCitationContext(
        source.canonicalText,
        citation.canonicalByteStart,
        citation.canonicalByteEnd,
        240
      );
      const page = source.pages.find(
        (item) => item.pageNumber === citation.pageNumber
      );
      return [{
        factId: fact.id,
        statement: fact.statement,
        type: fact.type,
        eventDate: fact.eventDate,
        confidence: fact.confidence,
        reviewer: fact.reviewer,
        reviewedAt: fact.reviewedAt,
        verification: "Exact canonical UTF-8 byte match",
        source: source?.name ?? "",
        page: citation?.pageNumber ?? "",
        pageCount: source.pageCount,
        structuralPath: citation.structuralPath ?? "",
        extractionMethod: page?.extractionMethod ?? "",
        exactQuote: citation?.exactQuote ?? "",
        contextBefore: context.before,
        contextAfter: context.after,
        byteStart: citation?.canonicalByteStart ?? "",
        byteEnd: citation?.canonicalByteEnd ?? "",
        originalSha256: citation.originalFileSha256,
        canonicalSha256: citation?.canonicalArtifactSha256 ?? "",
        parserVersion: citation.parserVersion
      }];
    });
}

export function spreadsheetSafeText(input: unknown): string {
  const raw = String(input ?? "");
  return /^[\t\r ]*[=+\-@]/.test(raw) || /^[\t\r]/.test(raw) ? `'${raw}` : raw;
}

export function exportJson(
  facts: FactRecord[],
  citations: Citation[],
  documents: EvidenceDocument[]
): void {
  download(
    "approved-case-facts.json",
    new Blob([JSON.stringify(buildApprovedExportRows(facts, citations, documents), null, 2)], {
      type: "application/json"
    })
  );
}

export function exportCsv(
  facts: FactRecord[],
  citations: Citation[],
  documents: EvidenceDocument[]
): void {
  const rows = buildApprovedExportRows(facts, citations, documents);
  const headers = Object.keys(rows[0] ?? { statement: "" });
  const value = (input: unknown) => {
    const inert = spreadsheetSafeText(input);
    return `"${inert.replaceAll('"', '""')}"`;
  };
  const csv = [
    headers.map(value).join(","),
    ...rows.map((row) =>
      headers.map((header) => value(row[header as keyof typeof row])).join(",")
    )
  ].join("\n");
  download("approved-case-facts.csv", new Blob([csv], { type: "text/csv" }));
}

export async function exportXlsx(
  facts: FactRecord[],
  citations: Citation[],
  documents: EvidenceDocument[]
): Promise<void> {
  const { default: JSZip } = await import("jszip");
  const rows = buildApprovedExportRows(facts, citations, documents);
  const keys = Object.keys(rows[0] ?? { statement: "" });
  const xmlEscape = (value: unknown) =>
    String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&apos;");
  const columnName = (index: number) => {
    let value = index + 1;
    let name = "";
    while (value > 0) {
      const remainder = (value - 1) % 26;
      name = String.fromCharCode(65 + remainder) + name;
      value = Math.floor((value - 1) / 26);
    }
    return name;
  };
  const matrix = [
    keys,
    ...rows.map((row) => keys.map((key) => row[key as keyof typeof row]))
  ];
  const sheetRows = matrix
    .map(
      (row, rowIndex) =>
        `<row r="${rowIndex + 1}">${row
          .map(
            (value, columnIndex) =>
              `<c r="${columnName(columnIndex)}${rowIndex + 1}" t="inlineStr"${
                rowIndex === 0 ? ' s="1"' : ""
              }><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`
          )
          .join("")}</row>`
    )
    .join("");
  const sheetColumns = keys
    .map((key, index) => {
      const wide = ["statement", "exactQuote", "contextBefore", "contextAfter"].includes(key);
      const medium = ["source", "structuralPath", "reviewer", "reviewedAt"].includes(key);
      return `<col min="${index + 1}" max="${index + 1}" width="${
        wide ? 52 : medium ? 26 : 16
      }" customWidth="1"/>`;
    })
    .join("");
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`
  );
  zip.folder("_rels")?.file(
    ".rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
  );
  zip.folder("xl")?.file(
    "workbook.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Approved facts" sheetId="1" r:id="rId1"/></sheets></workbook>`
  );
  zip.folder("xl")?.folder("_rels")?.file(
    "workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
  );
  zip.folder("xl")?.file(
    "styles.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="11"/><name val="Arial"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`
  );
  zip.folder("xl")?.folder("worksheets")?.file(
    "sheet1.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${sheetColumns}</cols><sheetData>${sheetRows}</sheetData><autoFilter ref="A1:${columnName(Math.max(0, keys.length - 1))}${matrix.length}"/></worksheet>`
  );
  const blob = await zip.generateAsync({
    type: "blob",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  });
  download("approved-case-facts.xlsx", blob);
}

export async function exportDocx(
  facts: FactRecord[],
  citations: Citation[],
  documents: EvidenceDocument[]
): Promise<void> {
  const { Document, HeadingLevel, Packer, Paragraph, TextRun } = await import("docx");
  const rows = buildApprovedExportRows(facts, citations, documents);
  const children = [
    new Paragraph({ text: "Approved Case Facts", heading: HeadingLevel.TITLE }),
    ...rows.flatMap((row, index) => [
      new Paragraph({
        children: [new TextRun({ text: `${index + 1}. ${row.statement}`, bold: true })]
      }),
      new Paragraph({ text: `“${row.exactQuote}”` }),
      new Paragraph({
        text: `${row.source}${row.page ? `, page ${row.page} of ${row.pageCount}` : ""} · ${row.structuralPath || "structural span"} · UTF-8 bytes ${row.byteStart}–${row.byteEnd}`
      }),
      new Paragraph({
        text: `${row.type}${row.eventDate ? ` · Event date ${row.eventDate}` : ""} · ${row.verification} · ${row.reviewer ?? "Automatic verification"}`
      })
    ])
  ];
  const blob = await Packer.toBlob(
    new Document({ sections: [{ properties: {}, children }] })
  );
  download("approved-case-facts.docx", blob);
}
