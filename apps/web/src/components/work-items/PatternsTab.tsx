// FD-20 — Patterns placeholder. The design pass hasn't happened yet; this
// coming-soon panel stakes out the surface and explains the locked shape
// ("a template that spawns a fully-loaded work item") in plain English.
// Replace this component with the real Patterns surface when FD-20 builds.

export function PatternsTab() {
  return (
    <div className="grid h-full place-items-center overflow-y-auto bg-background px-6 py-10">
      <div className="max-w-lg">
        <div className="mb-1 flex items-center gap-2">
          <h2 className="text-lg font-semibold text-foreground">Patterns</h2>
          <span className="bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
            Coming soon
          </span>
        </div>

        <p className="mb-4 text-sm text-muted-foreground">
          Saved recipes for work that keeps coming back.
        </p>

        <div className="space-y-3 text-sm leading-relaxed text-foreground/80">
          <p>
            A <span className="font-medium text-foreground">Pattern</span> is a reusable
            package — the instructions, the context, and (when one fits) a workflow —
            that creates a fresh, fully-loaded work item every time you invoke it.
          </p>
          <p>
            The dividing line: <span className="font-medium text-foreground">work items
            complete; Patterns persist</span>. A work item is one occurrence of the work,
            with an ending. A Pattern is the standing recipe for the next occurrence.
          </p>
          <p>
            You&rsquo;ll also be able to <span className="font-medium text-foreground">promote
            a finished work item into a Pattern</span> — work that went well once becomes
            the starting point every time after.
          </p>
        </div>

        <div className="mt-5 border-l-2 border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          Nothing new to learn under the hood: a Pattern just spawns the card (and wires
          its workflow, if it has one). Workflows stay the only way work executes.
        </div>
      </div>
    </div>
  );
}
