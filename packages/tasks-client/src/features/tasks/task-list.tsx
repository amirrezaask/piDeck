import {
  AlertCircle,
  Ban,
  CheckCircle2,
  Circle,
  CircleDot,
  Flag,
  Inbox,
  LoaderCircle,
  RotateCcw,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

import { Badge } from "@tasks/components/ui/badge";
import { Button } from "@tasks/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@tasks/components/ui/empty";
import { Skeleton } from "@tasks/components/ui/skeleton";
import type { Task, TaskPriority, TaskStatus } from "@tasks/lib/api";
import { cn } from "@tasks/lib/utils";

const statusIcon = {
  backlog: Circle,
  todo: CircleDot,
  in_progress: LoaderCircle,
  done: CheckCircle2,
  canceled: Ban,
} satisfies Record<TaskStatus, typeof Circle>;
const statusLabel: Record<TaskStatus, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In progress",
  done: "Done",
  canceled: "Canceled",
};
const priorityLabel: Record<TaskPriority, string> = {
  no_priority: "None",
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
};
const groups: ReadonlyArray<TaskStatus> = ["in_progress", "todo", "backlog", "done", "canceled"];

function TaskRow({ task, onOpen }: { readonly task: Task; readonly onOpen: (task: Task) => void }) {
  const Icon = statusIcon[task.status];
  const overdue =
    task.dueDate !== null &&
    task.status !== "done" &&
    task.status !== "canceled" &&
    task.dueDate < new Date().toISOString().slice(0, 10);
  return (
    <motion.button
      layout="position"
      initial={{ opacity: 0, transform: "translateY(-4px)" }}
      animate={{ opacity: 1, transform: "translateY(0px)" }}
      exit={{ opacity: 0, transform: "translateY(-3px)" }}
      transition={{ duration: 0.14, ease: [0.23, 1, 0.32, 1] }}
      type="button"
      onClick={() => onOpen(task)}
      className="grid min-h-10 w-full grid-cols-[74px_minmax(180px,1fr)_100px_90px_140px] items-center gap-3 border-b px-4 text-left text-xs transition-colors [content-visibility:auto] hover:bg-accent/55 focus-visible:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring max-lg:grid-cols-[70px_minmax(160px,1fr)_90px] max-lg:[&>*:nth-child(4)]:hidden max-lg:[&>*:nth-child(5)]:hidden"
    >
      <span className="font-mono text-[11px] text-muted-foreground">{task.identifier}</span>
      <span className="flex min-w-0 items-center gap-2">
        <Icon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground",
            task.status === "in_progress" && "text-sky-400",
          )}
        />
        <span
          className={cn(
            "truncate text-[13px]",
            (task.status === "done" || task.status === "canceled") &&
              "text-muted-foreground line-through",
          )}
        >
          {task.title}
        </span>
      </span>
      <span className="flex items-center gap-1 text-muted-foreground">
        <Flag
          className={cn(
            "size-3",
            task.priority === "urgent" && "fill-red-400 text-red-400",
            task.priority === "high" && "text-orange-400",
          )}
        />
        {priorityLabel[task.priority]}
      </span>
      <span className="truncate text-muted-foreground" title={task.project.name}>
        <span
          className="mr-1.5 inline-block size-2 rounded-sm"
          style={{ backgroundColor: task.project.color }}
        />
        {task.project.key}
      </span>
      <span className="flex min-w-0 items-center justify-end gap-1.5">
        {task.labels.slice(0, 2).map((label) => (
          <Badge key={label.id} variant="secondary" className="rounded-md">
            <span className="size-1.5 rounded-full" style={{ backgroundColor: label.color }} />
            {label.name}
          </Badge>
        ))}
        {task.dueDate === null ? null : (
          <span
            className={cn(
              "ml-auto tabular-nums text-muted-foreground",
              overdue && "text-destructive",
            )}
          >
            {task.dueDate.slice(5)}
          </span>
        )}
      </span>
    </motion.button>
  );
}

function Rows({
  tasks,
  onOpen,
}: {
  readonly tasks: ReadonlyArray<Task>;
  readonly onOpen: (task: Task) => void;
}) {
  return (
    <AnimatePresence initial={false}>
      {tasks.map((task) => (
        <TaskRow key={task.id} task={task} onOpen={onOpen} />
      ))}
    </AnimatePresence>
  );
}

export function TaskList({
  state,
  grouped,
  onRetry,
  onOpen,
}: {
  readonly state:
    | { readonly _tag: "loading" }
    | { readonly _tag: "error"; readonly message: string }
    | { readonly _tag: "success"; readonly tasks: ReadonlyArray<Task> };
  readonly grouped: boolean;
  readonly onRetry: () => void;
  readonly onOpen: (task: Task) => void;
}) {
  if (state._tag === "loading")
    return (
      <div className="flex flex-col" aria-label="Loading tasks">
        {Array.from({ length: 8 }, (_, index) => (
          <Skeleton key={index} className="h-10 rounded-none border-b bg-muted/20" />
        ))}
      </div>
    );
  if (state._tag === "error")
    return (
      <Empty role="alert" className="min-h-80">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <AlertCircle className="text-destructive" />
          </EmptyMedia>
          <EmptyTitle>Tasks couldn’t be loaded</EmptyTitle>
          <EmptyDescription>{state.message}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RotateCcw data-icon="inline-start" />
            Try again
          </Button>
        </EmptyContent>
      </Empty>
    );
  if (state.tasks.length === 0)
    return (
      <Empty className="min-h-80">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Inbox />
          </EmptyMedia>
          <EmptyTitle>No tasks in this view</EmptyTitle>
          <EmptyDescription>Adjust the filters or create a task to get started.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  if (!grouped) return <Rows tasks={state.tasks} onOpen={onOpen} />;
  return (
    <div>
      {groups.map((status) => {
        const tasks = state.tasks.filter((task) => task.status === status);
        return tasks.length === 0 ? null : (
          <section key={status}>
            <header className="sticky top-0 z-10 flex h-8 items-center gap-2 border-b bg-card/95 px-4 text-[11px] font-medium text-muted-foreground backdrop-blur">
              <span>{statusLabel[status]}</span>
              <span className="tabular-nums">{tasks.length}</span>
            </header>
            <Rows tasks={tasks} onOpen={onOpen} />
          </section>
        );
      })}
    </div>
  );
}
