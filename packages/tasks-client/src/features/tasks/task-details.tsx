import { Calendar, Check, Clock, LoaderCircle, Trash2, X } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useState } from "react";

import { Badge } from "@tasks/components/ui/badge";
import { Button } from "@tasks/components/ui/button";
import { Field, FieldLabel } from "@tasks/components/ui/field";
import { Input } from "@tasks/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@tasks/components/ui/select";
import { Textarea } from "@tasks/components/ui/textarea";
import { priorities, statuses } from "@tasks/features/tasks/task-form";
import type { Label, Project, Task, TaskUpdateInput } from "@tasks/lib/api";

interface TaskDetailsProps {
  readonly task: Task;
  readonly projects: ReadonlyArray<Project>;
  readonly labels: ReadonlyArray<Label>;
  readonly pending: boolean;
  readonly onClose: () => void;
  readonly onUpdate: (input: TaskUpdateInput) => void;
  readonly onDelete: () => void;
}

const formatTimestamp = (value: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );

export function TaskDetails({
  task,
  projects,
  labels,
  pending,
  onClose,
  onUpdate,
  onDelete,
}: TaskDetailsProps) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const reducedMotion = useReducedMotion();

  return (
    <motion.dialog
      open
      aria-modal="true"
      aria-labelledby="task-details-title"
      initial={
        reducedMotion ? { opacity: 0 } : { transform: "translateX(28px)", opacity: 0 }
      }
      animate={{ transform: "translateX(0px)", opacity: 1 }}
      exit={reducedMotion ? { opacity: 0 } : { transform: "translateX(20px)", opacity: 0 }}
      transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
      className="fixed inset-y-0 right-0 z-30 m-0 ml-auto flex w-full max-w-[520px] flex-col border-l bg-card shadow-[-24px_0_64px_rgba(0,0,0,.42)] sm:w-[min(520px,72vw)]"
    >
      <header className="flex h-12 shrink-0 items-center justify-between border-b px-4">
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="rounded-md font-mono text-[10px]">
            {task.identifier}
          </Badge>
          {pending ? (
            <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" aria-label="Delete task" onClick={onDelete}>
            <Trash2 />
          </Button>
          <Button variant="ghost" size="icon" aria-label="Close task details" onClick={onClose}>
            <X />
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-7">
        <h2 id="task-details-title" className="sr-only">
          Task details for {task.identifier}
        </h2>
        <Input
          className="h-auto border-0 bg-transparent px-0 text-xl font-semibold shadow-none focus-visible:ring-0 dark:bg-transparent"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => {
            const value = title.trim();
            if (value.length > 0 && value !== task.title) onUpdate({ title: value });
          }}
          aria-label="Task title"
        />

        <div className="mt-5 grid grid-cols-[100px_1fr] items-center gap-x-3 gap-y-3">
          <span className="text-xs text-muted-foreground">Status</span>
          <Select
            value={task.status}
            onValueChange={(value) => {
              const status = statuses.find((item) => item.value === value);
              if (status !== undefined) onUpdate({ status: status.value });
            }}
          >
            <SelectTrigger size="sm" className="w-full" aria-label="Task status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {statuses.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>

          <span className="text-xs text-muted-foreground">Priority</span>
          <Select
            value={task.priority}
            onValueChange={(value) => {
              const priority = priorities.find((item) => item.value === value);
              if (priority !== undefined) onUpdate({ priority: priority.value });
            }}
          >
            <SelectTrigger size="sm" className="w-full" aria-label="Task priority">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {priorities.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>

          <span className="text-xs text-muted-foreground">Project</span>
          <Select value={task.projectId} onValueChange={(value) => onUpdate({ projectId: value })}>
            <SelectTrigger size="sm" className="w-full" aria-label="Task project">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.key} · {project.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>

          <span className="text-xs text-muted-foreground">Due date</span>
          <Input
            aria-label="Task due date"
            type="date"
            value={task.dueDate ?? ""}
            onChange={(event) => onUpdate({ dueDate: event.target.value || null })}
          />
        </div>

        <Field className="mt-6 gap-2">
          <FieldLabel>Labels</FieldLabel>
          <div className="flex flex-wrap gap-2">
            {labels.map((label) => {
              const active = task.labels.some((item) => item.id === label.id);
              return (
                <Button
                  type="button"
                  key={label.id}
                  variant="outline"
                  size="sm"
                  aria-label={`Toggle ${label.name} label`}
                  aria-pressed={active}
                  onClick={() =>
                    onUpdate({
                      labelIds: active
                        ? task.labels.filter((item) => item.id !== label.id).map((item) => item.id)
                        : [...task.labels.map((item) => item.id), label.id],
                    })
                  }
                  className="h-7 px-2 text-xs aria-pressed:bg-accent"
                >
                  <span className="size-2 rounded-full" style={{ backgroundColor: label.color }} />
                  {label.name}
                  {active ? <Check /> : null}
                </Button>
              );
            })}
          </div>
        </Field>

        <Field className="mt-6 gap-2">
          <FieldLabel htmlFor="task-description">Description</FieldLabel>
          <Textarea
            id="task-description"
            aria-label="Task description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            onBlur={() => {
              const value = description.trim() || null;
              if (value !== task.description) onUpdate({ description: value });
            }}
            placeholder="Add a description…"
            className="min-h-44"
          />
        </Field>

        <div className="mt-8 border-t pt-4 text-xs text-muted-foreground">
          <p className="flex items-center gap-2">
            <Calendar className="size-3.5" />
            Created {formatTimestamp(task.createdAt)}
          </p>
          <p className="mt-2 flex items-center gap-2">
            <Clock className="size-3.5" />
            Updated {formatTimestamp(task.updatedAt)}
          </p>
          {task.completedAt === null ? null : (
            <p className="mt-2 flex items-center gap-2">
              <Check className="size-3.5" />
              Completed {formatTimestamp(task.completedAt)}
            </p>
          )}
        </div>
      </div>
    </motion.dialog>
  );
}
