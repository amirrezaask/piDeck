/*
THESIS: Dispatch is a workbench, not a dashboard; the task ledger is the primary surface.
OWN-WORLD: graphite layers, cool violet signal color, hairline separators, compact square controls.
STORY: orient by view, narrow the ledger, open one durable task, change its state without losing place.
FIRST VIEWPORT: fixed 228px navigation, one restrained toolbar, full-height task ledger, optional right inspector.
FORM: desktop issue ledger, pinned by the product brief. FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.
*/
import { Effect } from "effect";
import { AnimatePresence, MotionConfig } from "motion/react";
import {
  Archive,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  Hash,
  Layers3,
  Menu,
  Plus,
  Search,
  SlidersHorizontal,
  Tag,
  Trash2,
} from "lucide-react";
import {
  useDeferredValue,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { toast, Toaster } from "sonner";

import { Button } from "@tasks/components/ui/button";
import { Dialog, Field, Input, Select, Textarea } from "@tasks/components/ui/form-controls";
import { TaskDetails } from "@tasks/features/tasks/task-details";
import { TaskForm, priorities, statuses } from "@tasks/features/tasks/task-form";
import { TaskList } from "@tasks/features/tasks/task-list";
import {
  ApiClient,
  type ApiError,
  type Label,
  type Project,
  type Task,
  type TaskQuery,
  type TaskStatus,
} from "@tasks/lib/api";
import { runMutation, useEffectQuery } from "@tasks/lib/effect";
import { cn } from "@tasks/lib/utils";

function isTypingTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.matches("input, textarea, select") || target.isContentEditable)
  );
}

function Workspace() {
  const location = useLocation();
  const navigate = useNavigate();
  const parameters = useParams();
  const [searchParameters, setSearchParameters] = useSearchParams();
  const searchRef = useRef<HTMLInputElement>(null);
  const [createTaskOpen, setCreateTaskOpen] = useState(false);
  const [projectDialog, setProjectDialog] = useState<
    { readonly mode: "create" } | { readonly mode: "edit"; readonly project: Project }
  >();
  const [labelDialog, setLabelDialog] = useState<
    { readonly mode: "create" } | { readonly mode: "edit"; readonly label: Label }
  >();
  const [pending, setPending] = useState(false);
  const deferredSearch = useDeferredValue(searchParameters.get("search") ?? "");
  const taskId =
    location.pathname.startsWith("/tasks/") &&
    !location.pathname.startsWith("/tasks/projects/") &&
    !["/tasks/backlog", "/tasks/active", "/tasks/completed"].includes(location.pathname)
      ? location.pathname.slice(7)
      : undefined;
  const projectId = location.pathname.startsWith("/tasks/projects/")
    ? parameters.projectId
    : undefined;

  const projectsQuery = useEffectQuery(
    () => Effect.flatMap(ApiClient, (api) => api.projects.list),
    "projects",
  );
  const labelsQuery = useEffectQuery(
    () => Effect.flatMap(ApiClient, (api) => api.labels.list),
    "labels",
  );
  const projects = projectsQuery.state._tag === "success" ? projectsQuery.state.data : [];
  const labels = labelsQuery.state._tag === "success" ? labelsQuery.state.data : [];

  const viewStatuses: ReadonlyArray<TaskStatus> =
    location.pathname === "/tasks/backlog"
      ? ["backlog"]
      : location.pathname === "/tasks/active"
        ? ["todo", "in_progress"]
        : location.pathname === "/tasks/completed"
          ? ["done", "canceled"]
          : [];
  const statusFilter = searchParameters.get("status");
  const priorityFilter = searchParameters.get("priority");
  const labelFilters = searchParameters.getAll("label");
  const selectedStatus = statuses.find((item) => item.value === statusFilter)?.value;
  const selectedPriority = priorities.find((item) => item.value === priorityFilter)?.value;
  const requestedSort = searchParameters.get("sort");
  const sort =
    requestedSort === "created" || requestedSort === "priority" ? requestedSort : "updated";
  const order = searchParameters.get("order") === "asc" ? "asc" : "desc";
  const taskQuery: TaskQuery = {
    ...(projectId === undefined ? {} : { projectId }),
    status: selectedStatus === undefined ? viewStatuses : [selectedStatus],
    priority: selectedPriority === undefined ? [] : [selectedPriority],
    labelId: labelFilters,
    search: deferredSearch,
    sort,
    order,
  };
  const taskQueryKey = JSON.stringify(taskQuery);
  const tasksQuery = useEffectQuery(
    () => Effect.flatMap(ApiClient, (api) => api.tasks.list(taskQuery)),
    taskQueryKey,
  );
  const detailQuery = useEffectQuery(
    () =>
      Effect.flatMap(ApiClient, (api) =>
        taskId === undefined ? Effect.succeed(null) : api.tasks.get(taskId),
      ),
    taskId ?? "no-task",
  );
  const selectedTask = detailQuery.state._tag === "success" ? detailQuery.state.data : null;

  const updateParameter = (name: string, value?: string, multiple = false) => {
    setSearchParameters(
      (current) => {
        const next = new URLSearchParams(current);
        if (!multiple) next.delete(name);
        if (value !== undefined && value.length > 0) {
          if (multiple) next.append(name, value);
          else next.set(name, value);
        }
        return next;
      },
      { replace: true },
    );
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      if (event.key === "c") {
        event.preventDefault();
        setCreateTaskOpen(true);
      }
      if (event.key === "/") {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === "Escape" && taskId !== undefined) navigate("/tasks");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate, taskId]);

  const mutation = <A,>(
    effect: Effect.Effect<A, ApiError, ApiClient>,
    onSuccess: (value: A) => void,
  ) => {
    setPending(true);
    runMutation(effect, {
      onError: (error) => {
        setPending(false);
        toast.error(error.message);
      },
      onSuccess: (value) => {
        setPending(false);
        onSuccess(value);
      },
    });
  };
  const refreshTasks = () => {
    tasksQuery.refresh();
    detailQuery.refresh();
  };
  const openTask = (task: Task) =>
    navigate(`/tasks/${task.id}`, { state: { from: `${location.pathname}${location.search}` } });
  const closeTask = () => {
    const state = location.state;
    const from =
      typeof state === "object" &&
      state !== null &&
      "from" in state &&
      typeof state.from === "string"
        ? state.from
        : "/tasks";
    navigate(from);
  };
  const viewTitle =
    projectId === undefined
      ? location.pathname === "/tasks/backlog"
        ? "Backlog"
        : location.pathname === "/tasks/active"
          ? "Active"
          : location.pathname === "/tasks/completed"
            ? "Completed"
            : "All tasks"
      : (projects.find((project) => project.id === projectId)?.name ?? "Project");

  return (
    <div className="flex h-svh min-w-0 overflow-hidden bg-background text-foreground">
      <Sidebar
        projects={projects}
        labels={labels}
        activePath={location.pathname}
        labelFilters={labelFilters}
        onNavigate={navigate}
        onNewProject={() => setProjectDialog({ mode: "create" })}
        onEditProject={(project) => setProjectDialog({ mode: "edit", project })}
        onNewLabel={() => setLabelDialog({ mode: "create" })}
        onEditLabel={(label) => setLabelDialog({ mode: "edit", label })}
        onToggleLabel={(id) => {
          const next = labelFilters.includes(id)
            ? labelFilters.filter((value) => value !== id)
            : [...labelFilters, id];
          setSearchParameters((current) => {
            const copy = new URLSearchParams(current);
            copy.delete("label");
            for (const value of next) copy.append("label", value);
            return copy;
          });
        }}
      />
      <main className="flex min-w-0 flex-1 flex-col bg-card">
        <header className="flex h-12 shrink-0 items-center justify-between border-b px-4">
          <div className="flex min-w-0 items-center gap-2">
            <Menu className="size-4 text-muted-foreground lg:hidden" />
            <h1 className="truncate text-sm font-semibold">{viewTitle}</h1>
            {tasksQuery.state._tag === "success" ? (
              <span className="text-xs tabular-nums text-muted-foreground">
                {tasksQuery.state.data.length}
              </span>
            ) : null}
          </div>
          <Button size="sm" onClick={() => setCreateTaskOpen(true)}>
            <Plus data-icon="inline-start" />
            New task <kbd className="ml-1 text-[10px] opacity-60">C</kbd>
          </Button>
        </header>
        <div className="flex min-h-11 shrink-0 items-center gap-2 overflow-x-auto border-b px-3">
          <div className="relative min-w-52 max-w-sm flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchRef}
              aria-label="Search tasks"
              value={searchParameters.get("search") ?? ""}
              onChange={(event) => updateParameter("search", event.target.value)}
              placeholder="Search tasks…"
              className="pl-8 pr-8"
            />
            <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">
              /
            </kbd>
          </div>
          <SlidersHorizontal className="size-3.5 text-muted-foreground" />
          <Select
            aria-label="Filter by status"
            value={statusFilter ?? ""}
            onChange={(event) => updateParameter("status", event.target.value)}
            className="w-32"
          >
            <option value="">Any status</option>
            {statuses.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Filter by priority"
            value={priorityFilter ?? ""}
            onChange={(event) => updateParameter("priority", event.target.value)}
            className="w-32"
          >
            <option value="">Any priority</option>
            {priorities.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Sort tasks"
            value={searchParameters.get("sort") ?? "updated"}
            onChange={(event) => updateParameter("sort", event.target.value)}
            className="w-32"
          >
            <option value="updated">Last updated</option>
            <option value="created">Created</option>
            <option value="priority">Priority</option>
          </Select>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              updateParameter(
                "group",
                searchParameters.get("group") === "status" ? undefined : "status",
              )
            }
            aria-pressed={searchParameters.get("group") === "status"}
          >
            Group <ChevronDown data-icon="inline-end" />
          </Button>
        </div>
        {labels.length === 0 ? null : (
          <div className="flex min-h-9 shrink-0 items-center gap-1.5 overflow-x-auto border-b px-4">
            {labels.map((label) => (
              <button
                key={label.id}
                type="button"
                onClick={() =>
                  labelFilters.includes(label.id)
                    ? setSearchParameters((current) => {
                        const next = new URLSearchParams(current);
                        next.delete("label");
                        for (const id of labelFilters.filter((value) => value !== label.id))
                          next.append("label", id);
                        return next;
                      })
                    : updateParameter("label", label.id, true)
                }
                aria-pressed={labelFilters.includes(label.id)}
                className={cn(
                  "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11px] text-muted-foreground hover:bg-accent",
                  labelFilters.includes(label.id) && "bg-accent text-foreground",
                )}
              >
                <span className="size-1.5 rounded-full" style={{ backgroundColor: label.color }} />
                {label.name}
              </button>
            ))}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <TaskList
            grouped={searchParameters.get("group") === "status"}
            state={
              tasksQuery.state._tag === "loading"
                ? { _tag: "loading" }
                : tasksQuery.state._tag === "error"
                  ? { _tag: "error", message: tasksQuery.state.error.message }
                  : { _tag: "success", tasks: tasksQuery.state.data }
            }
            onRetry={tasksQuery.refresh}
            onOpen={openTask}
          />
        </div>
      </main>
      <AnimatePresence>
        {taskId !== undefined && selectedTask !== null ? (
          <TaskDetails
            key={selectedTask.id}
            task={selectedTask}
            projects={projects}
            labels={labels}
            pending={pending}
            onClose={closeTask}
            onUpdate={(input) =>
              mutation(
                Effect.flatMap(ApiClient, (api) => api.tasks.update(selectedTask.id, input)),
                () => {
                  refreshTasks();
                  toast.success("Task updated");
                },
              )
            }
            onDelete={() => {
              if (window.confirm(`Delete ${selectedTask.identifier}?`))
                mutation(
                  Effect.flatMap(ApiClient, (api) => api.tasks.remove(selectedTask.id)),
                  () => {
                    tasksQuery.refresh();
                    closeTask();
                    toast.success("Task deleted");
                  },
                );
            }}
          />
        ) : null}
      </AnimatePresence>
      {taskId !== undefined && detailQuery.state._tag === "error" ? (
        <div className="fixed inset-y-0 right-0 z-30 grid w-[min(520px,72vw)] place-items-center border-l bg-card p-8 text-center">
          <div>
            <h2 className="text-sm font-semibold">Task unavailable</h2>
            <p className="mt-2 text-xs text-muted-foreground">{detailQuery.state.error.message}</p>
            <Button className="mt-4" variant="outline" size="sm" onClick={closeTask}>
              Close
            </Button>
          </div>
        </div>
      ) : null}

      <Dialog open={createTaskOpen} onOpenChange={setCreateTaskOpen} title="Create task">
        <TaskForm
          projects={projects}
          labels={labels}
          initialProjectId={projectId}
          submitLabel="Create task"
          pending={pending}
          onSubmit={(input) =>
            mutation(
              Effect.flatMap(ApiClient, (api) => api.tasks.create(input)),
              (task) => {
                setCreateTaskOpen(false);
                tasksQuery.refresh();
                openTask(task);
                toast.success(`${task.identifier} created`);
              },
            )
          }
        />
      </Dialog>
      <ProjectDialog
        value={projectDialog}
        pending={pending}
        onOpenChange={(open) => {
          if (!open) setProjectDialog(undefined);
        }}
        onSubmit={(input) => {
          const effect =
            projectDialog?.mode === "edit"
              ? Effect.flatMap(ApiClient, (api) =>
                  api.projects.update(projectDialog.project.id, input),
                )
              : Effect.flatMap(ApiClient, (api) => api.projects.create(input));
          mutation(effect, () => {
            setProjectDialog(undefined);
            projectsQuery.refresh();
            tasksQuery.refresh();
            toast.success("Project saved");
          });
        }}
        onDelete={
          projectDialog?.mode === "edit"
            ? () => {
                const project = projectDialog.project;
                if (
                  !window.confirm(
                    `Delete ${project.name} and all of its tasks? This cannot be undone.`,
                  )
                )
                  return;
                mutation(
                  Effect.flatMap(ApiClient, (api) => api.projects.remove(project.id, true)),
                  () => {
                    setProjectDialog(undefined);
                    projectsQuery.refresh();
                    tasksQuery.refresh();
                    if (projectId === project.id) navigate("/tasks");
                    toast.success("Project deleted");
                  },
                );
              }
            : undefined
        }
      />
      <LabelDialog
        value={labelDialog}
        pending={pending}
        onOpenChange={(open) => {
          if (!open) setLabelDialog(undefined);
        }}
        onSubmit={(input) => {
          const effect =
            labelDialog?.mode === "edit"
              ? Effect.flatMap(ApiClient, (api) => api.labels.update(labelDialog.label.id, input))
              : Effect.flatMap(ApiClient, (api) => api.labels.create(input));
          mutation(effect, () => {
            setLabelDialog(undefined);
            labelsQuery.refresh();
            tasksQuery.refresh();
            toast.success("Label saved");
          });
        }}
        onDelete={
          labelDialog?.mode === "edit"
            ? () =>
                mutation(
                  Effect.flatMap(ApiClient, (api) => api.labels.remove(labelDialog.label.id)),
                  () => {
                    setLabelDialog(undefined);
                    labelsQuery.refresh();
                    tasksQuery.refresh();
                    toast.success("Label deleted");
                  },
                )
            : undefined
        }
      />
      <Toaster theme="dark" position="bottom-right" />
    </div>
  );
}

function Sidebar({
  projects,
  labels,
  activePath,
  labelFilters,
  onNavigate,
  onNewProject,
  onEditProject,
  onNewLabel,
  onEditLabel,
  onToggleLabel,
}: {
  readonly projects: ReadonlyArray<Project>;
  readonly labels: ReadonlyArray<Label>;
  readonly activePath: string;
  readonly labelFilters: ReadonlyArray<string>;
  readonly onNavigate: (path: string) => void;
  readonly onNewProject: () => void;
  readonly onEditProject: (project: Project) => void;
  readonly onNewLabel: () => void;
  readonly onEditLabel: (label: Label) => void;
  readonly onToggleLabel: (id: string) => void;
}) {
  const views = [
    { path: "/tasks", label: "All tasks", icon: Layers3 },
    { path: "/tasks/backlog", label: "Backlog", icon: Archive },
    { path: "/tasks/active", label: "Active", icon: CircleDot },
    { path: "/tasks/completed", label: "Completed", icon: CheckCircle2 },
  ];
  return (
    <aside className="hidden w-[228px] shrink-0 flex-col border-r bg-background lg:flex">
      <div className="flex h-12 items-center gap-2.5 px-3">
        <div className="grid size-7 place-items-center rounded-md bg-primary text-xs font-bold text-primary-foreground">
          D
        </div>
        <span className="text-sm font-semibold tracking-tight">Dispatch</span>
      </div>
      <nav className="flex flex-col gap-0.5 px-2">
        {views.map((view) => {
          const Icon = view.icon;
          return (
            <button
              key={view.path}
              type="button"
              onClick={() => onNavigate(view.path)}
              className={cn(
                "flex h-8 items-center gap-2 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground",
                activePath === view.path && "bg-accent text-foreground",
              )}
            >
              <Icon className="size-3.5" />
              {view.label}
            </button>
          );
        })}
      </nav>
      <SidebarSection title="Projects" onAdd={onNewProject}>
        {projects.map((project) => (
          <div key={project.id} className="group flex items-center">
            <button
              type="button"
              onClick={() => onNavigate(`/tasks/projects/${project.id}`)}
              className={cn(
                "flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground",
                activePath === `/tasks/projects/${project.id}` && "bg-accent text-foreground",
              )}
            >
              <span className="size-2 rounded-sm" style={{ backgroundColor: project.color }} />
              <span className="truncate">{project.name}</span>
            </button>
            <button
              type="button"
              aria-label={`Edit ${project.name}`}
              onClick={() => onEditProject(project)}
              className="invisible px-1 text-muted-foreground group-hover:visible"
            >
              <Hash className="size-3" />
            </button>
          </div>
        ))}
      </SidebarSection>
      <SidebarSection title="Labels" onAdd={onNewLabel}>
        {labels.map((label) => (
          <div key={label.id} className="group flex items-center">
            <button
              type="button"
              onClick={() => onToggleLabel(label.id)}
              className={cn(
                "flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground",
                labelFilters.includes(label.id) && "bg-accent text-foreground",
              )}
            >
              <Tag className="size-3" style={{ color: label.color }} />
              <span className="truncate">{label.name}</span>
            </button>
            <button
              type="button"
              aria-label={`Edit ${label.name}`}
              onClick={() => onEditLabel(label)}
              className="invisible px-1 text-muted-foreground group-hover:visible"
            >
              <Hash className="size-3" />
            </button>
          </div>
        ))}
      </SidebarSection>
    </aside>
  );
}

function SidebarSection({
  title,
  onAdd,
  children,
}: {
  readonly title: string;
  readonly onAdd: () => void;
  readonly children: ReactNode;
}) {
  return (
    <section className="mt-5 px-2">
      <header className="mb-1 flex h-6 items-center justify-between px-2">
        <h2 className="text-[11px] font-medium text-muted-foreground">{title}</h2>
        <button
          type="button"
          aria-label={`Add ${title.toLowerCase()}`}
          onClick={onAdd}
          className="text-muted-foreground hover:text-foreground"
        >
          <Plus className="size-3.5" />
        </button>
      </header>
      {children}
    </section>
  );
}

function ProjectDialog({
  value,
  pending,
  onOpenChange,
  onSubmit,
  onDelete,
}: {
  readonly value?:
    | { readonly mode: "create" }
    | { readonly mode: "edit"; readonly project: Project }
    | undefined;
  readonly pending: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (input: {
    readonly name: string;
    readonly key: string;
    readonly description: string;
    readonly color: string;
  }) => void;
  readonly onDelete?: (() => void) | undefined;
}) {
  const project = value?.mode === "edit" ? value.project : undefined;
  return (
    <Dialog
      open={value !== undefined}
      onOpenChange={onOpenChange}
      title={project === undefined ? "New project" : "Edit project"}
      description="Projects group related tasks and own their identifiers."
    >
      <form
        className="mt-5 flex flex-col gap-4"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          onSubmit({
            name: String(data.get("name")),
            key: String(data.get("key")),
            description: String(data.get("description")),
            color: String(data.get("color")),
          });
        }}
      >
        <div className="grid grid-cols-[1fr_100px] gap-3">
          <Field label="Name">
            <Input name="name" required defaultValue={project?.name} />
          </Field>
          <Field label="Key">
            <Input
              name="key"
              required
              minLength={2}
              maxLength={8}
              defaultValue={project?.key}
              className="uppercase"
            />
          </Field>
        </div>
        <Field label="Description">
          <Textarea name="description" defaultValue={project?.description} />
        </Field>
        <Field label="Color">
          <Input name="color" type="color" defaultValue={project?.color ?? "#8b5cf6"} />
        </Field>
        <div className="flex justify-between">
          {onDelete === undefined ? (
            <span />
          ) : (
            <Button type="button" variant="ghost" onClick={onDelete}>
              <Trash2 data-icon="inline-start" />
              Delete
            </Button>
          )}
          <Button disabled={pending}>Save project</Button>
        </div>
      </form>
    </Dialog>
  );
}

function LabelDialog({
  value,
  pending,
  onOpenChange,
  onSubmit,
  onDelete,
}: {
  readonly value?:
    | { readonly mode: "create" }
    | { readonly mode: "edit"; readonly label: Label }
    | undefined;
  readonly pending: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (input: { readonly name: string; readonly color: string }) => void;
  readonly onDelete?: (() => void) | undefined;
}) {
  const label = value?.mode === "edit" ? value.label : undefined;
  return (
    <Dialog
      open={value !== undefined}
      onOpenChange={onOpenChange}
      title={label === undefined ? "New label" : "Edit label"}
    >
      <form
        className="mt-5 flex flex-col gap-4"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          onSubmit({ name: String(data.get("name")), color: String(data.get("color")) });
        }}
      >
        <Field label="Name">
          <Input name="name" required defaultValue={label?.name} />
        </Field>
        <Field label="Color">
          <Input name="color" type="color" defaultValue={label?.color ?? "#71717a"} />
        </Field>
        <div className="flex justify-between">
          {onDelete === undefined ? (
            <span />
          ) : (
            <Button type="button" variant="ghost" onClick={onDelete}>
              <Trash2 data-icon="inline-start" />
              Delete
            </Button>
          )}
          <Button disabled={pending}>Save label</Button>
        </div>
      </form>
    </Dialog>
  );
}

export function App() {
  return (
    <MotionConfig reducedMotion="user">
      <Routes>
        <Route path="/" element={<Navigate to="/tasks" replace />} />
        <Route path="/tasks" element={<Workspace />} />
        <Route path="/tasks/:taskId" element={<Workspace />} />
        <Route path="/tasks/projects/:projectId" element={<Workspace />} />
        <Route path="*" element={<Navigate to="/tasks" replace />} />
      </Routes>
    </MotionConfig>
  );
}
