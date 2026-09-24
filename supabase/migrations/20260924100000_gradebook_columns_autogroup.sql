-- Classify newly created gradebook columns into groups.
--
-- WHY THIS IS NEEDED. The backfill in 20260924044226 runs once, against the
-- gradebooks that exist when the migration replays. Any gradebook created
-- afterwards therefore has columns with a NULL group_id and no groups at all,
-- and the gradebook's Expand/Collapse controls only render when at least one
-- group holds more than one column. So a brand new course lost the grouping it
-- used to get for free: the old slug heuristic re-derived groups on every
-- render, so it grouped any gradebook, whenever it was made.
--
-- That regression is visible in the existing suite. gradebook.test.tsx,
-- gradebook-whatif.test.tsx and gradebook-calculations.test.tsx each build
-- their own fixture course, and all three look for group headers or an
-- "Expand all groups" control that no longer exists for a freshly built
-- gradebook.
--
-- WHAT THIS DOES. On insert, the same classification the migration used runs
-- for the affected gradebook. It is the backfill, not a second copy of the
-- rules, so there is still exactly one place that decides what a family is.
-- Group order is resequenced afterwards, because the seeding path renumbers
-- column sort_order after creating columns and a group is displayed at the
-- position of its earliest column.
--
-- WHAT THIS IS NOT. It is not the render-time heuristic moved into plpgsql.
-- This runs once per insert and writes rows an instructor can then rename,
-- reorder, delete or reassign. The grouping is stored data with a default, not
-- something re-derived every time the page is drawn.
--
-- KNOWN LIMITATION, stated rather than hidden. The backfill only considers
-- columns whose group_id is NULL, which it cannot distinguish between "never
-- classified" and "an instructor deliberately took this column out of a
-- group". So adding a new column to a gradebook where someone has deliberately
-- ungrouped a column will put that column back into a group. The fix is a
-- per-gradebook flag recording that an instructor has curated the groups, set
-- by the CRUD functions and checked here; I have not built it.

create or replace function public.gradebook_columns_autogroup()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_gradebook_id bigint;
begin
  for v_gradebook_id in
    select distinct nt.gradebook_id from new_table nt where nt.gradebook_id is not null
  loop
    perform public.backfill_gradebook_column_groups(v_gradebook_id);
    perform public.gradebook_column_groups_resequence(v_gradebook_id);
  end loop;

  return null;
end;
$function$;

comment on function public.gradebook_columns_autogroup() is
  'Applies backfill_gradebook_column_groups to the gradebooks touched by an insert, so a course created after the original backfill still comes up grouped. Runs once per statement, not per render.';

-- Statement-level rather than per row, so a bulk insert of forty columns costs
-- one classification pass instead of forty. Either would be correct: the
-- backfill is scoped to a gradebook rather than to the inserted rows, so it
-- always sees every column already there when it decides whether a family has
-- enough members to be worth a group.
create trigger gradebook_columns_autogroup_tr
  after insert on public.gradebook_columns
  referencing new table as new_table
  for each statement
  execute function public.gradebook_columns_autogroup();
