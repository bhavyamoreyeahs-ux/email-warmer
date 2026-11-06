/**
 * CSV generation with spreadsheet formula-injection protection (CWE-1236).
 *
 * Any cell beginning with = + - @ or a tab/carriage return is prefixed with a
 * single quote so spreadsheet apps treat it as text. Every cell is quoted and
 * embedded quotes doubled. Rows end with CRLF (RFC 4180).
 */
export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '""';
  let s = value instanceof Date ? value.toISOString() : Array.isArray(value) ? value.join("; ") : typeof value === "object" ? JSON.stringify(value) : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCsv<T extends Record<string, unknown>>(rows: T[], columns: Array<{ key: keyof T & string; header: string }>): string {
  const head = columns.map((c) => escapeCsvCell(c.header)).join(",");
  const body = rows.map((r) => columns.map((c) => escapeCsvCell(r[c.key])).join(","));
  return [head, ...body].join("\r\n") + "\r\n";
}

export function csvResponse(csv: string, filename: string): Response {
  return new Response(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
