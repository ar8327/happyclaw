import type { SessionRecord } from './types.js';

export interface SessionPaginationOptions {
  page: number;
  pageSize: number;
  query?: string;
}

export interface SessionPage {
  sessions: SessionRecord[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  query: string;
}

function getSessionSortTimestamp(
  session: SessionRecord,
  activityBySessionId: ReadonlyMap<string, string>,
): string {
  return (
    activityBySessionId.get(session.id) ||
    session.updated_at ||
    session.created_at
  );
}

/**
 * Paginate a caller-authorized collection of top-level sessions.
 *
 * Authorization deliberately stays outside this pure helper: routes must
 * filter with the canonical access policy before passing records here.
 */
export function paginateTopLevelSessions(
  authorizedSessions: SessionRecord[],
  activityBySessionId: ReadonlyMap<string, string>,
  options: SessionPaginationOptions,
): SessionPage {
  const query = (options.query || '').trim().slice(0, 200);
  const normalizedQuery = query.toLocaleLowerCase();
  const pageSize = Math.max(1, Math.min(100, Math.floor(options.pageSize)));
  const requestedPage = Math.max(1, Math.floor(options.page));

  const sessions = authorizedSessions
    .filter(
      (session) =>
        !session.archived &&
        (session.kind === 'main' || session.kind === 'workspace'),
    )
    .filter((session) => {
      if (!normalizedQuery) return true;
      return [session.name, session.id, session.cwd].some((value) =>
        value.toLocaleLowerCase().includes(normalizedQuery),
      );
    })
    .sort((left, right) => {
      const leftMain = left.kind === 'main' ? 0 : 1;
      const rightMain = right.kind === 'main' ? 0 : 1;
      if (leftMain !== rightMain) return leftMain - rightMain;
      if (left.is_pinned !== right.is_pinned) {
        return left.is_pinned ? -1 : 1;
      }
      const timestampOrder = getSessionSortTimestamp(
        right,
        activityBySessionId,
      ).localeCompare(getSessionSortTimestamp(left, activityBySessionId));
      if (timestampOrder !== 0) return timestampOrder;
      return left.id.localeCompare(right.id);
    });

  const total = sessions.length;
  const totalPages = Math.ceil(total / pageSize);
  const page = totalPages === 0 ? 1 : Math.min(requestedPage, totalPages);
  const offset = (page - 1) * pageSize;

  return {
    sessions: sessions.slice(offset, offset + pageSize),
    page,
    pageSize,
    total,
    totalPages,
    query,
  };
}
