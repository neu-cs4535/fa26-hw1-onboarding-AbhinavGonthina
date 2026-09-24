/**
 * Column group CRUD, driven through the instructor UI.
 *
 * The companion spec (gradebook-column-groups.spec.ts) photographs the grouped
 * gradebook. This one exercises the editing path the Distinction band asks for:
 * create a group, move a column into it, rename it, reorder it, delete it.
 *
 * Every assertion is made against the database rather than against the screen,
 * because the claim being tested is about stored state. In particular the last
 * one: reordering must preserve group membership. The test snapshots the whole
 * column -> group map, reorders, and requires the map to come back identical
 * while the on-screen order changes.
 *
 * It leaves the seeded class as it found it: the group it creates is deleted at
 * the end, and the reorder is performed in both directions.
 *
 * Requires `npm run seed -- --template cs4535`.
 */
import { test, expect } from "../global-setup";
import type { Page } from "@playwright/test";
import { supabase, loginAsUser, type TestingUser } from "./TestingUtils";
import type { Course } from "@/utils/supabase/DatabaseTypes";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local", quiet: true });

const SEEDED_CLASS_NAME = process.env.COLUMN_GROUPS_CLASS_NAME ?? "CS 4535: Software Design & Delivery";
const NEW_GROUP = "Participation";
/** The column moved in and out of the new group. Ungrouped in the seed. */
const TEST_COLUMN_SLUG = "attendance";

async function findSeededClass(): Promise<Course> {
  const { data, error } = await supabase
    .from("classes")
    .select("*")
    .eq("name", SEEDED_CLASS_NAME)
    .order("id", { ascending: false })
    .limit(1);
  if (error) throw new Error(`Could not query classes: ${error.message}`);
  if (!data?.length) {
    throw new Error(`No class named "${SEEDED_CLASS_NAME}". Run \`npm run seed -- --template cs4535\` first.`);
  }
  return data[0] as Course;
}

async function findInstructor(class_id: number): Promise<TestingUser> {
  const { data, error } = await supabase
    .from("user_roles")
    .select("user_id, private_profile_id, public_profile_id, users(email), profiles!private_profile_id(name)")
    .eq("class_id", class_id)
    .eq("role", "instructor")
    .limit(50);
  if (error) throw new Error(`Could not query instructors for class ${class_id}: ${error.message}`);
  const rows = (data ?? []) as unknown as Array<{
    user_id: string;
    private_profile_id: string;
    public_profile_id: string;
    users: { email: string | null } | null;
    profiles: { name: string | null } | null;
  }>;
  const preferred = process.env.FIXED_INSTRUCTOR_EMAIL;
  const row = (preferred && rows.find((r) => r.users?.email === preferred)) || rows.find((r) => r.users?.email);
  if (!row?.users?.email) throw new Error(`Class ${class_id} has no instructor with an email address.`);
  return {
    private_profile_name: row.profiles?.name ?? "Instructor",
    public_profile_name: row.profiles?.name ?? "Instructor",
    email: row.users.email,
    user_id: row.user_id,
    private_profile_id: row.private_profile_id,
    public_profile_id: row.public_profile_id,
    class_id,
    password: process.env.TEST_PASSWORD ?? "change-it"
  };
}

/** column slug -> group id (or null). The membership map the reorder must not change. */
async function membershipMap(class_id: number): Promise<Record<string, number | null>> {
  const { data, error } = await supabase
    .from("gradebook_columns")
    .select("slug, group_id")
    .eq("class_id", class_id)
    .order("slug");
  if (error) throw new Error(`Could not read columns: ${error.message}`);
  return Object.fromEntries((data ?? []).map((c) => [c.slug, c.group_id]));
}

/**
 * The left-to-right order of "units" as the gradebook draws them: a group (all
 * of its columns together) or a single ungrouped column.
 *
 * This, not the list of group names, is what a reorder changes. Moving a group
 * past a neighbouring ungrouped column shifts what is on screen without
 * changing the relative order of any two groups.
 */
async function unitOrder(class_id: number): Promise<string> {
  const { data, error } = await supabase
    .from("gradebook_columns")
    .select("id, slug, sort_order, group_id")
    .eq("class_id", class_id)
    .order("sort_order");
  if (error) throw new Error(`Could not read columns: ${error.message}`);
  const seen: string[] = [];
  for (const c of data ?? []) {
    const unit = c.group_id === null ? `col:${c.slug}` : `grp:${c.group_id}`;
    if (seen[seen.length - 1] !== unit) seen.push(unit);
  }
  return seen.join(">");
}

/** Group names in display order. */
async function groupOrder(class_id: number): Promise<string[]> {
  const { data, error } = await supabase
    .from("gradebook_column_groups")
    .select("name, sort_order")
    .eq("class_id", class_id)
    .order("sort_order");
  if (error) throw new Error(`Could not read groups: ${error.message}`);
  return (data ?? []).map((g) => g.name);
}

async function openManageGroups(page: Page) {
  const trigger = page.getByRole("button", { name: "Manage Groups" });
  await expect(trigger).toBeVisible({ timeout: 60_000 });
  await trigger.click();
  await expect(page.getByRole("dialog").getByText("Column groups", { exact: true })).toBeVisible({ timeout: 30_000 });
}

test.describe("gradebook column group CRUD", () => {
  test.use({ viewport: { width: 1600, height: 1200 } });
  test.setTimeout(240_000);

  test("create, assign, rename, reorder and delete a column group", async ({ page }) => {
    const course = await findSeededClass();
    const instructor = await findInstructor(course.id);

    // A previous failed run could have left the group behind, possibly already
    // renamed -- so clean up by slug, which this test never changes, rather than
    // by name.
    await supabase.from("gradebook_column_groups").delete().eq("class_id", course.id).like("slug", "participation%");

    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/gradebook`);
    await expect(page.getByRole("columnheader").first()).toBeVisible({ timeout: 60_000 });

    await openManageGroups(page);

    // --- CREATE ---------------------------------------------------------
    await page.getByLabel("New group name").fill(NEW_GROUP);
    await page.getByRole("button", { name: "Add group" }).click();

    await expect
      .poll(async () => (await groupOrder(course.id)).includes(NEW_GROUP), {
        timeout: 30_000,
        message: "the new group never reached the database"
      })
      .toBe(true);

    const { data: created } = await supabase
      .from("gradebook_column_groups")
      .select("id, name, slug, sort_order")
      .eq("class_id", course.id)
      .eq("name", NEW_GROUP)
      .single();
    expect(created, "created group row").toBeTruthy();
    // The slug is derived from the name, once, and is the stable key.
    expect(created!.slug).toBe("participation");

    // --- ASSIGN A COLUMN ------------------------------------------------
    const { data: testColumn } = await supabase
      .from("gradebook_columns")
      .select("id, name, group_id")
      .eq("class_id", course.id)
      .eq("slug", TEST_COLUMN_SLUG)
      .single();
    expect(testColumn, `seeded column ${TEST_COLUMN_SLUG}`).toBeTruthy();

    await page.getByLabel(`Group for ${testColumn!.name}`).selectOption({ label: NEW_GROUP });

    await expect
      .poll(
        async () => {
          const { data } = await supabase
            .from("gradebook_columns")
            .select("group_id")
            .eq("id", testColumn!.id)
            .single();
          return data?.group_id ?? null;
        },
        { timeout: 30_000, message: "the column never joined the group" }
      )
      .toBe(created!.id);

    // --- RENAME ---------------------------------------------------------
    const renamed = "Participation & Attendance";
    const nameInput = page.getByLabel(`Rename ${NEW_GROUP}`);
    await nameInput.fill(renamed);
    await nameInput.press("Enter");

    await expect
      .poll(
        async () => {
          const { data } = await supabase
            .from("gradebook_column_groups")
            .select("name, slug")
            .eq("id", created!.id)
            .single();
          return `${data?.name}|${data?.slug}`;
        },
        { timeout: 30_000, message: "the rename never landed" }
      )
      // Renaming changes the title and deliberately leaves the slug alone, so
      // anything keyed on the slug survives a rename.
      .toBe(`${renamed}|participation`);

    // The rename has to reach the screen before the reorder controls can be
    // addressed by the new name.
    await expect(page.getByLabel(`Rename ${renamed}`)).toHaveValue(renamed, { timeout: 30_000 });

    // --- REORDER, and the invariant -------------------------------------
    const membershipBefore = await membershipMap(course.id);
    const orderBefore = await unitOrder(course.id);

    await page.getByLabel(`Move ${renamed} left`).click();

    await expect
      .poll(async () => unitOrder(course.id), {
        timeout: 30_000,
        message: "moving the group left changed nothing on screen"
      })
      .not.toBe(orderBefore);

    const membershipAfter = await membershipMap(course.id);
    expect(membershipAfter, "REORDER MUST PRESERVE GROUP MEMBERSHIP").toEqual(membershipBefore);

    // sort_order must still be a clean sequence after moving a whole block.
    const { data: afterCols } = await supabase.from("gradebook_columns").select("sort_order").eq("class_id", course.id);
    const orders = (afterCols ?? []).map((c) => c.sort_order);
    expect(new Set(orders).size, "sort_order must stay unique").toBe(orders.length);

    // Move it back, so the class is left as it was found.
    await page.getByLabel(`Move ${renamed} right`).click();
    await expect
      .poll(async () => unitOrder(course.id), {
        timeout: 30_000,
        message: "moving the group back right did not restore the original order"
      })
      .toBe(orderBefore);
    expect(await membershipMap(course.id), "membership preserved on the way back too").toEqual(membershipBefore);

    // --- DELETE ---------------------------------------------------------
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByLabel(`Delete ${renamed}`).click();

    await expect
      .poll(
        async () => {
          const { data } = await supabase
            .from("gradebook_column_groups")
            .select("id")
            .eq("id", created!.id)
            .maybeSingle();
          return data === null;
        },
        { timeout: 30_000, message: "the group was never deleted" }
      )
      .toBe(true);

    // Deleting a group ungroups its columns. It must not delete them.
    const { data: survivor } = await supabase
      .from("gradebook_columns")
      .select("id, group_id")
      .eq("id", testColumn!.id)
      .single();
    expect(survivor, "the column must survive its group being deleted").toBeTruthy();
    expect(survivor!.group_id, "the column must be ungrouped, not deleted").toBeNull();

    const { count } = await supabase
      .from("gradebook_columns")
      .select("id", { count: "exact", head: true })
      .eq("class_id", course.id);
    expect(count, "no column may be lost by the whole CRUD cycle").toBe(Object.keys(membershipBefore).length);
  });
});
