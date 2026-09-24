import type { GradebookColumnGroup } from "@/utils/supabase/DatabaseTypes";

/**
 * Shaping gradebook columns into their stored groups.
 *
 * This replaces the `groupedColumns` memo that used to live, copy-pasted, in
 * both manage/gradebook/gradebookTable.tsx and gradebook/whatIf.tsx. That memo
 * split `slug` on "-", special-cased slugs shaped `assignment-<type>-*`, and
 * required a group's `sort_order` values to run consecutively. Membership now
 * comes from `gradebook_columns.group_id`, so nothing here inspects a slug.
 *
 * The return shape is unchanged on purpose: a `Record` of group key to
 * `{ groupName, columns }`, with single-column entries for ungrouped columns,
 * which is what the ~18 call sites in gradebookTable.tsx already handle (a
 * bucket of one renders as a plain column with no group header).
 */

export interface GroupedColumnBucket<T> {
  groupName: string;
  columns: T[];
}

/** The column fields grouping needs. Deliberately narrow so both callers fit. */
export interface GroupableColumn {
  id: number;
  name: string;
  sort_order: number | null;
  group_id: number | null;
}

type GroupRow = Pick<GradebookColumnGroup, "id" | "name" | "slug" | "sort_order">;

const bySortOrder = (a: { sort_order: number | null }, b: { sort_order: number | null }) =>
  (a.sort_order ?? 0) - (b.sort_order ?? 0);

/**
 * @param columns  the gradebook's columns, in any order
 * @param groups   the gradebook's stored groups, in any order
 *
 * Ordering policy. Membership is independent of `sort_order`, so a group's
 * columns are not guaranteed to be adjacent. A group is therefore placed at the
 * position of its earliest column, and its columns are listed together at that
 * position. That reproduces the old left-to-right order for every gradebook
 * whose groups are contiguous, and gives a defined answer when one isn't,
 * instead of splitting the group the way the contiguity check used to.
 *
 * Keys are prefixed (`g:` / `c:`) so they can never be integer-like strings.
 * JavaScript reorders integer-like keys ahead of string keys on `Object.keys`,
 * and callers iterate this record to lay the table out, so a group whose slug
 * was "2024" would otherwise silently jump to the front.
 */
export function buildGroupedColumns<T extends GroupableColumn>(
  columns: T[],
  groups: GroupRow[]
): Record<string, GroupedColumnBucket<T>> {
  const groupsById = new Map<number, GroupRow>(groups.map((g) => [g.id, g]));

  const membersByGroupId = new Map<number, T[]>();
  const ungrouped: T[] = [];

  for (const col of columns) {
    // A group_id pointing at a group we cannot see (RLS) or that is not loaded
    // is treated as ungrouped rather than dropped, so a column never vanishes
    // from the gradebook because its group row was filtered out.
    if (col.group_id !== null && groupsById.has(col.group_id)) {
      const existing = membersByGroupId.get(col.group_id);
      if (existing) {
        existing.push(col);
      } else {
        membersByGroupId.set(col.group_id, [col]);
      }
    } else {
      ungrouped.push(col);
    }
  }

  const buckets: Array<{ key: string; position: number; tieBreak: number; bucket: GroupedColumnBucket<T> }> = [];

  for (const [groupId, members] of membersByGroupId) {
    const group = groupsById.get(groupId)!;
    members.sort(bySortOrder);
    buckets.push({
      key: `g:${group.slug}`,
      position: members[0].sort_order ?? 0,
      tieBreak: group.sort_order,
      bucket: { groupName: group.name, columns: members }
    });
  }

  for (const col of ungrouped) {
    buckets.push({
      key: `c:${col.id}`,
      position: col.sort_order ?? 0,
      tieBreak: -1,
      bucket: { groupName: col.name, columns: [col] }
    });
  }

  buckets.sort((a, b) => a.position - b.position || a.tieBreak - b.tieBreak || a.key.localeCompare(b.key));

  const result: Record<string, GroupedColumnBucket<T>> = {};
  for (const entry of buckets) {
    result[entry.key] = entry.bucket;
  }
  return result;
}

/**
 * The [key, bucket] pair holding `columnId`, or undefined if it isn't grouped.
 *
 * Callers used to rebuild the column's group key from its slug and then match it
 * against the record's keys with `startsWith`, which meant three more copies of
 * the prefix heuristic. A column belongs to exactly one bucket, so membership
 * alone identifies it and the slug never needs to be parsed.
 */
export function findGroupEntryForColumn<T extends GroupableColumn>(
  groupedColumns: Record<string, GroupedColumnBucket<T>>,
  columnId: number
): [string, GroupedColumnBucket<T>] | undefined {
  return Object.entries(groupedColumns).find(([, group]) => group.columns.some((col) => col.id === columnId));
}
