import { Context, Data, Effect, Layer, Schema } from "effect";

export const StatusSchema = Schema.Literal("backlog", "todo", "in_progress", "done", "canceled");
export type TaskStatus = typeof StatusSchema.Type;
export const PrioritySchema = Schema.Literal("no_priority", "urgent", "high", "medium", "low");
export type TaskPriority = typeof PrioritySchema.Type;

export const LabelSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  color: Schema.String,
  createdAt: Schema.String,
});
export type Label = typeof LabelSchema.Type;
export const ProjectSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  key: Schema.String,
  description: Schema.String,
  color: Schema.String,
  nextTaskNumber: Schema.Number,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type Project = typeof ProjectSchema.Type;
export const TaskSchema = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  taskNumber: Schema.Number,
  identifier: Schema.String,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  status: StatusSchema,
  priority: PrioritySchema,
  dueDate: Schema.NullOr(Schema.String),
  sortOrder: Schema.Number,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  completedAt: Schema.NullOr(Schema.String),
  project: ProjectSchema,
  labels: Schema.Array(LabelSchema),
});
export type Task = typeof TaskSchema.Type;

export class ApiError extends Data.TaggedError("ApiError")<{
  readonly code: string;
  readonly message: string;
  readonly status?: number;
  readonly cause?: unknown;
}> {}

const apiBaseUrl = import.meta.env.VITE_API_URL ?? "";

function request<A, I>(
  path: string,
  schema: Schema.Schema<A, I>,
  init?: RequestInit,
): Effect.Effect<A, ApiError> {
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(`${apiBaseUrl}${path}`, {
          ...init,
          signal,
          headers: { "content-type": "application/json", ...init?.headers },
        }),
      catch: (cause) =>
        new ApiError({
          code: "NETWORK_ERROR",
          message: "Could not reach Dispatch. Check that the server is running.",
          cause,
        }),
    });
    const payload: unknown = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: (cause) =>
        new ApiError({
          code: "INVALID_JSON",
          message: "Dispatch returned an unreadable response.",
          status: response.status,
          cause,
        }),
    });
    if (!response.ok) {
      const error =
        typeof payload === "object" &&
        payload !== null &&
        "error" in payload &&
        typeof payload.error === "object" &&
        payload.error !== null
          ? payload.error
          : null;
      const code =
        error !== null && "code" in error && typeof error.code === "string"
          ? error.code
          : "API_ERROR";
      const message =
        error !== null && "message" in error && typeof error.message === "string"
          ? error.message
          : `Request failed with status ${response.status}`;
      return yield* Effect.fail(new ApiError({ code, message, status: response.status }));
    }
    const data =
      typeof payload === "object" && payload !== null && "data" in payload
        ? payload.data
        : undefined;
    return yield* Schema.decodeUnknown(schema)(data).pipe(
      Effect.mapError(
        (cause) =>
          new ApiError({
            code: "INVALID_RESPONSE",
            message: "Dispatch returned data in an unexpected format.",
            status: response.status,
            cause,
          }),
      ),
    );
  }).pipe(Effect.retry({ times: init?.method === undefined || init.method === "GET" ? 1 : 0 }));
}

export interface TaskQuery {
  readonly projectId?: string;
  readonly status?: ReadonlyArray<TaskStatus>;
  readonly priority?: ReadonlyArray<TaskPriority>;
  readonly labelId?: ReadonlyArray<string>;
  readonly search?: string;
  readonly sort?: "created" | "updated" | "priority";
  readonly order?: "asc" | "desc";
}

function queryString(query: TaskQuery): string {
  const parameters = new URLSearchParams();
  if (query.projectId !== undefined) parameters.set("projectId", query.projectId);
  for (const value of query.status ?? []) parameters.append("status", value);
  for (const value of query.priority ?? []) parameters.append("priority", value);
  for (const value of query.labelId ?? []) parameters.append("labelId", value);
  if (query.search !== undefined && query.search.length > 0) parameters.set("search", query.search);
  if (query.sort !== undefined) parameters.set("sort", query.sort);
  if (query.order !== undefined) parameters.set("order", query.order);
  const value = parameters.toString();
  return value.length === 0 ? "" : `?${value}`;
}

const body = (value: unknown): RequestInit => ({ body: JSON.stringify(value) });

export class ApiClient extends Context.Tag("@pideck/tasks-client/ApiClient")<
  ApiClient,
  {
    readonly projects: {
      readonly list: Effect.Effect<ReadonlyArray<Project>, ApiError>;
      readonly create: (input: {
        readonly name: string;
        readonly key: string;
        readonly description?: string;
        readonly color?: string;
      }) => Effect.Effect<Project, ApiError>;
      readonly update: (
        id: string,
        input: Partial<Pick<Project, "name" | "key" | "description" | "color">>,
      ) => Effect.Effect<Project, ApiError>;
      readonly remove: (id: string, cascade?: boolean) => Effect.Effect<null, ApiError>;
    };
    readonly labels: {
      readonly list: Effect.Effect<ReadonlyArray<Label>, ApiError>;
      readonly create: (input: {
        readonly name: string;
        readonly color?: string;
      }) => Effect.Effect<Label, ApiError>;
      readonly update: (
        id: string,
        input: Partial<Pick<Label, "name" | "color">>,
      ) => Effect.Effect<Label, ApiError>;
      readonly remove: (id: string) => Effect.Effect<null, ApiError>;
    };
    readonly tasks: {
      readonly list: (query: TaskQuery) => Effect.Effect<ReadonlyArray<Task>, ApiError>;
      readonly get: (id: string) => Effect.Effect<Task, ApiError>;
      readonly create: (input: TaskCreateInput) => Effect.Effect<Task, ApiError>;
      readonly update: (id: string, input: TaskUpdateInput) => Effect.Effect<Task, ApiError>;
      readonly remove: (id: string) => Effect.Effect<null, ApiError>;
    };
  }
>() {}

export interface TaskCreateInput {
  readonly projectId: string;
  readonly title: string;
  readonly description?: string | null;
  readonly status?: TaskStatus;
  readonly priority?: TaskPriority;
  readonly dueDate?: string | null;
  readonly labelIds?: ReadonlyArray<string>;
}
export type TaskUpdateInput = Partial<TaskCreateInput> & { readonly sortOrder?: number };

export const ApiClientLive = Layer.succeed(ApiClient, {
  projects: {
    list: request("/tasks/api/projects", Schema.Array(ProjectSchema)),
    create: (input) => request("/tasks/api/projects", ProjectSchema, { method: "POST", ...body(input) }),
    update: (id, input) =>
      request(`/tasks/api/projects/${id}`, ProjectSchema, { method: "PATCH", ...body(input) }),
    remove: (id, cascade = false) =>
      request(`/tasks/api/projects/${id}${cascade ? "?cascade=true" : ""}`, Schema.Null, {
        method: "DELETE",
      }),
  },
  labels: {
    list: request("/tasks/api/labels", Schema.Array(LabelSchema)),
    create: (input) => request("/tasks/api/labels", LabelSchema, { method: "POST", ...body(input) }),
    update: (id, input) =>
      request(`/tasks/api/labels/${id}`, LabelSchema, { method: "PATCH", ...body(input) }),
    remove: (id) => request(`/tasks/api/labels/${id}`, Schema.Null, { method: "DELETE" }),
  },
  tasks: {
    list: (query) => request(`/tasks/api/tasks${queryString(query)}`, Schema.Array(TaskSchema)),
    get: (id) => request(`/tasks/api/tasks/${id}`, TaskSchema),
    create: (input) => request("/tasks/api/tasks", TaskSchema, { method: "POST", ...body(input) }),
    update: (id, input) =>
      request(`/tasks/api/tasks/${id}`, TaskSchema, { method: "PATCH", ...body(input) }),
    remove: (id) => request(`/tasks/api/tasks/${id}`, Schema.Null, { method: "DELETE" }),
  },
});
