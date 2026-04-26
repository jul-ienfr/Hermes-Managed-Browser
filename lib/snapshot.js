/**
 * Snapshot windowing — truncate large accessibility snapshots while
 * preserving pagination/navigation links at the tail.
 */

const MAX_SNAPSHOT_CHARS = 80000;  // ~20K tokens
const SNAPSHOT_TAIL_CHARS = 5000;  // keep last ~5K for pagination/nav links
const COOKIE_KEYWORDS = [
  'cookie', 'cookies', 'consent', 'consentement', 'rgpd', 'privacy', 'confidentialité'
];

function filterSnapshotDialogArtifacts(yaml, options = {}) {
  if (!yaml || typeof yaml !== 'string') return yaml || '';

  const confirmedDialogNames = new Set(
    (options.confirmedDialogNames || [])
      .map((name) => String(name || '').trim().toLowerCase())
      .filter(Boolean)
  );
  const cookieBannerKeywords = (options.cookieBannerKeywords || [])
    .map((value) => String(value || '').toLowerCase());
  const cookieSignals = [...COOKIE_KEYWORDS, ...cookieBannerKeywords];
  const lowerYaml = yaml.toLowerCase();
  const hasCookieSignal = cookieSignals.some((keyword) => keyword && lowerYaml.includes(keyword));
  if (!hasCookieSignal) return yaml;

  const lines = yaml.split('\n');
  const kept = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = line.match(/^(\s*)-\s+dialog\s+"([^"]+)"(.*)$/);
    if (!match) {
      kept.push(line);
      continue;
    }

    const [, indent, rawName] = match;
    const name = rawName.trim().toLowerCase();
    if (confirmedDialogNames.has(name)) {
      kept.push(line);
      continue;
    }

    const indentLen = indent.length;
    let j = i + 1;
    while (j < lines.length) {
      const child = lines[j];
      if (!child.trim()) {
        j += 1;
        continue;
      }
      const childIndent = child.match(/^(\s*)/)?.[1]?.length || 0;
      if (childIndent <= indentLen) break;
      j += 1;
    }
    i = j - 1;
  }

  return kept.join('\n');
}

/**
 * Return a window of the snapshot YAML.
 *  offset=0 (default): head chunk + tail (pagination/nav).
 *  offset=N: chars N..N+budget from the full snapshot.
 *  Always appends pagination tail so nav refs are available in every chunk.
 */
function windowSnapshot(yaml, offset = 0) {
  yaml = filterSnapshotDialogArtifacts(yaml);
  if (!yaml) return { text: '', truncated: false, totalChars: 0, offset: 0 };
  const total = yaml.length;
  if (total <= MAX_SNAPSHOT_CHARS) return { text: yaml, truncated: false, totalChars: total, offset: 0 };

  const contentBudget = MAX_SNAPSHOT_CHARS - SNAPSHOT_TAIL_CHARS - 200; // room for marker
  const tail = yaml.slice(-SNAPSHOT_TAIL_CHARS);
  const clampedOffset = Math.min(Math.max(0, offset), total - SNAPSHOT_TAIL_CHARS);
  const chunk = yaml.slice(clampedOffset, clampedOffset + contentBudget);
  const chunkEnd = clampedOffset + contentBudget;
  const hasMore = chunkEnd < total - SNAPSHOT_TAIL_CHARS;

  const marker = hasMore
    ? `\n[... truncated at char ${chunkEnd} of ${total}. Call snapshot with offset=${chunkEnd} to see more. Pagination links below. ...]\n`
    : '\n';

  return {
    text: chunk + marker + tail,
    truncated: true,
    totalChars: total,
    offset: clampedOffset,
    hasMore,
    nextOffset: hasMore ? chunkEnd : null
  };
}

export { windowSnapshot, filterSnapshotDialogArtifacts, MAX_SNAPSHOT_CHARS, SNAPSHOT_TAIL_CHARS };
