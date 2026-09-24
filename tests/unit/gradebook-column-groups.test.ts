import { buildGroupedColumns, findGroupEntryForColumn, type GroupableColumn } from "@/lib/gradebookColumnGroups";

/**
 * Unit tests for the shaping that replaced the `groupedColumns` memo.
 *
 * These are the properties the old slug-prefix heuristic got wrong, written as
 * assertions so a later change cannot quietly reintroduce them.
 */

type Col = GroupableColumn & { slug: string };

const col = (id: number, slug: string, sort_order: number | null, group_id: number | null): Col => ({
  id,
  name: slug,
  slug,
  sort_order,
  group_id
});

const group = (id: number, name: string, slug: string, sort_order: number) => ({ id, name, slug, sort_order });

describe("buildGroupedColumns", () => {
  it("puts a group's columns in one bucket, titled from the group row", () => {
    const groups = [group(1, "Quiz", "quiz", 0)];
    const columns = [col(10, "quiz-1", 0, 1), col(11, "quiz-2", 1, 1)];

    const result = buildGroupedColumns(columns, groups);

    expect(Object.keys(result)).toEqual(["g:quiz"]);
    expect(result["g:quiz"].groupName).toBe("Quiz");
    expect(result["g:quiz"].columns.map((c) => c.id)).toEqual([10, 11]);
  });

  it("keeps a family together across a hole in sort_order", () => {
    // The seeded case: quiz-3 was deleted, so sort_order runs 11,12,14,15.
    // The old contiguity check split this into two groups, both titled "Quiz".
    const groups = [group(1, "Quiz", "quiz", 0)];
    const columns = [
      col(10, "quiz-1", 11, 1),
      col(11, "quiz-2", 12, 1),
      col(13, "quiz-4", 14, 1),
      col(14, "quiz-5", 15, 1)
    ];

    const result = buildGroupedColumns(columns, groups);

    expect(Object.keys(result)).toHaveLength(1);
    expect(result["g:quiz"].columns.map((c) => c.slug)).toEqual(["quiz-1", "quiz-2", "quiz-4", "quiz-5"]);
  });

  it("gives each ungrouped column its own single-column bucket", () => {
    // Callers render a bucket of one as a plain column with no group header, so
    // "ungrouped" has to arrive in that shape rather than be omitted.
    const columns = [col(10, "attendance", 0, null), col(11, "final", 1, null)];

    const result = buildGroupedColumns(columns, []);

    expect(Object.keys(result)).toEqual(["c:10", "c:11"]);
    expect(result["c:10"].columns).toHaveLength(1);
    expect(result["c:10"].groupName).toBe("attendance");
  });

  it("orders buckets by each group's earliest column, interleaving ungrouped columns", () => {
    const groups = [group(1, "Exam", "exam", 5), group(2, "Lab", "lab", 9)];
    const columns = [
      col(10, "assignment-lab-1", 0, 2),
      col(11, "attendance", 1, null),
      col(12, "exam-1", 2, 1),
      col(13, "final", 3, null)
    ];

    const result = buildGroupedColumns(columns, groups);

    // Lab first because its earliest column is at sort_order 0, even though its
    // own sort_order (9) is the highest of the two groups.
    expect(Object.keys(result)).toEqual(["g:lab", "c:11", "g:exam", "c:13"]);
  });

  it("places a non-contiguous group at its earliest column and keeps it whole", () => {
    // Membership is independent of sort_order, so this state is representable.
    // The documented resolution is: one bucket, at the position of its first
    // column. The old code would have split it.
    const groups = [group(1, "Quiz", "quiz", 0), group(2, "Exam", "exam", 1)];
    const columns = [
      col(10, "quiz-1", 0, 1),
      col(11, "exam-1", 1, 2),
      col(12, "quiz-2", 2, 1) // interleaved
    ];

    const result = buildGroupedColumns(columns, groups);

    expect(Object.keys(result)).toEqual(["g:quiz", "g:exam"]);
    expect(result["g:quiz"].columns.map((c) => c.id)).toEqual([10, 12]);
  });

  it("prefixes keys so an all-digit group slug cannot jump to the front", () => {
    // JavaScript orders integer-like object keys ahead of string keys, and
    // callers iterate this record to lay out the table. An unprefixed key of
    // "2024" would silently move that group to the left edge.
    const groups = [group(1, "Fall", "2024", 0)];
    const columns = [col(10, "a", 0, null), col(11, "b", 1, 1), col(12, "c", 2, 1)];

    const result = buildGroupedColumns(columns, groups);

    expect(Object.keys(result)).toEqual(["c:10", "g:2024"]);
  });

  it("treats a column whose group is not loaded as ungrouped rather than dropping it", () => {
    // RLS can hide a group row from a student. The column must still render.
    const columns = [col(10, "secret", 0, 999)];

    const result = buildGroupedColumns(columns, []);

    expect(Object.keys(result)).toEqual(["c:10"]);
    expect(result["c:10"].columns[0].id).toBe(10);
  });

  it("sorts columns within a group by sort_order regardless of input order", () => {
    const groups = [group(1, "Skill", "skill", 0)];
    const columns = [col(12, "skill-3", 2, 1), col(10, "skill-1", 0, 1), col(11, "skill-2", 1, 1)];

    const result = buildGroupedColumns(columns, groups);

    expect(result["g:skill"].columns.map((c) => c.id)).toEqual([10, 11, 12]);
  });

  it("loses no column", () => {
    const groups = [group(1, "Quiz", "quiz", 0)];
    const columns = [col(10, "quiz-1", 0, 1), col(11, "attendance", 1, null), col(12, "quiz-2", 2, 1)];

    const result = buildGroupedColumns(columns, groups);

    const seen = Object.values(result).flatMap((b) => b.columns.map((c) => c.id));
    expect(seen.sort()).toEqual([10, 11, 12]);
  });
});

describe("findGroupEntryForColumn", () => {
  const groups = [group(1, "Quiz", "quiz", 0)];
  const columns = [col(10, "quiz-1", 0, 1), col(11, "quiz-2", 1, 1), col(12, "attendance", 2, null)];
  const grouped = buildGroupedColumns(columns, groups);

  it("finds a column's group by membership, not by parsing its slug", () => {
    const entry = findGroupEntryForColumn(grouped, 11);
    expect(entry?.[0]).toBe("g:quiz");
    expect(entry?.[1].groupName).toBe("Quiz");
  });

  it("returns the single-column bucket for an ungrouped column", () => {
    const entry = findGroupEntryForColumn(grouped, 12);
    expect(entry?.[0]).toBe("c:12");
    expect(entry?.[1].columns).toHaveLength(1);
  });

  it("returns undefined for a column that is not present", () => {
    expect(findGroupEntryForColumn(grouped, 999)).toBeUndefined();
  });
});
