import {
  CalendarDays,
  Check,
  CircleDot,
  Flag,
  FolderKanban,
  LoaderCircle,
  Tag,
  X,
  type LucideIcon,
} from "lucide-react";
import { useState, type FormEvent, type KeyboardEvent } from "react";

import { Button } from "@tasks/components/ui/button";
import { Input, Textarea } from "@tasks/components/ui/form-controls";
import type { Label, Project, TaskCreateInput, TaskPriority, TaskStatus } from "@tasks/lib/api";
import { cn } from "@tasks/lib/utils";

export const statuses: ReadonlyArray<{ readonly value: TaskStatus; readonly label: string }> = [
  { value: "backlog", label: "Backlog" },
  { value: "todo", label: "Todo" },
  { value: "in_progress", label: "In progress" },
  { value: "done", label: "Done" },
  { value: "canceled", label: "Canceled" },
];
export const priorities: ReadonlyArray<{ readonly value: TaskPriority; readonly label: string }> = [
  { value: "no_priority", label: "No priority" },
  { value: "urgent", label: "Urgent" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

type MetadataCommand = "project" | "due" | "priority" | "status" | "label";

const commands: ReadonlyArray<{
  readonly value: MetadataCommand;
  readonly label: string;
  readonly description: string;
  readonly icon: LucideIcon;
}> = [
  {
    value: "project",
    label: "Project",
    description: "Move this task to a project",
    icon: FolderKanban,
  },
  { value: "due", label: "Due date", description: "Add a deadline", icon: CalendarDays },
  { value: "priority", label: "Priority", description: "Set task importance", icon: Flag },
  { value: "status", label: "Status", description: "Choose where work starts", icon: CircleDot },
  { value: "label", label: "Label", description: "Add a label", icon: Tag },
];

interface TaskFormProps {
  readonly projects: ReadonlyArray<Project>;
  readonly labels: ReadonlyArray<Label>;
  readonly initialProjectId?: string | undefined;
  readonly submitLabel: string;
  readonly pending: boolean;
  readonly onSubmit: (input: TaskCreateInput) => void;
}

function valueLabel<T extends string>(
  options: ReadonlyArray<{ readonly value: T; readonly label: string }>,
  value: T,
) {
  return options.find((option) => option.value === value)?.label ?? value;
}

function formatDueDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
    new Date(`${value}T00:00:00`),
  );
}

function MetadataChip({
  icon: Icon,
  children,
  onClick,
  onRemove,
}: {
  readonly icon: LucideIcon;
  readonly children: string;
  readonly onClick: () => void;
  readonly onRemove?: (() => void) | undefined;
}) {
  return (
    <span className="inline-flex h-6 items-center rounded-md border bg-background text-[11px] text-muted-foreground">
      <button
        type="button"
        className="inline-flex h-full items-center gap-1.5 rounded-l-md px-2 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        onClick={onClick}
      >
        <Icon className="size-3" aria-hidden="true" />
        {children}
      </button>
      {onRemove === undefined ? null : (
        <button
          type="button"
          className="grid h-full w-6 place-items-center rounded-r-md border-l outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          onClick={onRemove}
          aria-label={`Remove ${children}`}
        >
          <X className="size-3" aria-hidden="true" />
        </button>
      )}
    </span>
  );
}

export function TaskForm({
  projects,
  labels,
  initialProjectId,
  submitLabel,
  pending,
  onSubmit,
}: TaskFormProps) {
  const [composer, setComposer] = useState("");
  const [error, setError] = useState<string>();
  const [projectId, setProjectId] = useState<string | undefined>(initialProjectId);
  const [status, setStatus] = useState<TaskStatus>("backlog");
  const [priority, setPriority] = useState<TaskPriority>("no_priority");
  const [dueDate, setDueDate] = useState("");
  const [selectedLabels, setSelectedLabels] = useState<ReadonlyArray<string>>([]);
  const [activeCommand, setActiveCommand] = useState<MetadataCommand>();

  const selectedProjectId = projectId ?? initialProjectId ?? projects[0]?.id;
  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const slashMatch = composer.match(/(?:^|\s)\/([a-z]*)$/i);
  const slashQuery = slashMatch?.[1]?.toLowerCase();
  const matchingCommands =
    slashQuery === undefined
      ? []
      : commands.filter((command) => command.value.startsWith(slashQuery));

  const openCommand = (command: MetadataCommand) => {
    setComposer((current) => current.replace(/\/[a-z]*$/i, ""));
    setActiveCommand(command);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanComposer = composer.trim();
    const [firstLine = "", ...descriptionLines] = cleanComposer.split("\n");
    const title = firstLine.trim();
    if (title.length === 0) {
      setError("Enter a task title.");
      return;
    }
    if (selectedProjectId === undefined) {
      setError("Add a project with /project.");
      return;
    }
    setError(undefined);
    onSubmit({
      title,
      projectId: selectedProjectId,
      description: descriptionLines.join("\n").trim() || null,
      status,
      priority,
      dueDate: dueDate || null,
      labelIds: selectedLabels,
    });
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape" && slashQuery !== undefined) {
      event.preventDefault();
      setComposer((current) => current.replace(/\/[a-z]*$/i, ""));
      return;
    }
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    const firstCommand = matchingCommands[0];
    if (firstCommand !== undefined) {
      openCommand(firstCommand.value);
      return;
    }
    event.currentTarget.form?.requestSubmit();
  };

  const renderPicker = () => {
    if (activeCommand === "due") {
      return (
        <div className="flex items-center gap-2 p-2">
          <Input
            aria-label="Task due date"
            type="date"
            value={dueDate}
            onChange={(event) => setDueDate(event.target.value)}
          />
          <Button type="button" size="sm" onClick={() => setActiveCommand(undefined)}>
            Attach
          </Button>
        </div>
      );
    }

    const options =
      activeCommand === "project"
        ? projects.map((project) => ({
            value: project.id,
            label: `${project.key} · ${project.name}`,
          }))
        : activeCommand === "priority"
          ? priorities
          : activeCommand === "status"
            ? statuses
            : activeCommand === "label"
              ? labels.map((label) => ({ value: label.id, label: label.name }))
              : [];

    if (activeCommand === undefined) return null;
    if (options.length === 0) {
      return <p className="p-3 text-xs text-muted-foreground">No options available.</p>;
    }

    return (
      <div
        className="max-h-48 overflow-y-auto p-1"
        role="menu"
        aria-label={`Choose ${activeCommand}`}
      >
        {options.map((option) => {
          const isSelected =
            activeCommand === "project"
              ? selectedProjectId === option.value
              : activeCommand === "priority"
                ? priority === option.value
                : activeCommand === "status"
                  ? status === option.value
                  : selectedLabels.includes(option.value);
          return (
            <button
              key={option.value}
              type="button"
              role={activeCommand === "label" ? "menuitemcheckbox" : "menuitemradio"}
              aria-checked={isSelected}
              className="flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-xs outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
              onClick={() => {
                if (activeCommand === "project") setProjectId(option.value);
                if (activeCommand === "priority") {
                  const nextPriority = priorities.find((item) => item.value === option.value);
                  if (nextPriority !== undefined) setPriority(nextPriority.value);
                }
                if (activeCommand === "status") {
                  const nextStatus = statuses.find((item) => item.value === option.value);
                  if (nextStatus !== undefined) setStatus(nextStatus.value);
                }
                if (activeCommand === "label") {
                  setSelectedLabels((current) =>
                    current.includes(option.value)
                      ? current.filter((id) => id !== option.value)
                      : [...current, option.value],
                  );
                  return;
                }
                setActiveCommand(undefined);
              }}
            >
              <span>{option.label}</span>
              {isSelected ? <Check className="size-3.5 text-primary" aria-hidden="true" /> : null}
            </button>
          );
        })}
      </div>
    );
  };

  return (
    <form className="mt-4" onSubmit={handleSubmit} noValidate>
      <div
        className={cn(
          "overflow-hidden rounded-lg border bg-card focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20",
          error !== undefined && "border-destructive",
        )}
      >
        <Textarea
          aria-label="Task"
          aria-invalid={error !== undefined}
          value={composer}
          onChange={(event) => {
            setComposer(event.target.value);
            if (error !== undefined) setError(undefined);
          }}
          onKeyDown={handleComposerKeyDown}
          placeholder="What needs doing? Type / for details"
          className="min-h-24 resize-none rounded-none border-0 bg-transparent px-3.5 py-3 text-[15px] leading-6 focus:ring-0"
        />

        {slashQuery === undefined ? null : (
          <div className="border-t p-1" role="menu" aria-label="Task metadata commands">
            {matchingCommands.length === 0 ? (
              <p className="px-2.5 py-2 text-xs text-muted-foreground">No matching command</p>
            ) : (
              matchingCommands.map((command) => {
                const Icon = command.icon;
                return (
                  <button
                    key={command.value}
                    type="button"
                    role="menuitem"
                    className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
                    onClick={() => openCommand(command.value)}
                  >
                    <Icon className="size-3.5 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs font-medium">/{command.value}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {command.description}
                      </span>
                    </span>
                  </button>
                );
              })
            )}
          </div>
        )}

        {activeCommand === undefined ? null : (
          <div className="border-t bg-background/40">
            <div className="flex h-8 items-center justify-between border-b px-2.5">
              <span className="text-[11px] font-medium text-muted-foreground">
                /{activeCommand}
              </span>
              <button
                type="button"
                className="rounded-sm p-1 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                onClick={() => setActiveCommand(undefined)}
                aria-label={`Close ${activeCommand} options`}
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            </div>
            {renderPicker()}
          </div>
        )}

        <div className="flex min-h-11 items-end justify-between gap-3 border-t px-2.5 py-2">
          <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
            <MetadataChip icon={FolderKanban} onClick={() => setActiveCommand("project")}>
              {selectedProject === undefined ? "Add project" : selectedProject.name}
            </MetadataChip>
            <MetadataChip icon={CircleDot} onClick={() => setActiveCommand("status")}>
              {valueLabel(statuses, status)}
            </MetadataChip>
            <MetadataChip icon={Flag} onClick={() => setActiveCommand("priority")}>
              {valueLabel(priorities, priority)}
            </MetadataChip>
            {dueDate.length === 0 ? null : (
              <MetadataChip
                icon={CalendarDays}
                onClick={() => setActiveCommand("due")}
                onRemove={() => setDueDate("")}
              >
                {formatDueDate(dueDate)}
              </MetadataChip>
            )}
            {selectedLabels.map((id) => {
              const label = labels.find((item) => item.id === id);
              if (label === undefined) return null;
              return (
                <MetadataChip
                  key={id}
                  icon={Tag}
                  onClick={() => setActiveCommand("label")}
                  onRemove={() =>
                    setSelectedLabels((current) => current.filter((value) => value !== id))
                  }
                >
                  {label.name}
                </MetadataChip>
              );
            })}
          </div>
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : null}
            {submitLabel}
          </Button>
        </div>
      </div>
      <div className="mt-2 flex min-h-4 items-center justify-between gap-3 px-1 text-[11px] text-muted-foreground">
        <span
          className={cn(error !== undefined && "text-destructive")}
          role={error === undefined ? undefined : "alert"}
        >
          {error ?? "Enter to create · Shift Enter for a new line"}
        </span>
        <span className="shrink-0">/ adds metadata</span>
      </div>
    </form>
  );
}
