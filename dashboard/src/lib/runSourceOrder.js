// Row ordering for a pipeline run's per-source breakdown (PipelineRunDetailPage).
// The endpoint ranks rows by `scraped desc`, which is fine for a finished run
// but two things go wrong once the table is paginated:
//   - a failed source scrapes 0 articles, so every row needing attention sorts
//     onto the last page, out of sight of the "N sources need attention;
//     review below" message;
//   - `scraped` keeps climbing while a run is live, so every poll re-ranks the
//     list and rows hop between pages under the reader.

// Mirrors sourceStatusBadge: anything that would not get the green "OK" badge.
export function sourceNeedsAttention(row) {
  return Boolean(row?.issue || row?.network_blocked || row?.http_status || row?.fetch_note);
}

// Keeps rows already on screen in their previous position and appends rows
// seen for the first time, in server order. Used for each poll of a live run.
export function keepRowOrder(previous, next) {
  const position = new Map();
  previous.forEach((row, index) => position.set(row.source, index));
  const known = [];
  const added = [];
  next.forEach((row) => {
    if (position.has(row.source)) known.push(row);
    else added.push(row);
  });
  known.sort((a, b) => position.get(a.source) - position.get(b.source));
  return [...known, ...added];
}

// Rows needing attention first; otherwise the incoming order is preserved
// (Array.prototype.sort is stable).
export function attentionFirst(rows) {
  return [...rows].sort((a, b) => Number(sourceNeedsAttention(b)) - Number(sourceNeedsAttention(a)));
}
