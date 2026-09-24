"use client";

import { toaster } from "@/components/ui/toaster";
import { useGradebookController } from "@/hooks/useGradebook";
import { createClient } from "@/utils/supabase/client";
import type { GradebookColumn, GradebookColumnGroup } from "@/utils/supabase/DatabaseTypes";
import {
  Box,
  Button,
  Dialog,
  HStack,
  Icon,
  IconButton,
  Input,
  NativeSelect,
  Portal,
  Separator,
  Table,
  Text,
  VStack
} from "@chakra-ui/react";
import * as Sentry from "@sentry/nextjs";
import { useCallback, useEffect, useMemo, useState } from "react";
import { LuChevronLeft, LuChevronRight, LuLayers, LuTrash2 } from "react-icons/lu";

/**
 * Create, rename, reorder and delete gradebook column groups, and move columns
 * between them.
 *
 * Every write goes through an RPC rather than a table write: creating a group
 * mints a slug, deleting one closes the gap it leaves, and reordering renumbers
 * a whole block of columns. Those are transactions.
 *
 * Reordering never writes gradebook_columns.group_id -- moving a group moves
 * its columns' sort_order, so group membership survives a reorder by
 * construction. See gradebook_column_groups_move.
 */
export default function ManageColumnGroups() {
  const gradebookController = useGradebookController();
  const supabase = useMemo(() => createClient(), []);

  const [isOpen, setIsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState("");
  /** Names being edited, keyed by group id. Absent means "showing the stored name". */
  const [draftNames, setDraftNames] = useState<Record<number, string>>({});

  /**
   * This dialog reads its own copy of the groups and columns rather than going
   * through the shared TableControllers.
   *
   * TableController.refetchAll() throws "Refetch all called too frequently" if
   * it is called twice within three seconds, which is a sensible guard for a
   * realtime cache and useless here: an instructor editing groups fires several
   * writes in a row, and the second one would leave the dialog showing state
   * the database had already moved past. Querying directly after each write is
   * cheap -- a gradebook has tens of groups, not thousands -- and always right.
   */
  const [groupRows, setGroupRows] = useState<GradebookColumnGroup[]>([]);
  const [columnRows, setColumnRows] = useState<
    Pick<GradebookColumn, "id" | "name" | "slug" | "sort_order" | "group_id">[]
  >([]);

  const reload = useCallback(async () => {
    const [groupsRes, columnsRes] = await Promise.all([
      supabase
        .from("gradebook_column_groups")
        .select("*")
        .eq("gradebook_id", gradebookController.gradebook_id)
        .order("sort_order"),
      supabase
        .from("gradebook_columns")
        .select("id, name, slug, sort_order, group_id")
        .eq("gradebook_id", gradebookController.gradebook_id)
        .order("sort_order")
    ]);
    if (groupsRes.error) {
      toaster.error({ title: "Could not load column groups", description: groupsRes.error.message });
      return;
    }
    if (columnsRes.error) {
      toaster.error({ title: "Could not load columns", description: columnsRes.error.message });
      return;
    }
    setGroupRows(groupsRes.data ?? []);
    setColumnRows(columnsRes.data ?? []);
  }, [supabase, gradebookController]);

  useEffect(() => {
    if (isOpen) void reload();
  }, [isOpen, reload]);

  const orderedGroups = useMemo(() => [...groupRows].sort((a, b) => a.sort_order - b.sort_order), [groupRows]);

  const orderedColumns = useMemo(
    () => [...columnRows].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)),
    [columnRows]
  );

  const countsByGroup = useMemo(() => {
    const counts = new Map<number, number>();
    for (const col of columnRows) {
      if (col.group_id !== null) {
        counts.set(col.group_id, (counts.get(col.group_id) ?? 0) + 1);
      }
    }
    return counts;
  }, [columnRows]);

  /**
   * Run a mutation, then refetch. Both controllers, always: a reorder changes
   * gradebook_columns.sort_order as well as the groups' own order, and an
   * assignment changes group_id, so refetching only one of them leaves the
   * dialog showing a state the database is no longer in.
   */
  const mutate = useCallback(
    async (label: string, fn: () => Promise<{ error: { message: string } | null }>) => {
      setBusy(true);
      try {
        const { error } = await fn();
        if (error) {
          toaster.error({ title: label + " failed", description: error.message });
          return false;
        }
        await reload();
        // Best effort refresh of the gradebook behind this dialog. refetchAll()
        // throws when called more than once every three seconds, and a throttled
        // refresh is not a failed mutation -- the table catches up on its own.
        try {
          await Promise.all([
            gradebookController.gradebook_column_groups.refetchAll(),
            gradebookController.gradebook_columns.refetchAll()
          ]);
        } catch {
          /* throttled; ignore */
        }
        return true;
      } catch (e) {
        Sentry.captureException(e);
        toaster.error({ title: label + " failed", description: e instanceof Error ? e.message : String(e) });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [gradebookController, reload]
  );

  const createGroup = useCallback(async () => {
    const name = newName.trim();
    if (!name) return;
    const ok = await mutate("Creating the group", async () => {
      const { error } = await supabase.rpc("gradebook_column_group_create", {
        p_gradebook_id: gradebookController.gradebook_id,
        p_name: name
      });
      return { error };
    });
    if (ok) {
      setNewName("");
      toaster.success({ title: `Created "${name}"` });
    }
  }, [newName, mutate, supabase, gradebookController]);

  const renameGroup = useCallback(
    async (groupId: number, storedName: string) => {
      const draft = draftNames[groupId];
      setDraftNames((prev) => {
        const next = { ...prev };
        delete next[groupId];
        return next;
      });
      const name = (draft ?? "").trim();
      if (!name || name === storedName) return;
      await mutate("Renaming the group", async () => {
        const { error } = await supabase.rpc("gradebook_column_group_rename", {
          p_group_id: groupId,
          p_name: name
        });
        return { error };
      });
    },
    [draftNames, mutate, supabase]
  );

  const deleteGroup = useCallback(
    async (groupId: number, name: string) => {
      const n = countsByGroup.get(groupId) ?? 0;
      const warning =
        n === 0
          ? `Delete "${name}"?`
          : `Delete "${name}"? Its ${n} ${n === 1 ? "column" : "columns"} will become ungrouped. No column is deleted.`;
      if (!window.confirm(warning)) return;
      const ok = await mutate("Deleting the group", async () => {
        const { error } = await supabase.rpc("gradebook_column_group_delete", { p_group_id: groupId });
        return { error };
      });
      if (ok) toaster.success({ title: `Deleted "${name}"` });
    },
    [countsByGroup, mutate, supabase]
  );

  const moveGroup = useCallback(
    async (groupId: number, offset: number) => {
      await mutate("Reordering", async () => {
        const { error } = await supabase.rpc("gradebook_column_groups_move", {
          p_group_id: groupId,
          p_offset: offset
        });
        return { error };
      });
    },
    [mutate, supabase]
  );

  const assignColumn = useCallback(
    async (columnId: number, groupId: number | null) => {
      await mutate("Moving the column", async () => {
        const { error } = await supabase.rpc("gradebook_column_set_group", {
          p_column_id: columnId,
          // The generated Args type does not model nullable function parameters,
          // and NULL is how this RPC expresses "ungrouped".
          p_group_id: groupId as unknown as number
        });
        return { error };
      });
    },
    [mutate, supabase]
  );

  return (
    <Dialog.Root open={isOpen} size="lg" placement="center" lazyMount unmountOnExit>
      <Dialog.Trigger asChild>
        <Button variant="outline" size="sm" onClick={() => setIsOpen(true)}>
          <Icon as={LuLayers} mr={2} /> Manage Groups
        </Button>
      </Dialog.Trigger>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content maxH="85dvh" display="flex" flexDirection="column" overflow="hidden">
            <Dialog.Header>
              <Dialog.Title>Column groups</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body flex="1" minH="0" overflowY="auto">
              <VStack align="stretch" gap={5}>
                <Box>
                  <Text fontWeight="medium" mb={1}>
                    Groups
                  </Text>
                  <Text fontSize="sm" color="fg.muted" mb={3}>
                    Reordering moves a group&apos;s columns together and never changes which group a column is in.
                  </Text>
                  {orderedGroups.length === 0 ? (
                    <Text fontSize="sm" color="fg.muted">
                      This gradebook has no column groups yet.
                    </Text>
                  ) : (
                    <Table.Root size="sm">
                      <Table.Header>
                        <Table.Row>
                          <Table.ColumnHeader>Name</Table.ColumnHeader>
                          <Table.ColumnHeader width="90px">Columns</Table.ColumnHeader>
                          <Table.ColumnHeader width="130px">Order</Table.ColumnHeader>
                          <Table.ColumnHeader width="60px" />
                        </Table.Row>
                      </Table.Header>
                      <Table.Body>
                        {orderedGroups.map((group, idx) => (
                          <Table.Row key={group.id}>
                            <Table.Cell>
                              <Input
                                size="sm"
                                value={draftNames[group.id] ?? group.name}
                                disabled={busy}
                                aria-label={`Rename ${group.name}`}
                                onChange={(e) => setDraftNames((prev) => ({ ...prev, [group.id]: e.target.value }))}
                                onBlur={() => renameGroup(group.id, group.name)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    e.currentTarget.blur();
                                  } else if (e.key === "Escape") {
                                    setDraftNames((prev) => {
                                      const next = { ...prev };
                                      delete next[group.id];
                                      return next;
                                    });
                                  }
                                }}
                              />
                              <Text fontSize="xs" color="fg.muted" mt={1}>
                                {group.slug}
                              </Text>
                            </Table.Cell>
                            <Table.Cell>{countsByGroup.get(group.id) ?? 0}</Table.Cell>
                            <Table.Cell>
                              <HStack gap={1}>
                                <IconButton
                                  size="xs"
                                  variant="ghost"
                                  aria-label={`Move ${group.name} left`}
                                  disabled={busy || idx === 0}
                                  onClick={() => moveGroup(group.id, -1)}
                                >
                                  <Icon as={LuChevronLeft} />
                                </IconButton>
                                <IconButton
                                  size="xs"
                                  variant="ghost"
                                  aria-label={`Move ${group.name} right`}
                                  disabled={busy || idx === orderedGroups.length - 1}
                                  onClick={() => moveGroup(group.id, 1)}
                                >
                                  <Icon as={LuChevronRight} />
                                </IconButton>
                              </HStack>
                            </Table.Cell>
                            <Table.Cell>
                              <IconButton
                                size="xs"
                                variant="ghost"
                                colorPalette="red"
                                aria-label={`Delete ${group.name}`}
                                disabled={busy}
                                onClick={() => deleteGroup(group.id, group.name)}
                              >
                                <Icon as={LuTrash2} />
                              </IconButton>
                            </Table.Cell>
                          </Table.Row>
                        ))}
                      </Table.Body>
                    </Table.Root>
                  )}
                </Box>

                <Box>
                  <Text fontWeight="medium" mb={2}>
                    New group
                  </Text>
                  <HStack gap={2}>
                    <Input
                      size="sm"
                      placeholder="e.g. Participation"
                      value={newName}
                      disabled={busy}
                      aria-label="New group name"
                      onChange={(e) => setNewName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") createGroup();
                      }}
                    />
                    <Button
                      size="sm"
                      colorPalette="green"
                      variant="subtle"
                      disabled={busy || newName.trim() === ""}
                      onClick={createGroup}
                    >
                      Add group
                    </Button>
                  </HStack>
                </Box>

                <Separator />

                <Box>
                  <Text fontWeight="medium" mb={1}>
                    Columns
                  </Text>
                  <Text fontSize="sm" color="fg.muted" mb={3}>
                    A column with no group renders on its own. Moving a column between groups leaves it where it is in
                    the gradebook.
                  </Text>
                  <Table.Root size="sm">
                    <Table.Header>
                      <Table.Row>
                        <Table.ColumnHeader>Column</Table.ColumnHeader>
                        <Table.ColumnHeader width="220px">Group</Table.ColumnHeader>
                      </Table.Row>
                    </Table.Header>
                    <Table.Body>
                      {orderedColumns.map((col) => (
                        <Table.Row key={col.id}>
                          <Table.Cell>
                            {col.name}
                            <Text fontSize="xs" color="fg.muted">
                              {col.slug}
                            </Text>
                          </Table.Cell>
                          <Table.Cell>
                            <NativeSelect.Root size="sm" disabled={busy}>
                              <NativeSelect.Field
                                aria-label={`Group for ${col.name}`}
                                value={col.group_id === null ? "" : String(col.group_id)}
                                onChange={(e) =>
                                  assignColumn(col.id, e.target.value === "" ? null : Number(e.target.value))
                                }
                              >
                                <option value="">(ungrouped)</option>
                                {orderedGroups.map((group) => (
                                  <option key={group.id} value={String(group.id)}>
                                    {group.name}
                                  </option>
                                ))}
                              </NativeSelect.Field>
                            </NativeSelect.Root>
                          </Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table.Root>
                </Box>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="outline" size="sm" onClick={() => setIsOpen(false)}>
                Done
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
