-- Database-level tests for gradebook column groups.
--
-- The TypeScript shaping is covered by tests/unit/gradebook-column-groups.test.ts
-- and the UI by tests/e2e/gradebook-column-groups-crud.spec.ts. This covers the
-- parts that only exist in Postgres: what the backfill classifies, whether the
-- RLS policies isolate courses, and whether the CRUD functions hold their
-- invariants.
--
-- Not wired into the handout's CI. The gradebook-e2e workflow runs a fixed list
-- of specs and I chose not to edit the grading harness; run this by hand:
--
--   npm run seed -- --template cs4535
--   docker exec -i supabase_db_pawtograder-platform psql -U postgres \
--     < tests/sql/gradebook_column_groups.test.sql
--
-- Everything runs inside a transaction and rolls back, so a seeded class is
-- left exactly as it was found.

\pset pager off
\set ON_ERROR_STOP on

begin;

-- ---------------------------------------------------------------------------
-- 1. Backfill classification
-- ---------------------------------------------------------------------------
do $$
declare
  v_gb bigint;
  v_actual text;
  v_expected text := 'AI Usage Log:2|Assignment:4|Exam:3|Lab:4|Quiz:4|Skill:12';
  v_ungrouped integer;
begin
  select g.id into v_gb
  from public.gradebooks g
  join public.classes c on c.id = g.class_id
  where c.name like 'CS 4535%'
  order by g.id desc
  limit 1;

  if v_gb is null then
    raise exception 'No CS 4535 gradebook. Run: npm run seed -- --template cs4535';
  end if;

  select string_agg(t.name || ':' || t.n, '|' order by t.name) into v_actual
  from (
    select grp.name, count(gc.id) as n
    from public.gradebook_column_groups grp
    left join public.gradebook_columns gc on gc.group_id = grp.id
    where grp.gradebook_id = v_gb
    group by grp.name
  ) t;

  if v_actual is distinct from v_expected then
    raise exception E'Backfill produced different groups.\n  expected: %\n  actual:   %', v_expected, v_actual;
  end if;
  raise notice '1. BACKFILL  -> %', v_actual;

  -- The quiz family must be whole despite the hole where quiz-3 was deleted.
  if (select count(distinct gc.group_id)
      from public.gradebook_columns gc
      where gc.gradebook_id = v_gb and gc.slug like 'quiz-%') <> 1 then
    raise exception 'FAIL: the quiz family is split across more than one group';
  end if;
  raise notice '   quiz-1,2,4,5 are one group despite the sort_order hole';

  -- assignment-final has two slug segments, so it must NOT land in the
  -- assignment family; it is a family of one and therefore ungrouped.
  if (select gc.group_id from public.gradebook_columns gc
      where gc.gradebook_id = v_gb and gc.slug = 'assignment-final') is not null then
    raise exception 'FAIL: assignment-final was grouped';
  end if;
  raise notice '   assignment-final is ungrouped, not filed under "Assignment"';

  -- Stated policy: a family of one becomes no group at all.
  select count(*) into v_ungrouped
  from public.gradebook_columns gc
  where gc.gradebook_id = v_gb and gc.group_id is null;
  if v_ungrouped <> 11 then
    raise exception 'FAIL: expected 11 ungrouped columns, got %', v_ungrouped;
  end if;
  raise notice '   % columns left ungrouped by the size-2 rule', v_ungrouped;

  -- No group may be empty or hold a column from another gradebook.
  if exists (
    select 1 from public.gradebook_column_groups grp
    join public.gradebook_columns gc on gc.group_id = grp.id
    where grp.gradebook_id <> gc.gradebook_id
  ) then
    raise exception 'FAIL: a column is in a group from another gradebook';
  end if;
  raise notice '   no cross-gradebook membership';

  -- Idempotence: re-running assigns nothing.
  if public.backfill_gradebook_column_groups(v_gb) <> 0 then
    raise exception 'FAIL: backfill is not idempotent';
  end if;
  raise notice '   re-running the backfill assigns 0 columns';
end $$;

-- ---------------------------------------------------------------------------
-- 2. RLS isolation
-- ---------------------------------------------------------------------------
do $$
declare
  v_class bigint;
  v_inst uuid; v_stud uuid; v_outsider uuid;
  n integer;
begin
  select c.id into v_class from public.classes c where c.name like 'CS 4535%' order by c.id desc limit 1;
  select user_id into v_inst from public.user_roles where class_id = v_class and role = 'instructor' limit 1;
  select user_id into v_stud from public.user_roles where class_id = v_class and role = 'student' limit 1;
  select ur.user_id into v_outsider
  from public.user_roles ur
  where ur.class_id <> v_class
    and not exists (select 1 from public.user_roles x where x.user_id = ur.user_id and x.class_id = v_class)
  limit 1;

  perform set_config('request.jwt.claims', json_build_object('sub', v_inst, 'role','authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from public.gradebook_column_groups where class_id = v_class;
  if n = 0 then raise exception 'FAIL: instructor cannot see their own groups'; end if;
  raise notice '2. RLS       -> instructor sees % groups', n;

  perform set_config('request.jwt.claims', json_build_object('sub', v_stud, 'role','authenticated')::text, true);
  select count(*) into n from public.gradebook_column_groups where class_id = v_class;
  if n = 0 then raise exception 'FAIL: enrolled student cannot see groups'; end if;
  raise notice '   enrolled student sees % groups', n;

  if v_outsider is not null then
    perform set_config('request.jwt.claims', json_build_object('sub', v_outsider, 'role','authenticated')::text, true);
    select count(*) into n from public.gradebook_column_groups where class_id = v_class;
    if n <> 0 then raise exception 'FAIL: a user outside the class saw % groups', n; end if;
    raise notice '   user in another class sees 0 of this course''s groups';
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role','authenticated')::text, true);
  select count(*) into n from public.gradebook_column_groups;
  if n <> 0 then raise exception 'FAIL: a user in no class saw % groups', n; end if;
  raise notice '   user in no class sees 0 groups';

  reset role;
end $$;

-- ---------------------------------------------------------------------------
-- 3. CRUD, and the invariant: reordering preserves membership
-- ---------------------------------------------------------------------------
do $$
declare
  v_gb bigint; v_class bigint; v_inst uuid;
  v_group bigint;
  v_before text; v_after text;
  v_units_before text; v_units_after text;
  v_cnt integer; v_total integer;
begin
  select c.id, g.id into v_class, v_gb
  from public.classes c join public.gradebooks g on g.class_id = c.id
  where c.name like 'CS 4535%' order by c.id desc limit 1;
  select user_id into v_inst from public.user_roles where class_id = v_class and role = 'instructor' limit 1;
  perform set_config('request.jwt.claims', json_build_object('sub', v_inst, 'role','authenticated')::text, true);

  select count(*) into v_total from public.gradebook_columns where gradebook_id = v_gb;

  v_group := public.gradebook_column_group_create(v_gb, 'Test Aggregates');
  if (select slug from public.gradebook_column_groups where id = v_group) <> 'test-aggregates' then
    raise exception 'FAIL: slug not derived from name';
  end if;
  raise notice '3. CREATE    -> slug minted from name';

  begin
    perform public.gradebook_column_group_create(v_gb, 'test aggregates');
    raise exception 'FAIL: a duplicate name was accepted';
  exception when unique_violation then
    raise notice '   duplicate name refused';
  end;

  perform public.gradebook_column_set_group(gc.id, v_group)
  from public.gradebook_columns gc
  where gc.gradebook_id = v_gb and gc.slug in ('average.hw', 'labs-drop-lowest', 'total-labs');
  raise notice '   ASSIGN    -> 3 columns moved in';

  perform public.gradebook_column_group_rename(v_group, 'Aggregates');
  if (select name || '/' || slug from public.gradebook_column_groups where id = v_group)
     <> 'Aggregates/test-aggregates' then
    raise exception 'FAIL: rename changed the slug';
  end if;
  raise notice '   RENAME    -> title changed, slug unchanged';

  select string_agg(gc.slug || '=' || coalesce(gc.group_id::text,'-'), ',' order by gc.slug) into v_before
  from public.gradebook_columns gc where gc.gradebook_id = v_gb;
  select string_agg(u.unit,'>' order by u.pos, u.unit) into v_units_before from (
    select case when gc.group_id is null then 'c'||gc.id else 'g'||gc.group_id end as unit,
           min(coalesce(gc.sort_order,0)) as pos
    from public.gradebook_columns gc where gc.gradebook_id = v_gb group by 1) u;

  perform public.gradebook_column_groups_move(v_group, -3);

  select string_agg(gc.slug || '=' || coalesce(gc.group_id::text,'-'), ',' order by gc.slug) into v_after
  from public.gradebook_columns gc where gc.gradebook_id = v_gb;
  select string_agg(u.unit,'>' order by u.pos, u.unit) into v_units_after from (
    select case when gc.group_id is null then 'c'||gc.id else 'g'||gc.group_id end as unit,
           min(coalesce(gc.sort_order,0)) as pos
    from public.gradebook_columns gc where gc.gradebook_id = v_gb group by 1) u;

  if v_units_before = v_units_after then raise exception 'FAIL: the move did nothing'; end if;
  if v_before <> v_after then raise exception 'FAIL: REORDER CHANGED MEMBERSHIP'; end if;
  raise notice '   REORDER   -> order changed, membership identical';

  if exists (select sort_order from public.gradebook_columns
             where gradebook_id = v_gb group by sort_order having count(*) > 1) then
    raise exception 'FAIL: duplicate sort_order after the move';
  end if;
  raise notice '   sort_order still unique';

  perform public.gradebook_column_group_delete(v_group);
  select count(*) into v_cnt from public.gradebook_columns
  where gradebook_id = v_gb and slug in ('average.hw','labs-drop-lowest','total-labs') and group_id is null;
  if v_cnt <> 3 then raise exception 'FAIL: columns not ungrouped on delete (got %)', v_cnt; end if;
  if (select count(*) from public.gradebook_columns where gradebook_id = v_gb) <> v_total then
    raise exception 'FAIL: the column count changed';
  end if;
  raise notice '   DELETE    -> group gone, its 3 columns ungrouped, all % columns intact', v_total;
end $$;

-- ---------------------------------------------------------------------------
-- 4. A student may not edit groups
-- ---------------------------------------------------------------------------
do $$
declare v_class bigint; v_gb bigint; v_stud uuid;
begin
  select c.id, g.id into v_class, v_gb
  from public.classes c join public.gradebooks g on g.class_id = c.id
  where c.name like 'CS 4535%' order by c.id desc limit 1;
  select user_id into v_stud from public.user_roles where class_id = v_class and role = 'student' limit 1;
  perform set_config('request.jwt.claims', json_build_object('sub', v_stud, 'role','authenticated')::text, true);
  begin
    perform public.gradebook_column_group_create(v_gb, 'Student Made This');
    raise exception 'FAIL: a student created a group';
  exception when insufficient_privilege then
    raise notice '4. AUTHZ     -> student refused';
  end;
end $$;

\echo '--- ALL SQL ASSERTIONS PASSED ---'

rollback;
