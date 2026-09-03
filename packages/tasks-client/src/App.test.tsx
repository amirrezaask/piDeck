import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "@tasks/App";

const project = {
  id: "p1",
  name: "Dispatch",
  key: "DSP",
  description: "",
  color: "#8b5cf6",
  nextTaskNumber: 2,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const label = { id: "l1", name: "Bug", color: "#ef4444", createdAt: "2026-01-01T00:00:00.000Z" };
const baseTask = {
  id: "t1",
  projectId: "p1",
  taskNumber: 1,
  identifier: "DSP-1",
  title: "Polish task list",
  description: "Keep it dense",
  status: "todo",
  priority: "high",
  dueDate: null,
  sortOrder: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  completedAt: null,
  project,
  labels: [label],
};

function response(data: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(status >= 400 ? { error: data } : { data }), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function installApi(
  options: { readonly taskError?: boolean; readonly pendingTasks?: boolean } = {},
) {
  let task = { ...baseTask };
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
    (input, init) => {
      const url = String(input);
      if (url.includes("/api/projects")) return response([project]);
      if (url.includes("/api/labels")) return response([label]);
      if (url.endsWith("/api/tasks") && init?.method === "POST") {
        const body: unknown = JSON.parse(String(init.body));
        const title =
          typeof body === "object" && body !== null && "title" in body
            ? String(body.title)
            : "Created task";
        task = { ...task, id: "t2", identifier: "DSP-2", taskNumber: 2, title };
        return response(task);
      }
      if (url.includes("/api/tasks/t1") && init?.method === "PATCH") {
        const body: unknown = JSON.parse(String(init.body));
        if (typeof body === "object" && body !== null) task = { ...task, ...body };
        return response(task);
      }
      if (url.includes("/api/tasks/") && init?.method === undefined) return response(task);
      if (url.includes("/api/tasks")) {
        if (options.pendingTasks) return new Promise<Response>(() => undefined);
        if (options.taskError)
          return response(
            {
              code: "DATABASE_ERROR",
              message: "Database is temporarily unavailable",
              details: null,
            },
            500,
          );
        return response([task]);
      }
      return response({ code: "NOT_FOUND", message: "Not found" }, 404);
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderApp(path = "/tasks") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Dispatch workspace", () => {
  it("renders loading and task list states", async () => {
    installApi({ pendingTasks: true });
    renderApp();
    expect(screen.getByLabelText("Loading tasks")).toBeInTheDocument();
    cleanup();
    installApi();
    renderApp();
    expect(await screen.findByText("Polish task list")).toBeInTheDocument();
    expect(screen.getByText("DSP-1")).toBeInTheDocument();
  });

  it("shows a recoverable API error", async () => {
    installApi({ taskError: true });
    renderApp();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Database is temporarily unavailable",
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("validates and creates a task", async () => {
    installApi();
    const user = userEvent.setup();
    renderApp();
    await screen.findByText("Polish task list");
    await user.click(screen.getByRole("button", { name: /New task/ }));
    await user.click(screen.getByRole("button", { name: "Create task" }));
    expect(screen.getByText("Enter a task title.")).toBeInTheDocument();
    await user.type(
      screen.getByPlaceholderText("What needs doing? Type / for details"),
      "New keyboard flow",
    );
    await user.click(screen.getByRole("button", { name: "Create task" }));
    expect(await screen.findByText("DSP-2")).toBeInTheDocument();
  });

  it("attaches metadata through slash commands", async () => {
    const fetchMock = installApi();
    const user = userEvent.setup();
    renderApp();
    await screen.findByText("Polish task list");
    await user.click(screen.getByRole("button", { name: /New task/ }));
    const composer = screen.getByLabelText("Task");

    await user.type(composer, "Ship release /due");
    await user.keyboard("{Enter}");
    fireEvent.change(screen.getByLabelText("Task due date"), {
      target: { value: "2026-02-14" },
    });
    await user.click(screen.getByRole("button", { name: "Attach" }));

    await user.click(composer);
    await user.type(composer, "/priority");
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("menuitemradio", { name: "High" }));
    await user.click(screen.getByRole("button", { name: "Create task" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/tasks"),
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining('"dueDate":"2026-02-14"'),
        }),
      ),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/tasks"),
      expect.objectContaining({ body: expect.stringContaining('"priority":"high"') }),
    );
  });

  it("serializes filters into API requests", async () => {
    const fetchMock = installApi();
    const user = userEvent.setup();
    renderApp();
    await screen.findByText("Polish task list");
    await user.selectOptions(screen.getByLabelText("Filter by priority"), "high");
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("priority=high"))).toBe(
        true,
      ),
    );
  });

  it("keeps project routes out of task detail resolution", async () => {
    const fetchMock = installApi();
    renderApp("/tasks/projects/p1");
    await screen.findByText("Polish task list");
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("/api/tasks/projects/p1")),
    ).toBe(false);
  });

  it("opens and edits task details", async () => {
    installApi();
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByText("Polish task list"));
    const title = await screen.findByLabelText("Task title");
    await user.clear(title);
    await user.type(title, "Polished task list");
    fireEvent.blur(title);
    await waitFor(() =>
      expect(screen.getByLabelText("Task title")).toHaveValue("Polished task list"),
    );
    await user.click(screen.getByLabelText("Task status"));
    await user.click(screen.getByRole("option", { name: "In progress" }));
    await waitFor(() => expect(screen.getByLabelText("Task status")).toHaveTextContent("In progress"));
  });

  it("guards keyboard shortcuts while typing", async () => {
    installApi();
    const user = userEvent.setup();
    renderApp();
    const search = await screen.findByLabelText("Search tasks");
    await user.click(search);
    await user.keyboard("c");
    expect(screen.queryByRole("dialog", { name: "Create task" })).not.toBeInTheDocument();
    search.blur();
    await user.keyboard("c");
    expect(await screen.findByRole("dialog", { name: "Create task" })).toBeInTheDocument();
  });
});
