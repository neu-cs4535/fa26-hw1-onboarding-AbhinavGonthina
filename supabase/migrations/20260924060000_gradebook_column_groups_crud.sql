-- CRUD for gradebook column groups: create, rename, delete, reorder, and moving
-- a column between groups.
--
-- Everything goes through RPCs rather than table writes, for two reasons. The
-- house rule is to prefer Postgres RPCs for data operations, and more
-- concretely: creating a group has to mint a unique slug, deleting one has to
-- close the gap it leaves, and reordering has to move several rows at once.
-- Those are transactions, not single-row writes.
--
-- The invariant the assignment cares about is that reordering preserves group
-- membership. It holds here by construction rather than by effort:
-- gradebook_columns.group_id is the only thing that records membership, and no
-- function below writes it except gradebook_column_set_group, whose entire job
-- is to change it. Every reorder path writes sort_order only. The existing
-- gradebook_columns_reorder RPC, which backs column drag-and-drop, is the same
-- shape and needed no change.

-- ---------------------------------------------------------------------------
-- Has an instructor curated this gradebook's groups?
--
-- The backfill cannot tell a column nobody has classified yet from one an
-- instructor deliberately pulled out of a group, because both are a NULL
-- group_id. Without something recording the difference, the insert trigger in
-- 20260924100000 re-groups a column that was removed on purpose the next time
-- any column is added, which is the same complaint the old slug heuristic
-- earned: the system deciding grouping over the instructor's head.
--
-- Every function below that an instructor can invoke sets this flag. The
-- backfill does not, so the one-time classification and the seeding path leave
-- it false and a fresh gradebook still gets grouped automatically. Once an
-- instructor has touched the groups, the trigger stops classifying for them.
-- ---------------------------------------------------------------------------

alter table public.gradebooks
  add column if not exists column_groups_curated boolean not null default false;

comment on column public.gradebooks.column_groups_curated is
  'True once an instructor has created, renamed, deleted, reordered or reassigned a column group here. While false, newly inserted columns are classified automatically; once true, the automatic classification stays out of the way.';

-- ---------------------------------------------------------------------------
-- Helper: resolve a group to its gradebook and class, and require instructor.
-- ---------------------------------------------------------------------------

create or replace function public.gradebook_column_group_authorize(
  p_group_id bigint,
  out o_gradebook_id bigint,
  out o_class_id bigint
)
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  select g.gradebook_id, g.class_id
    into o_gradebook_id, o_class_id
  from public.gradebook_column_groups g
  where g.id = p_group_id;

  if o_gradebook_id is null then
    raise exception 'gradebook column group % not found', p_group_id;
  end if;

  if not public.authorizeforclassinstructor(o_class_id) then
    raise exception 'insufficient permissions: instructor access required for class %', o_class_id
      using errcode = 'insufficient_privilege';
  end if;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Keep a gradebook's group order agreeing with what is on screen.
--
-- A group is displayed at the position of its earliest column, so the stored
-- sort_order has to be derived from that rather than set independently.
-- Otherwise assigning a column can move a group on screen while the manage
-- list still shows the old order -- and the two disagree until something else
-- happens to renumber them.
--
-- Groups with no columns keep a defined place at the end rather than becoming
-- unorderable.
-- ---------------------------------------------------------------------------

create or replace function public.gradebook_column_groups_resequence(p_gradebook_id bigint)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  set constraints all deferred;

  update public.gradebook_column_groups g
  set sort_order = ranked.new_order
  from (
    select
      grp.id,
      (row_number() over (
        order by coalesce(pos.first_col, 2147483647), grp.sort_order, grp.id
      ))::integer - 1 as new_order
    from public.gradebook_column_groups grp
    left join (
      select gc.group_id, min(coalesce(gc.sort_order, 0)) as first_col
      from public.gradebook_columns gc
      where gc.gradebook_id = p_gradebook_id and gc.group_id is not null
      group by gc.group_id
    ) pos on pos.group_id = grp.id
    where grp.gradebook_id = p_gradebook_id
  ) as ranked
  where g.id = ranked.id
    and g.sort_order <> ranked.new_order;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Create
-- ---------------------------------------------------------------------------

create or replace function public.gradebook_column_group_create(
  p_gradebook_id bigint,
  p_name text
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_class_id bigint;
  v_name text := btrim(coalesce(p_name, ''));
  v_base text;
  v_slug text;
  v_n integer := 1;
  v_sort integer;
  v_id bigint;
begin
  if v_name = '' then
    raise exception 'A column group needs a name';
  end if;

  select class_id into v_class_id from public.gradebooks where id = p_gradebook_id;
  if v_class_id is null then
    raise exception 'gradebook % not found', p_gradebook_id;
  end if;
  if not public.authorizeforclassinstructor(v_class_id) then
    raise exception 'insufficient permissions: instructor access required for class %', v_class_id
      using errcode = 'insufficient_privilege';
  end if;

  if exists (
    select 1 from public.gradebook_column_groups
    where gradebook_id = p_gradebook_id and lower(name) = lower(v_name)
  ) then
    raise exception 'This gradebook already has a group called "%"', v_name
      using errcode = 'unique_violation';
  end if;

  -- The slug is the stable key the UI persists collapse state against, so it is
  -- minted once here and never changes again -- including on rename.
  v_base := regexp_replace(regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g'), '^-+|-+$', '', 'g');
  if v_base = '' then
    v_base := 'group';
  end if;
  v_slug := v_base;
  while exists (
    select 1 from public.gradebook_column_groups
    where gradebook_id = p_gradebook_id and slug = v_slug
  ) loop
    v_n := v_n + 1;
    v_slug := v_base || '-' || v_n;
  end loop;

  select coalesce(max(sort_order), -1) + 1 into v_sort
  from public.gradebook_column_groups
  where gradebook_id = p_gradebook_id;

  insert into public.gradebook_column_groups (class_id, gradebook_id, name, slug, sort_order)
  values (v_class_id, p_gradebook_id, v_name, v_slug, v_sort)
  returning id into v_id;

  update public.gradebooks
  set column_groups_curated = true
  where id = p_gradebook_id and column_groups_curated = false;

  return v_id;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Rename. Changes the title only; the slug stays put so collapse state and any
-- other reference to the group survives being renamed.
-- ---------------------------------------------------------------------------

create or replace function public.gradebook_column_group_rename(
  p_group_id bigint,
  p_name text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_gradebook_id bigint;
  v_class_id bigint;
  v_name text := btrim(coalesce(p_name, ''));
begin
  if v_name = '' then
    raise exception 'A column group needs a name';
  end if;

  select o_gradebook_id, o_class_id into v_gradebook_id, v_class_id
  from public.gradebook_column_group_authorize(p_group_id);

  if exists (
    select 1 from public.gradebook_column_groups
    where gradebook_id = v_gradebook_id
      and lower(name) = lower(v_name)
      and id <> p_group_id
  ) then
    raise exception 'This gradebook already has a group called "%"', v_name
      using errcode = 'unique_violation';
  end if;

  update public.gradebook_column_groups
  set name = v_name
  where id = p_group_id;

  update public.gradebooks
  set column_groups_curated = true
  where id = v_gradebook_id and column_groups_curated = false;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Delete. The FK on gradebook_columns is ON DELETE SET NULL (group_id), so the
-- group's columns become ungrouped and render standalone. Columns are never
-- deleted with their group.
-- ---------------------------------------------------------------------------

create or replace function public.gradebook_column_group_delete(p_group_id bigint)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_gradebook_id bigint;
  v_class_id bigint;
begin
  select o_gradebook_id, o_class_id into v_gradebook_id, v_class_id
  from public.gradebook_column_group_authorize(p_group_id);

  delete from public.gradebook_column_groups where id = p_group_id;

  -- Close the gap the delete left.
  perform public.gradebook_column_groups_resequence(v_gradebook_id);

  update public.gradebooks
  set column_groups_curated = true
  where id = v_gradebook_id and column_groups_curated = false;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Move a column into a group, or out of one with p_group_id => null.
--
-- Writes group_id and nothing else. The column keeps its sort_order, so moving
-- a column between groups does not reshuffle the gradebook.
-- ---------------------------------------------------------------------------

create or replace function public.gradebook_column_set_group(
  p_column_id bigint,
  p_group_id bigint
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_gradebook_id bigint;
  v_class_id bigint;
  v_group_gradebook_id bigint;
begin
  select gc.gradebook_id, gc.class_id into v_gradebook_id, v_class_id
  from public.gradebook_columns gc
  where gc.id = p_column_id;

  if v_gradebook_id is null then
    raise exception 'gradebook column % not found', p_column_id;
  end if;
  if not public.authorizeforclassinstructor(v_class_id) then
    raise exception 'insufficient permissions: instructor access required for class %', v_class_id
      using errcode = 'insufficient_privilege';
  end if;

  -- The composite FK would catch this too; checking here turns a constraint
  -- violation into a sentence.
  if p_group_id is not null then
    select gradebook_id into v_group_gradebook_id
    from public.gradebook_column_groups
    where id = p_group_id;

    if v_group_gradebook_id is null then
      raise exception 'gradebook column group % not found', p_group_id;
    end if;
    if v_group_gradebook_id <> v_gradebook_id then
      raise exception 'group % belongs to a different gradebook', p_group_id;
    end if;
  end if;

  update public.gradebook_columns
  set group_id = p_group_id
  where id = p_column_id;

  -- Membership decides display position, so the group order has to follow.
  perform public.gradebook_column_groups_resequence(v_gradebook_id);

  update public.gradebooks
  set column_groups_curated = true
  where id = v_gradebook_id and column_groups_curated = false;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Reorder: move a group left or right past its neighbouring unit.
--
-- A "unit" is what the gradebook draws side by side: a group (all of its
-- columns, together) or a single ungrouped column. Because a group is displayed
-- at the position of its earliest column, moving a group means moving that
-- whole block of columns -- so this writes gradebook_columns.sort_order, and
-- group_id is never touched. That is the invariant: reordering preserves
-- membership.
--
-- p_offset is -1 for "left" and +1 for "right". Larger magnitudes move further.
-- ---------------------------------------------------------------------------

create or replace function public.gradebook_column_groups_move(
  p_group_id bigint,
  p_offset integer
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_gradebook_id bigint;
  v_class_id bigint;
  v_units text[];
  v_from integer;
  v_to integer;
  v_unit text;
  v_ordered_column_ids bigint[];
begin
  select o_gradebook_id, o_class_id into v_gradebook_id, v_class_id
  from public.gradebook_column_group_authorize(p_group_id);

  if p_offset is null or p_offset = 0 then
    return;
  end if;

  perform pg_advisory_xact_lock(v_gradebook_id);

  -- Units in current display order. A grouped column's unit is its group; an
  -- ungrouped column is its own unit.
  select array_agg(unit order by pos, unit)
    into v_units
  from (
    select
      case when gc.group_id is null then 'c' || gc.id::text else 'g' || gc.group_id::text end as unit,
      min(coalesce(gc.sort_order, 0)) as pos
    from public.gradebook_columns gc
    where gc.gradebook_id = v_gradebook_id
    group by 1
  ) as units;

  v_unit := 'g' || p_group_id::text;
  v_from := array_position(v_units, v_unit);
  if v_from is null then
    -- A group with no columns has no position to move.
    return;
  end if;

  v_to := v_from + p_offset;
  if v_to < 1 then
    v_to := 1;
  end if;
  if v_to > array_length(v_units, 1) then
    v_to := array_length(v_units, 1);
  end if;
  if v_to = v_from then
    return;
  end if;

  -- Remove, then reinsert at the target index.
  v_units := v_units[1:v_from - 1] || v_units[v_from + 1:array_length(v_units, 1)];
  v_units := v_units[1:v_to - 1] || array[v_unit] || v_units[v_to:array_length(v_units, 1)];

  -- Flatten units back to columns, keeping each unit's internal order.
  select array_agg(gc.id order by u.ordinality, coalesce(gc.sort_order, 0), gc.id)
    into v_ordered_column_ids
  from unnest(v_units) with ordinality as u(unit, ordinality)
  join public.gradebook_columns gc
    on (case when gc.group_id is null then 'c' || gc.id::text else 'g' || gc.group_id::text end) = u.unit
  where gc.gradebook_id = v_gradebook_id;

  -- Same bypass the existing column-reorder RPC uses: the per-row sort_order
  -- trigger treats an UPDATE as a move and would fight a bulk renumber.
  perform set_config('pawtograder.bypass_sort_order_trigger_' || v_gradebook_id::text, 'true', true);

  begin
    update public.gradebook_columns gc
    set sort_order = ord.new_order
    from (
      select id, (ordinality - 1)::integer as new_order
      from unnest(v_ordered_column_ids) with ordinality as t(id, ordinality)
    ) as ord
    where gc.id = ord.id
      and gc.gradebook_id = v_gradebook_id;
  exception
    when others then
      perform set_config('pawtograder.bypass_sort_order_trigger_' || v_gradebook_id::text, 'false', true);
      raise;
  end;

  perform set_config('pawtograder.bypass_sort_order_trigger_' || v_gradebook_id::text, 'false', true);

  -- Keep the groups' own sort_order agreeing with the order now on screen.
  perform public.gradebook_column_groups_resequence(v_gradebook_id);

  update public.gradebooks
  set column_groups_curated = true
  where id = v_gradebook_id and column_groups_curated = false;
end;
$function$;

-- ---------------------------------------------------------------------------

grant execute on function public.gradebook_column_groups_resequence(bigint) to authenticated;
grant execute on function public.gradebook_column_groups_resequence(bigint) to service_role;
grant execute on function public.gradebook_column_group_create(bigint, text) to authenticated;
grant execute on function public.gradebook_column_group_rename(bigint, text) to authenticated;
grant execute on function public.gradebook_column_group_delete(bigint) to authenticated;
grant execute on function public.gradebook_column_set_group(bigint, bigint) to authenticated;
grant execute on function public.gradebook_column_groups_move(bigint, integer) to authenticated;

grant execute on function public.gradebook_column_group_create(bigint, text) to service_role;
grant execute on function public.gradebook_column_group_rename(bigint, text) to service_role;
grant execute on function public.gradebook_column_group_delete(bigint) to service_role;
grant execute on function public.gradebook_column_set_group(bigint, bigint) to service_role;
grant execute on function public.gradebook_column_groups_move(bigint, integer) to service_role;

-- The authorize helper is an internal detail; SECURITY DEFINER functions above
-- call it, and nothing else should.
revoke all on function public.gradebook_column_group_authorize(bigint) from public;

comment on function public.gradebook_column_groups_move(bigint, integer) is
  'Moves a group past its neighbouring unit by renumbering gradebook_columns.sort_order for the whole block. Never writes group_id, so reordering preserves group membership.';
