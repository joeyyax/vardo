# UI Design Refresh Global Rollout Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:dispatching-parallel-agents to execute tasks in parallel.

**Goal:** Apply the UI design refresh (section containers, borderless rows, tight headers) to all remaining pages.

**Architecture:** Use shared `ListRow` and `ListContainer` components from `@/components/ui/list-row`. Replace Card-wrapped lists with the new pattern. Tighten page headers.

**Tech Stack:** Next.js, Tailwind CSS, shadcn/ui

---

## Completed (Don't Touch)

1. ✅ `components/ui/card.tsx` - Reduced padding/shadow
2. ✅ `components/ui/button.tsx` - Normalized sizing
3. ✅ `components/ui/list-row.tsx` - New shared component
4. ✅ `app/(app)/expenses/expenses-content.tsx` - Uses ListRow/ListContainer
5. ✅ `app/(app)/expenses/page.tsx` - Tightened header
6. ✅ `app/(app)/contracts/contracts-content.tsx` - Uses ListRow/ListContainer

---

## Remaining Tasks (Execute in Parallel)

### Task A: Proposals Content

**Files:**
- Modify: `app/(app)/proposals/proposals-content.tsx`

**Changes:**
1. Remove `Card` and `CardContent` imports
2. Add import: `import { ListRow, ListContainer } from "@/components/ui/list-row";`
3. Replace empty state Card with plain div (same pattern as Expenses)
4. Replace Card-wrapped list items with `ListContainer` + `ListRow` pattern
5. Add `opacity-0 group-hover:opacity-100` to action buttons
6. Change middot separators to `text-muted-foreground/50`

**Verification:** `pnpm typecheck` passes

---

### Task B: Proposals Page Header

**Files:**
- Modify: `app/(app)/proposals/page.tsx`

**Changes:**
1. Replace header section:
   ```tsx
   <div className="mb-8">
     <h1 className="text-xl font-semibold tracking-tight">Proposals</h1>
   </div>
   ```

**Verification:** `pnpm typecheck` passes

---

### Task C: Projects Content

**Files:**
- Modify: `app/(app)/projects/projects-content.tsx`

**Changes:**
1. Add import: `import { ListRow, ListContainer } from "@/components/ui/list-row";`
2. Replace the styled div list items (lines ~348-444) with `ListContainer` + `ListRow`
3. Keep drag-and-drop functionality but use ListRow as the wrapper
4. Add `opacity-0 group-hover:opacity-100` to edit buttons

**Verification:** `pnpm typecheck` passes

---

### Task D: Projects Page Header

**Files:**
- Modify: `app/(app)/projects/page.tsx`

**Changes:**
1. Replace header section with tight version (mb-8, text-xl)

**Verification:** `pnpm typecheck` passes

---

### Task E: Clients Content

**Files:**
- Modify: `app/(app)/clients/clients-content.tsx`

**Changes:**
1. Add import: `import { ListRow, ListContainer } from "@/components/ui/list-row";`
2. For list view: Replace card-like divs with `ListContainer` + `ListRow`
3. Keep drag-and-drop functionality
4. For table view: Remove the outer `rounded-lg border squircle overflow-hidden` wrapper
5. Add `opacity-0 group-hover:opacity-100` to action buttons

**Verification:** `pnpm typecheck` passes

---

### Task F: Clients Page Header

**Files:**
- Modify: `app/(app)/clients/page.tsx`

**Changes:**
1. Replace header section with tight version (mb-8, text-xl)

**Verification:** `pnpm typecheck` passes

---

### Task G: Invoices Page Header

**Files:**
- Modify: `app/(app)/invoices/page.tsx`

**Changes:**
1. Replace header section with tight version (mb-8, text-xl)

**Verification:** `pnpm typecheck` passes

---

### Task H: Contracts Page Header

**Files:**
- Modify: `app/(app)/contracts/page.tsx`

**Changes:**
1. Replace header section with tight version (mb-8, text-xl)

**Verification:** `pnpm typecheck` passes

---

## Reference Pattern

See `app/(app)/expenses/expenses-content.tsx` for the canonical implementation:

```tsx
import { ListRow, ListContainer } from "@/components/ui/list-row";

// Empty state (no Card)
<div className="py-12 text-center">...</div>

// List with items
<ListContainer>
  {items.map((item, index) => {
    const isLast = index === items.length - 1;
    return (
      <ListRow
        key={item.id}
        onClick={() => handleClick(item)}
        isLast={isLast}
      >
        {/* Content */}
        <Button
          variant="ghost"
          size="icon"
          className="opacity-0 group-hover:opacity-100 transition-opacity"
        >
          ...
        </Button>
      </ListRow>
    );
  })}
</ListContainer>
```

---

## Final Verification

After all tasks complete:
- [ ] All page headers use `mb-8` + `text-xl` pattern
- [ ] No Card imports remain in list views (except where genuinely needed)
- [ ] All list items use `ListRow` + `ListContainer`
- [ ] Action buttons use `opacity-0 group-hover:opacity-100`
- [ ] `pnpm typecheck` passes for entire project
